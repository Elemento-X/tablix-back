/**
 * Scheduler types — Card #145 (5.2a) F4.
 *
 * Tipos compartilhados entre `cron.ts`, `lock.ts`, `health.ts`, `admin.routes.ts`.
 * Sem `as const` — esses são contratos cross-arquivo, mutáveis via versionamento.
 *
 * Padrões:
 *  - **CronJobDefinition** descreve um job registrável (nome, schedule, handler,
 *    lockTtl). 5.2b/c implementam handlers reais; F4 entrega skeleton.
 *  - **LockHandle** é o token de execução exclusivo (UUID v4 fencing) +
 *    helpers de release/heartbeat. Devolvido pelo `acquireLock` quando
 *    SET NX vence; `null` quando outro worker detém o lock.
 *  - **JobRunMeta** é o estado last-N-runs pra `/health` (read-only,
 *    sem segredos). Limit 10 runs por job em memória — não persiste.
 *
 * @owner: @planner + @devops
 * @card: #145 (5.2a) F4
 */

/**
 * Token de execução exclusivo via Redis SET NX PX. UUID v4 fencing
 * permite release CAS atômico (Lua: `if GET == ARGV[1] then DEL`).
 *
 * Heartbeat: chamada periódica (60s) que renova TTL do lock via Lua
 * `if GET == ARGV[1] then PEXPIRE` — preserva atomicidade contra race
 * de "outro worker ganhou e expirou agora". Retorna `false` se perdeu
 * o lock (token não bate); handler deve abortar imediatamente.
 *
 * Release: idempotente. Chamadas múltiplas são no-op (Lua DEL retorna 0
 * se key não existe ou token diferente).
 */
export interface LockHandle {
  /** UUID v4 fencing token. Único por execução do job. */
  token: string

  /** Nome do job que detém o lock. Pra logs estruturados. */
  jobName: string

  /** Timestamp de aquisição. Diferença com NOW = duração da execução. */
  acquiredAt: Date

  /**
   * Renova TTL do lock atomicamente. Retorna `true` se renovou, `false`
   * se outro worker detém o lock (token não bate). Caller deve abortar
   * em `false` — `release()` ainda é idempotente.
   */
  heartbeat: () => Promise<boolean>

  /**
   * Libera o lock atomicamente (Lua CAS). Idempotente — chamada extra
   * é no-op. Logs `cron.lock.released` ou `cron.lock.expired_without_release`
   * (R-8) se o lock já tinha expirado quando o release rodou.
   */
  release: () => Promise<void>
}

/**
 * Definição de um cron job. Registrada no boot via `registerCronJob`.
 * Handler é stateless — input vem do schedule (clock) + DB; output é
 * audit_log + metric. Errors capturadas pelo cron runner com Sentry.
 */
export interface CronJobDefinition {
  /**
   * Nome estável do job. Usado como:
   *  - chave do Redis lock (`tablix:cron:lock:<name>`)
   *  - identifier no `/health` last_cron_run
   *  - rota admin (`POST /admin/jobs/run/:name`)
   *  - métricas Prometheus (`cron_runs_total{job=name}`)
   *
   * Convenção: kebab-case `<feature>-<action>` (ex: `history-purge`).
   * Mudar = breaking change pra dashboards e alertas.
   */
  name: string

  /**
   * Cron expression (5 ou 6 campos — node-cron aceita ambos). UTC.
   * Ex: `'0 3 * * *'` (todo dia às 03:00 UTC).
   */
  schedule: string

  /**
   * Kill-switch específico do job. Default false em todos os envs até
   * 5.2b/c entregarem handlers reais. Lê de env (HISTORY_FEATURE_ENABLED,
   * CRON_PURGE_ENABLED, etc) — runtime decide se executa.
   */
  enabled: boolean

  /**
   * Handler do job. Recebe LockHandle pra heartbeat durante execução
   * longa. Lança erro = run marcado como `failure` no JobRunMeta + log
   * Sentry. Lock é liberado no finally pelo runner (não pelo handler).
   */
  handler: (lock: LockHandle) => Promise<void>

  /**
   * TTL do lock em ms. Default 15min. Heartbeat renova a cada 60s
   * enquanto handler está rodando. Override quando job demora mais
   * (ex: cron purge de 100k rows pode precisar 30min).
   */
  lockTtlMs?: number

  /**
   * **OBRIGATÓRIO** (F4 fix-pack @devops): handler deve ser idempotente.
   * Se `lockLost=true` durante execução, o runner aborta e outra instância
   * pode pegar — handler precisa garantir que retry NÃO duplica writes
   * (deletes em loop, audit_log_legal duplicado, etc).
   *
   * Estratégias aceitas (documentar em comentário do handler):
   *  - Checkpoint/marker em row (ex: `purge_attempts++` antes de mutate)
   *  - Idempotency-Key no audit_log_legal (UNIQUE constraint absorve P2002)
   *  - Lock granular por recurso (advisory lock pg adicional)
   *  - Operação naturalmente idempotente (UPDATE com WHERE deleted_at IS NULL)
   *
   * `false` exige waiver formal — runner aborta sem retry quando lockLost.
   */
  idempotent: boolean
}

/**
 * Estado de uma execução do cron job. Persistido em memória (Map) por
 * job — limit 10 runs mais recentes. Acessível via `/health` admin.
 *
 * NÃO contém payload sensível (sem PII, sem stack trace cru). `error`
 * é mensagem sanitizada (sem secret).
 */
export interface JobRunMeta {
  /** Nome do job (chave do CronJobDefinition). */
  jobName: string

  /** UUID v4 do run (mesmo do `LockHandle.token` quando lock foi adquirido). */
  runId: string

  /** Início da execução (post-acquire, pre-handler). */
  startedAt: Date

  /** Fim da execução. `null` durante execução em curso. */
  finishedAt: Date | null

  /**
   * Estado terminal. `running` durante execução; transição pra:
   *  - `success`: handler retornou sem throw
   *  - `failure`: handler throw + log Sentry
   *  - `skipped`: kill-switch off OU NODE_ENV=test OU lock NÃO adquirido
   *  - `expired`: heartbeat retornou false (lock expirou durante handler)
   */
  status: 'running' | 'success' | 'failure' | 'skipped' | 'expired'

  /** Mensagem sanitizada se `status === 'failure'` ou `'expired'`. */
  error?: string

  /** Duração em ms. `null` durante execução. */
  durationMs?: number

  /**
   * Razão do skip se `status === 'skipped'`. Whitelist:
   *  - `feature_disabled` — kill-switch off
   *  - `test_env` — NODE_ENV=test
   *  - `lock_not_acquired` — outro worker detém OU Redis offline (fail-open).
   *    A distinção fica em `event` do log scheduler (`cron.lock.redis_unavailable`
   *    vs `cron.lock.not_acquired`), não em `skipReason` do JobRunMeta —
   *    F5 fix-pack @security BAIXO removeu enum value `redis_unavailable`
   *    (era dead — runner nunca o setava).
   */
  skipReason?: 'feature_disabled' | 'test_env' | 'lock_not_acquired'
}

/**
 * Snapshot agregado pra response do `/health/ready` (admin only). Por job:
 * último run + status agregado nas últimas N runs.
 */
export interface SchedulerHealth {
  jobs: Array<{
    jobName: string
    enabled: boolean
    schedule: string
    lastRun: JobRunMeta | null
    /** Quantos runs success / total nas últimas 10. */
    successRate: number
  }>
}
