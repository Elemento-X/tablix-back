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
import { scanUsageAndAlert } from '../jobs/quota-alert.job'
import { purgeExpiredFiles } from '../jobs/retention.job'
import { logger } from '../lib/logger'
import { registerCronJob } from './cron'

/**
 * SSOT de nomes registrados pelo bootstrap. Atualizar ao adicionar/remover
 * job em `bootstrapCronJobs`. Permite contadores derivados em logs e
 * verificação em tests sem hardcode (@devops BAIXO fix-pack Card #147).
 */
const JOB_NAMES = [
  'history-purge',
  'cron-runs-cleanup',
  'dead-letter-reprocess',
  'quota-alert',
] as const

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
  // Card #146 fix-pack ciclo 1 (@dba ALTO #4): lockTtlMs bumped 15min→30min.
  // Justificativa: plano §6 D-G estima ~5s/batch × 200 batches (100k rows/dia)
  // = ~17min worst-case. 15min original era subdimensionado — heartbeat 60s
  // renova durante execução, MAS se DB lento estourar statement_timeout 30s
  // mid-batch, próximo heartbeat pode chegar tarde. 30min = 2x worst-case
  // estimado (folga 2x sobre projeção 100k rows/dia). Operacional pré-go-live
  // com volume baixo: TTL maior é seguro (sem rows pendentes = lock libera
  // rápido naturalmente).
  registerCronJob({
    name: 'history-purge',
    schedule: '0 6 * * *', // 03:00 BRT daily
    enabled: historyEnabled,
    handler: purgeExpiredFiles,
    lockTtlMs: 30 * 60 * 1000, // 30min TTL — cobre worst-case 100k rows/dia
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

  // Job 4: quota-alert (Card #147 F3)
  // Schedule: 08:00 BRT = '0 11 * * *' UTC — janela manhã (decisão A-5 do plano).
  // Justificativa UX: usuários PRO reagem rápido a "atingiu 90%" pela manhã.
  // Contrast deliberado com 03:00 BRT do history-purge (ops vs UX).
  // Mesmo kill-switch dos outros 3 jobs (decisão A-9 + trade-off R-5):
  // se feature history off, NÃO rodar nenhum cron (sem ruído Sentry de dry-run
  // acidental). Discovery card decouple-cron-kill-switches cobre o trade-off.
  registerCronJob({
    name: 'quota-alert',
    schedule: '0 11 * * *', // 08:00 BRT daily
    enabled: historyEnabled,
    handler: scanUsageAndAlert,
    lockTtlMs: 10 * 60 * 1000, // 10min — SELECT PRO + N emails @ 10/s; <100 users <2min
    idempotent: true, // UNIQUE(user_id, threshold, period) + ON CONFLICT DO NOTHING
  })

  // Card #147 fix-pack ciclo 1 (@devops BAIXO): count derivado em vez de
  // hardcoded — futuras adições não esquecem de bumpar (Sentry dashboard
  // que pareie boot signal com count real não dá falso negativo silencioso).
  // 4 = registerCronJob calls acima (history-purge, cron-runs-cleanup,
  // dead-letter-reprocess, quota-alert).
  const jobsRegistered = JOB_NAMES.length
  logger.info(
    { historyEnabled, jobsRegistered },
    'scheduler.bootstrap.cron_jobs_registered',
  )
}
