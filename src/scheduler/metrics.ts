/**
 * Scheduler metrics — Card #145 (5.2a) F5.
 *
 * Counters e gauges in-memory para observability do scheduler. Sem
 * dependência externa (sem prom-client/Prometheus) — segue padrão do
 * projeto: dados estruturados consumidos via `getSchedulerMetrics()`
 * + endpoint admin `GET /admin/jobs/list` + logs estruturados pino
 * → Sentry breadcrumbs.
 *
 * **Métricas expostas (Card #145 F5 — T5.1):**
 *  - `cron_runs_total{job,status}` — Counter de runs por (jobName, status).
 *    Status whitelist: success | failure | skipped | expired.
 *  - `cron_lock_contention_total{job}` — Counter de skips por
 *    `lock_not_acquired` (sinal de concorrência multi-instância).
 *  - `cron_lock_expired_total{job}` — Counter de releases pós-TTL
 *    (R-8 do plano — handler lento + heartbeat falhou).
 *  - `cron_duration_ms_last{job}` — Gauge da última duração com sucesso.
 *  - `tablix_retention_days_current` — Gauge fixo (env.PRO_RETENTION_DAYS).
 *
 * **Por que NÃO Prometheus:**
 *  - Adicionar `prom-client` é dep nova (~250KB transitive). CLAUDE.md
 *    exige discussão de justificativa. Pré-go-live, padrão Tablix é
 *    logs estruturados + Sentry — não há scraper Prometheus configurado.
 *  - Sentry consome via `captureMessage` + `addBreadcrumb` em
 *    `observability.ts`. Migração futura pra `/metrics` Prometheus é
 *    trivial (registry separado, mesmos counters).
 *
 * **Cardinality cap:** counters por jobName são bounded pelo registry
 * (jobs registrados no boot). Não há label de user/id arbitrário.
 *
 * @owner: @devops + @planner
 * @card: #145 (5.2a) F5
 */
import { env } from '../config/env'

// ============================================
// TIPOS
// ============================================

/**
 * Status terminal dos counters de runs. Espelha `JobRunMeta.status`
 * exceto `running` (não-terminal). Whitelist explícita previne label
 * cardinality explosion por bug do caller.
 */
export type RunStatusLabel = 'success' | 'failure' | 'skipped' | 'expired'

/**
 * Snapshot agregado dos counters/gauges. Stable shape — qualquer
 * mudança aqui é breaking change pro dashboard admin (DTO via
 * `scheduler/health.ts`).
 */
export interface SchedulerMetricsSnapshot {
  /** Total de runs por (jobName, status). */
  runsTotal: Array<{
    jobName: string
    status: RunStatusLabel
    count: number
  }>

  /** Total de skips por `lock_not_acquired` por jobName. */
  lockContentionTotal: Array<{
    jobName: string
    count: number
  }>

  /** Total de releases pós-TTL (lock expirou antes do release) por jobName. */
  lockExpiredTotal: Array<{
    jobName: string
    count: number
  }>

  /** Última duração com sucesso por jobName (ms). `null` se nenhum success ainda. */
  lastDurationMs: Array<{
    jobName: string
    durationMs: number
  }>

  /** Gauge fixo derivado de env.PRO_RETENTION_DAYS no boot. */
  retentionDaysCurrent: number

  /**
   * Gauge de rows pendentes de purga (`file_history` com `deletedAt NOT NULL
   * AND purge_attempts < 5`). Atualizado ao final de cada execução do cron
   * `history-purge` (Card #146 F3). `lastUpdatedAt` permite detectar stale
   * gauge (operador olha snapshot e vê que último update foi há > 25h —
   * sinal de cron parado).
   *
   * Card #146 F2 (T-2.2).
   */
  purgePendingCount: Array<{
    jobName: string
    count: number
    lastUpdatedAt: string
  }>
}

// ============================================
// STATE (in-memory, scoped por process)
// ============================================

/**
 * `Map<jobName, Map<status, count>>`. Aninhado pra evitar string
 * concat de chave (anti-bug de delimitador).
 */
const runsTotal = new Map<string, Map<RunStatusLabel, number>>()
const lockContentionTotal = new Map<string, number>()
const lockExpiredTotal = new Map<string, number>()
const lastDurationMs = new Map<string, number>()
const purgePendingCount = new Map<
  string,
  { count: number; lastUpdatedAt: Date }
>()

// ============================================
// INCREMENT HELPERS (call from cron.ts/lock.ts)
// ============================================

/**
 * Incrementa `cron_runs_total{job=jobName,status=status}`. Idempotente —
 * cria entrada no Map se não existe.
 */
export function incRunsTotal(jobName: string, status: RunStatusLabel): void {
  const byStatus = runsTotal.get(jobName) ?? new Map<RunStatusLabel, number>()
  byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
  runsTotal.set(jobName, byStatus)
}

/**
 * Incrementa `cron_lock_contention_total{job=jobName}`. Chamado quando
 * `acquireLock` retorna null por outro worker deter o lock (NÃO quando
 * Redis está offline — esse caso é `redis_unavailable`).
 */
export function incLockContention(jobName: string): void {
  lockContentionTotal.set(jobName, (lockContentionTotal.get(jobName) ?? 0) + 1)
}

/**
 * Incrementa `cron_lock_expired_total{job=jobName}`. Chamado quando o
 * release CAS retorna 0 (lock já tinha expirado pelo TTL antes do
 * release rodar — sinal de handler lento + heartbeat falhou).
 */
export function incLockExpired(jobName: string): void {
  lockExpiredTotal.set(jobName, (lockExpiredTotal.get(jobName) ?? 0) + 1)
}

/**
 * Atualiza `cron_duration_ms_last{job=jobName}` com a duração da última
 * execução com sucesso. Chamado no caminho `status === 'success'` do
 * runner. `expired`/`failure` NÃO atualizam (gauge mede saúde do happy
 * path; failure case é melhor visto via runs_total).
 */
export function setLastDurationMs(jobName: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  lastDurationMs.set(jobName, Math.floor(durationMs))
}

/**
 * Atualiza `file_history_purge_pending_count{job=jobName}` com count atual
 * de rows pendentes de purga. Chamado ao final da execução do cron de
 * purga (Card #146 F3) após reconciliação + dead-letter.
 *
 * `lastUpdatedAt` é seteado pra `new Date()` em cada chamada — permite ao
 * snapshot reportar idade do gauge (stale gauge > 25h = cron parado).
 *
 * Rejeita NaN/negativo (mesma defesa do `setLastDurationMs`).
 */
export function setPurgePendingCount(jobName: string, count: number): void {
  if (!Number.isFinite(count) || count < 0) return
  purgePendingCount.set(jobName, {
    count: Math.floor(count),
    lastUpdatedAt: new Date(),
  })
}

// ============================================
// SNAPSHOT (read-only)
// ============================================

/**
 * Snapshot atual de todos os counters/gauges. Stable shape — leitura
 * O(jobs). Não muta estado. Usado por `scheduler/health.ts` no DTO
 * do `GET /admin/jobs/list`.
 */
export function getSchedulerMetrics(): SchedulerMetricsSnapshot {
  const runsList: SchedulerMetricsSnapshot['runsTotal'] = []
  for (const [jobName, byStatus] of runsTotal.entries()) {
    for (const [status, count] of byStatus.entries()) {
      runsList.push({ jobName, status, count })
    }
  }

  const lockContentionList: SchedulerMetricsSnapshot['lockContentionTotal'] =
    Array.from(lockContentionTotal.entries()).map(([jobName, count]) => ({
      jobName,
      count,
    }))

  const lockExpiredList: SchedulerMetricsSnapshot['lockExpiredTotal'] =
    Array.from(lockExpiredTotal.entries()).map(([jobName, count]) => ({
      jobName,
      count,
    }))

  const durationList: SchedulerMetricsSnapshot['lastDurationMs'] = Array.from(
    lastDurationMs.entries(),
  ).map(([jobName, durationMs]) => ({ jobName, durationMs }))

  const purgePendingList: SchedulerMetricsSnapshot['purgePendingCount'] =
    Array.from(purgePendingCount.entries()).map(([jobName, entry]) => ({
      jobName,
      count: entry.count,
      lastUpdatedAt: entry.lastUpdatedAt.toISOString(),
    }))

  return {
    runsTotal: runsList,
    lockContentionTotal: lockContentionList,
    lockExpiredTotal: lockExpiredList,
    lastDurationMs: durationList,
    retentionDaysCurrent: env.PRO_RETENTION_DAYS,
    purgePendingCount: purgePendingList,
  }
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  runsTotal,
  lockContentionTotal,
  lockExpiredTotal,
  lastDurationMs,
  purgePendingCount,
  resetForTests: () => {
    runsTotal.clear()
    lockContentionTotal.clear()
    lockExpiredTotal.clear()
    lastDurationMs.clear()
    purgePendingCount.clear()
  },
}
