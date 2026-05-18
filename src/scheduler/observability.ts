/**
 * Scheduler observability — Card #145 (5.2a) F5.
 *
 * Helper unificado para emitir eventos do scheduler em DUAS camadas:
 *  1. **Logger pino estruturado** (sempre) — consumível por log
 *     aggregation. Já passa por REDACT_PATHS (SSOT do Card 2.1).
 *  2. **Sentry breadcrumb** (sempre) — contexto pra issues futuras
 *     no mesmo trace; cardinalidade controlada (maxBreadcrumbs=50
 *     em sentry.ts).
 *  3. **Sentry captureMessage** (apenas para `warning`/`error`) —
 *     dispara issue. Atributos `event` + `jobName` ficam em tags
 *     pra dashboard agrupar.
 *
 * **Eventos do scheduler (whitelist):**
 *  - `cron.run.success` (info)
 *  - `cron.run.failure` (error → captureException pelo caller)
 *  - `cron.run.expired` (warning) — lock perdido durante handler
 *  - `cron.run.skipped.*` (info — feature_disabled/test_env não alertam)
 *  - `cron.run.skipped.lock_not_acquired` (info — esperado em multi-instance)
 *  - `cron.lock.acquired` (info)
 *  - `cron.lock.released` (info)
 *  - `cron.lock.expired_without_release` (warning) — R-8 alerta
 *  - `cron.lock.heartbeat_lost` (warning) — split-brain detectado
 *  - `cron.lock.heartbeat_failed` (error) — Redis script error
 *  - `cron.run.inflight_cap_exceeded` (error) — bug de cadência
 *
 * **Por que helper dedicado (e não usar `Sentry.captureMessage` direto):**
 *  - Garante PAR log + Sentry em todo ponto crítico. Sem isso, dev
 *    futuro adiciona `logger.warn` sem `captureMessage` (gap silencioso
 *    em alerta) ou vice-versa (dashboard sem contexto).
 *  - Tags estruturadas (`jobName`, `event`) pra search query no Sentry.
 *  - Single source of truth pra documentar TODAS as alertas do
 *    scheduler (Sentry rules em `docs/runbooks/cron-stuck.md`).
 *
 * @owner: @devops + @security
 * @card: #145 (5.2a) F5
 */
import { Sentry } from '../config/sentry'
import { logger } from '../lib/logger'

// ============================================
// TIPOS
// ============================================

export type SchedulerEventLevel = 'info' | 'warning' | 'error'

/**
 * Whitelist de event names. Mudar = breaking pra search queries
 * configuradas no Sentry. Adicionar é não-breaking; remover/renomear
 * exige update do runbook + alertas correspondentes.
 */
export type SchedulerEventName =
  | 'cron.run.success'
  | 'cron.run.failure'
  | 'cron.run.expired'
  | 'cron.run.skipped.feature_disabled'
  | 'cron.run.skipped.test_env'
  | 'cron.run.skipped.lock_not_acquired'
  | 'cron.run.inflight_cap_exceeded'
  | 'cron.lock.acquired'
  | 'cron.lock.released'
  | 'cron.lock.not_acquired'
  | 'cron.lock.redis_unavailable'
  | 'cron.lock.expired_without_release'
  | 'cron.lock.release_failed'
  | 'cron.lock.heartbeat_ok'
  | 'cron.lock.heartbeat_lost'
  | 'cron.lock.heartbeat_failed'
  | 'cron.heartbeat.unexpected_error'
  // Card #146 F2 (T-2.3): eventos do cron de purga LGPD. dead_letter e
  // pending_overdue são ALERTABLE; dry_run.start é info (não polui Sentry
  // com dry-run intencional).
  | 'cron.purge.dead_letter'
  | 'cron.purge.pending_overdue'
  | 'cron.purge.dry_run.start'

interface EmitArgs {
  level: SchedulerEventLevel
  event: SchedulerEventName
  jobName: string
  /**
   * Contexto adicional. NÃO incluir secrets (token de lock cru, err.message
   * sem sanitizar). REDACT_PATHS do logger pino cobre paths conhecidos,
   * mas helpers do scheduler já passam errCode/errMessage sanitizados.
   */
  context?: Record<string, unknown>
}

/**
 * Conjunto de eventos que viram `captureMessage` no Sentry (dispara
 * issue). `info`-level apenas vira breadcrumb (contexto, não alerta).
 *
 * `error`-level fora dessa lista é coberto por `captureException`
 * direto pelo caller quando há objeto `Error` disponível (preserva
 * stack + tipo).
 */
const ALERTABLE_EVENTS: ReadonlySet<SchedulerEventName> = new Set([
  'cron.run.failure',
  'cron.run.expired',
  'cron.run.inflight_cap_exceeded',
  'cron.lock.redis_unavailable',
  'cron.lock.expired_without_release',
  'cron.lock.release_failed',
  'cron.lock.heartbeat_lost',
  'cron.lock.heartbeat_failed',
  'cron.heartbeat.unexpected_error',
  // Card #146 F2 (T-2.3): eventos do cron de purga LGPD.
  // dead_letter = row ficou stuck após 5 tentativas → on-call investigar.
  // pending_overdue = gauge purge_pending > threshold OU stale > 2h → bug.
  'cron.purge.dead_letter',
  'cron.purge.pending_overdue',
])

/**
 * Tamanho máximo do `context` serializado em bytes. Defesa em profundidade
 * contra caller futuro que passe payload gigante (batch result, Buffer,
 * objeto circular indireto). REDACT_PATHS do logger + scrubObject do
 * Sentry cobrem PII por nome de campo, mas NÃO limitam tamanho.
 *
 * 4KB é folga suficiente pros contexts atuais (~100 bytes) sem permitir
 * leak de payload acidental em log/Sentry.
 */
const CONTEXT_MAX_BYTES = 4096

// ============================================
// EMIT
// ============================================

/**
 * Emite evento estruturado do scheduler em log + Sentry breadcrumb +
 * (opcional) Sentry captureMessage.
 *
 * @example
 * emitSchedulerEvent({
 *   level: 'warning',
 *   event: 'cron.lock.heartbeat_lost',
 *   jobName: 'history-purge',
 *   context: { runId, token: '[REDACTED]' },
 * })
 */
export function emitSchedulerEvent(args: EmitArgs): void {
  const { level, event, jobName, context: rawContext = {} } = args
  const context = capContextSize(rawContext, jobName, event)
  const fullContext = { ...context, jobName, event }

  // (1) Logger pino — sempre. REDACT_PATHS aplica defesa em profundidade.
  if (level === 'info') {
    logger.info(fullContext, event)
  } else if (level === 'warning') {
    logger.warn(fullContext, event)
  } else {
    logger.error(fullContext, event)
  }

  // (2) Sentry breadcrumb — sempre. Contexto pra issues futuras no mesmo
  // trace request. beforeBreadcrumb (sentry.ts) já scruba PII.
  Sentry.addBreadcrumb({
    category: 'scheduler',
    level:
      level === 'warning' ? 'warning' : level === 'error' ? 'error' : 'info',
    message: event,
    data: {
      jobName,
      ...context,
    },
  })

  // (3) Sentry captureMessage — apenas eventos alertáveis. Tags
  // estruturadas pra search query no dashboard.
  if (ALERTABLE_EVENTS.has(event)) {
    Sentry.captureMessage(event, {
      level: level === 'warning' ? 'warning' : 'error',
      tags: {
        scheduler_event: event,
        scheduler_job: jobName,
      },
      extra: context,
    })
  }
}

/**
 * Cap defensivo de tamanho do `context`. Se serialização excede
 * `CONTEXT_MAX_BYTES`, substitui por marker `[CONTEXT_OVERSIZE]` e
 * loga warning. Defesa em profundidade contra caller futuro que passe
 * payload gigante ou objeto circular (`JSON.stringify` joga TypeError
 * em circular — capturado e tratado igual oversize).
 *
 * F5 fix-pack pós-pipeline ciclo 1 (@security MÉDIO):
 * REDACT_PATHS do logger pino e scrubObject do Sentry cobrem PII por
 * nome de campo mas NÃO limitam tamanho/profundidade do `logger.info`.
 */
function capContextSize(
  context: Record<string, unknown>,
  jobName: string,
  event: string,
): Record<string, unknown> {
  let size: number
  try {
    size = JSON.stringify(context).length
  } catch {
    // Circular reference ou BigInt — trata como oversize.
    logger.warn(
      { jobName, event, reason: 'unserializable' },
      'scheduler.observability.context_truncated',
    )
    return { _truncated: true, _reason: 'unserializable' }
  }
  if (size > CONTEXT_MAX_BYTES) {
    logger.warn(
      { jobName, event, sizeBytes: size, cap: CONTEXT_MAX_BYTES },
      'scheduler.observability.context_truncated',
    )
    return { _truncated: true, _reason: 'oversize', _sizeBytes: size }
  }
  return context
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  ALERTABLE_EVENTS,
  CONTEXT_MAX_BYTES,
  capContextSize,
}
