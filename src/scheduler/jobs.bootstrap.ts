/**
 * Cron jobs bootstrap — Card #146 (5.2b) F4.
 *
 * Registra todos os cron jobs do scheduler no boot do server. Chamado UMA VEZ
 * em `server.ts` antes de `app.listen` — espelha o padrão de `buildApp()`
 * (init Sentry → init Fastify → registra jobs → listen).
 *
 * **Por que não em src/app.ts**: buildApp é hard-to-test (chama app.close em
 * shutdown). Bootstrap separado permite testes unitários do registro sem
 * subir Fastify inteiro.
 *
 * **Por que NÃO disparar em NODE_ENV=test**: scheduler.registerCronJob já tem
 * guard interno (R-5 do plano #145) — chamada no test é no-op. Mas pra
 * clareza, este módulo NÃO precisa de guard adicional.
 *
 * **Lista de jobs registrados (Card #146 escopo expandido):**
 *  - `history-purge` (F3): purga two-phase LGPD daily 03:00 BRT (06:00 UTC)
 *  - `cron-runs-cleanup` (F4.5): purga cron_runs > 30d daily 04:00 BRT (07:00 UTC)
 *  - `dead-letter-reprocess` (F4.7): retry weekly Sunday 04:00 BRT
 *
 * Schedule horários escalonados (06/07 UTC) reduzem contention no DB.
 *
 * @owner: @devops + @planner
 * @card: #146 (5.2b) F4
 */
import { env } from '../config/env'
import { cronRunsCleanup } from '../jobs/cron-runs-cleanup.job'
import { deadLetterReprocess } from '../jobs/dead-letter-reprocess.job'
import { purgeExpiredFiles } from '../jobs/retention.job'
import { logger } from '../lib/logger'
import { registerCronJob } from './cron'

/**
 * Registra todos os cron jobs do scheduler. Idempotente — re-registrar
 * (improvável em prod) substitui a definição.
 *
 * Em NODE_ENV=test, `registerCronJob` é no-op (guard interno R-5).
 * Caller pode invocar sem risco em test setup.
 */
export function bootstrapCronJobs(): void {
  const historyEnabled = env.HISTORY_FEATURE_ENABLED && env.CRON_PURGE_ENABLED

  // Job 1: history-purge (Card #146 F3)
  // Schedule: 03:00 BRT (UTC-3 = '0 6 * * *' UTC) — vale de tráfego.
  registerCronJob({
    name: 'history-purge',
    schedule: '0 6 * * *', // 03:00 BRT daily
    enabled: historyEnabled,
    handler: purgeExpiredFiles,
    lockTtlMs: 15 * 60 * 1000, // 15min TTL — heartbeat 60s renova
    idempotent: true, // two-phase + reconciliação são naturalmente idempotentes
  })

  // Job 2: cron-runs-cleanup (Card #146 F4.5)
  // Schedule: 04:00 BRT = '0 7 * * *' UTC — 1h depois do history-purge.
  registerCronJob({
    name: 'cron-runs-cleanup',
    schedule: '0 7 * * *', // 04:00 BRT daily
    enabled: historyEnabled, // mesmo gate (sem history, sem cron, sem cleanup)
    handler: cronRunsCleanup,
    lockTtlMs: 5 * 60 * 1000, // 5min — job rápido (DELETE batch curto)
    idempotent: true, // DELETE por range é idempotente
  })

  // Job 3: dead-letter-reprocess (Card #146 F4.7)
  // Schedule: 04:00 BRT Sunday = '0 7 * * 0' UTC — weekly.
  registerCronJob({
    name: 'dead-letter-reprocess',
    schedule: '0 7 * * 0', // 04:00 BRT Sunday
    enabled: historyEnabled,
    handler: deadLetterReprocess,
    lockTtlMs: 10 * 60 * 1000, // 10min — pode haver retry Storage lento
    idempotent: true, // reprocess_count INCR + UNIQUE PARTIAL absorvem retry
  })

  logger.info(
    {
      historyEnabled,
      jobsRegistered: 3,
    },
    'scheduler.bootstrap.cron_jobs_registered',
  )
}
