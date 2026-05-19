/**
 * Cron runs cleanup job — Card #146 (5.2b) F4.5.
 *
 * Retenção operacional 30d da tabela `cron_runs` (Card #146 F2.5).
 * cron_runs é histórico operacional do scheduler (forense LGPD vai pro
 * `audit_log_legal` 5y, separado).
 *
 * **Algoritmo simples**:
 *   DELETE FROM cron_runs
 *   WHERE created_at < NOW() - INTERVAL '30 days'
 *
 * Não há batch loop porque volume esperado é baixo (~150 rows/mês ×
 * 3 jobs daily = ~450/mês; 30d = ~450 rows). DELETE direto é OK.
 *
 * **Defesa contra bloat (relatório @dba F2.5 #9.1.1)**: além do DELETE
 * por data, também marca como `expired` rows `status='running'` antigas
 * (> 2h) — defesa contra orphan running que travaria alertas de "job
 * stuck".
 *
 * @owner: @devops + @dba
 * @card: #146 (5.2b) F4.5
 */
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { emitSchedulerEvent } from '../scheduler/observability'
import type { LockHandle } from '../scheduler/types'

const JOB_NAME = 'cron-runs-cleanup'

/** Retenção operacional cron_runs. 30d cobre debug + audit_log_legal cobre forense 5y. */
const RETENTION_DAYS = 30

/** Threshold pra marcar `status='running'` órfão como `expired` (sanity). */
const STALE_RUNNING_MS = 2 * 60 * 60 * 1000 // 2h

/**
 * Handler do scheduler. Lifecycle:
 *  1. DELETE WHERE created_at < NOW() - 30d (retenção)
 *  2. UPDATE status='expired' WHERE status='running' AND started_at < NOW()-2h
 *     (orphan recovery — relatório @dba F2.5 #9.1.3)
 *  3. Log structured count
 *
 * Erros NÃO escalam — runner do scheduler (cron.ts) já trata via
 * Promise.catch (emit cron.run.failure).
 *
 * Heartbeat ANTES de cada operação (defense em profundidade).
 */
export async function cronRunsCleanup(lock: LockHandle): Promise<void> {
  if (!(await lock.heartbeat())) {
    logger.warn(
      { jobName: JOB_NAME },
      'cron-runs-cleanup.heartbeat_lost_aborting',
    )
    return
  }

  // Passo 1: retenção 30d
  const retentionCutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  )
  const deleted = await prisma.cronRun.deleteMany({
    where: { createdAt: { lt: retentionCutoff } },
  })

  // Passo 2: orphan running recovery
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS)
  const recovered = await prisma.cronRun.updateMany({
    where: {
      status: 'running',
      startedAt: { lt: staleCutoff },
    },
    data: {
      status: 'expired',
      finishedAt: new Date(),
      errorCode: 'STALE_RUNNING_INFERRED',
      errorMessage: 'inferred from stale running state (>2h)',
    },
  })

  if (recovered.count > 0) {
    // Alerta operacional — running órfão = bug do handler (crash sem cleanup).
    emitSchedulerEvent({
      level: 'warning',
      event: 'cron.run.expired',
      jobName: JOB_NAME,
      context: {
        recoveredCount: recovered.count,
        reason: 'stale_running_inferred',
      },
    })
  }

  logger.info(
    {
      jobName: JOB_NAME,
      retentionDays: RETENTION_DAYS,
      deletedRows: deleted.count,
      recoveredOrphans: recovered.count,
    },
    'cron-runs-cleanup.completed',
  )
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  JOB_NAME,
  RETENTION_DAYS,
  STALE_RUNNING_MS,
}
