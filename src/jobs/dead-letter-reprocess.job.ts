/**
 * Dead-letter reprocess job — Card #146 (5.2b) F4.7.
 *
 * Cron weekly (Domingo 04:00 BRT) que retoma rows em `file_history_dead_letter`
 * com `resolved_at IS NULL AND reprocess_count < 3`. Tenta `removeByPath`
 * adicional. Sucesso → marca `resolved_at = NOW() + resolution_type =
 * 'cron_reprocess_success'`. Falha → INCR `reprocess_count`.
 *
 * **Após 3 tentativas falhas** (reprocess_count = 3): alerta Sentry CRITICAL
 * sinalizando "intervenção humana obrigatória" — admin investiga via runbook
 * `dead-letter-purge.md` (F5).
 *
 * **Por que weekly e não daily**:
 *  - Volume esperado baixo (<10 rows/semana se cron funcionando)
 *  - Falha Storage genérica costuma resolver em horas (rolling restart, etc) —
 *    daily faria retry prematuro
 *  - Weekly dá tempo de causa raiz se manifestar
 *
 * **Hard rule LGPD**: row em dead-letter NUNCA é deletada (trigger BEFORE
 * DELETE bloqueia). Resolução = UPDATE resolved_at + resolution_type.
 * Hard-delete só via job de retenção 5y futuro (Card LGPD-AUDIT).
 *
 * @owner: @devops + @dba + @security
 * @card: #146 (5.2b) F4.7
 */
import { randomUUID } from 'node:crypto'

import { hashStoragePathForAudit } from '../lib/audit/storage-path-hash'
import { hashResourceV1 } from '../lib/audit-hash'
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { getStorageAdapter } from '../lib/storage'
import {
  LegalActor,
  LegalEventType,
  LegalOutcome,
} from '../modules/audit-legal/audit-legal.types'
import { recordLegalEvent } from '../modules/audit-legal/audit-legal.service'
import { Sentry } from '../config/sentry'
import { emitSchedulerEvent } from '../scheduler/observability'
import type { LockHandle } from '../scheduler/types'

const JOB_NAME = 'dead-letter-reprocess'

/** Batch size do SELECT. Volume esperado baixo — 100 cobre folgado. */
const BATCH_SIZE = 100

/** Threshold de reprocess. Após 3 tentativas: alerta CRITICAL. */
const REPROCESS_LIMIT = 3

/**
 * Sanitiza err.message (max 100 chars, sem CR/LF/TAB, sem fragmentos Prisma SQL).
 *
 * Card #146 fix-pack ciclo 1 (@security MÉDIO): mesma defesa do
 * retention.job.ts contra Prisma SQL leak (msg começa com query parametrizada
 * após `:`).
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const prefix = err.message.split(':')[0] ?? ''
    return prefix.slice(0, 100).replace(/[\r\n\t]/g, ' ')
  }
  return 'unknown error'
}

/**
 * Handler do scheduler. Para cada row candidata:
 *  1. adapter.removeByPath(storage_path)
 *  2. Sucesso (incluindo 404) → UPDATE resolved_at + resolution_type +
 *     audit purge_completed (LGPD prova de purga manual via reprocess)
 *  3. Falha → INCR reprocess_count; se atinge LIMIT, audit purge_failed +
 *     emit cron.purge.dead_letter ALERTABLE
 *
 * Heartbeat ANTES de cada row (volume baixo, custo OK).
 *
 * NOTA: NÃO usa $transaction envolvendo Storage delete (R-3 hard-rule do
 * plano #146). Storage call FORA da tx; UPDATE/INSERT dentro.
 */
export async function deadLetterReprocess(lock: LockHandle): Promise<void> {
  const adapter = getStorageAdapter()
  if (!adapter) {
    logger.error(
      { jobName: JOB_NAME },
      'dead-letter-reprocess.storage_adapter_unavailable',
    )
    return
  }

  // SELECT candidates: resolved_at IS NULL AND reprocess_count < 3.
  // ORDER BY moved_to_dead_letter_at ASC = FIFO (fairness).
  const candidates = await prisma.fileHistoryDeadLetter.findMany({
    where: {
      resolvedAt: null,
      reprocessCount: { lt: REPROCESS_LIMIT },
    },
    orderBy: { movedToDeadLetterAt: 'asc' },
    take: BATCH_SIZE,
  })

  if (candidates.length === 0) {
    logger.info({ jobName: JOB_NAME }, 'dead-letter-reprocess.no_candidates')
    return
  }

  let resolved = 0
  let stillFailing = 0
  let escalatedToHuman = 0

  for (const row of candidates) {
    if (!(await lock.heartbeat())) {
      logger.warn(
        { jobName: JOB_NAME, processed: resolved + stillFailing },
        'dead-letter-reprocess.heartbeat_lost_aborting',
      )
      break
    }

    const now = new Date()
    try {
      // Storage delete FORA da tx (R-3).
      const result = await adapter.removeByPath(row.storagePath)

      // Sucesso (deletado OU 404 idempotente) → marca resolved.
      await prisma.fileHistoryDeadLetter.update({
        where: { id: row.id },
        data: {
          resolvedAt: now,
          resolutionType: result.notFound
            ? 'storage_already_gone'
            : 'cron_reprocess_success',
          reprocessCount: row.reprocessCount + 1,
          lastReprocessAttemptAt: now,
          lastReprocessErrorCode: null,
          lastReprocessErrorMessage: null,
        },
      })

      // Audit purge_completed (prova LGPD do retry sucessul).
      await recordLegalEvent({
        eventId: randomUUID(),
        eventType: LegalEventType.PURGE_COMPLETED,
        userId: row.userId,
        resourceType: 'file_history_dead_letter',
        resourceId: row.id,
        legalBasis: 'retention_expired',
        actor: LegalActor.CRON_PURGE_WORKER,
        outcome: LegalOutcome.SUCCESS,
        expiresAtOriginal: row.expiresAt,
        resourceHash: new Uint8Array(
          hashResourceV1(row.userId, row.storagePath),
        ),
        metadata: {
          pathHash: hashStoragePathForAudit(row.storagePath),
          jobName: JOB_NAME,
          phase: 'reprocess_success',
          reprocessAttempt: row.reprocessCount + 1,
          storageNotFound: result.notFound,
          originalFileHistoryId: row.originalFileHistoryId,
        },
      })
      resolved++
    } catch (err) {
      const errCode = err instanceof Error ? err.name : 'unknown'
      const errMessage = sanitizeErrorMessage(err)
      const newReprocessCount = row.reprocessCount + 1
      const hitLimit = newReprocessCount >= REPROCESS_LIMIT

      try {
        await prisma.fileHistoryDeadLetter.update({
          where: { id: row.id },
          data: {
            reprocessCount: newReprocessCount,
            lastReprocessAttemptAt: now,
            lastReprocessErrorCode: errCode,
            lastReprocessErrorMessage: errMessage,
          },
        })
        stillFailing++

        if (hitLimit) {
          escalatedToHuman++
          // Audit purge_failed final — humano DEVE investigar.
          await recordLegalEvent({
            eventId: randomUUID(),
            eventType: LegalEventType.PURGE_FAILED,
            userId: row.userId,
            resourceType: 'file_history_dead_letter',
            resourceId: row.id,
            legalBasis: 'retention_expired',
            actor: LegalActor.CRON_PURGE_WORKER,
            outcome: LegalOutcome.FAILURE,
            errorCode: 'REPROCESS_LIMIT_REACHED',
            expiresAtOriginal: row.expiresAt,
            resourceHash: new Uint8Array(
              hashResourceV1(row.userId, row.storagePath),
            ),
            metadata: {
              pathHash: hashStoragePathForAudit(row.storagePath),
              jobName: JOB_NAME,
              phase: 'reprocess_limit_reached',
              reprocessCount: newReprocessCount,
              lastErrorCode: errCode,
              originalFileHistoryId: row.originalFileHistoryId,
            },
          })
        }
      } catch (updateErr) {
        logger.error(
          {
            jobName: JOB_NAME,
            deadLetterId: row.id,
            errCode: updateErr instanceof Error ? updateErr.name : 'unknown',
            errMessage: sanitizeErrorMessage(updateErr),
          },
          'dead-letter-reprocess.update_failed',
        )
      }
    }
  }

  // Após batch: 1 emit consolidado se hit limit em alguma row.
  if (escalatedToHuman > 0) {
    emitSchedulerEvent({
      level: 'error',
      event: 'cron.purge.dead_letter',
      jobName: JOB_NAME,
      context: {
        escalatedToHuman,
        reprocessLimit: REPROCESS_LIMIT,
        message:
          'Rows atingiram reprocess_limit; intervenção humana obrigatória (runbook dead-letter-purge.md)',
      },
    })
    // Sentry tag pra dashboard de incidentes humanos.
    Sentry.captureMessage('cron.dead_letter_reprocess.human_required', {
      level: 'error',
      tags: {
        scheduler_job: JOB_NAME,
        scheduler_event: 'cron.purge.dead_letter',
      },
      extra: {
        escalatedToHuman,
        reprocessLimit: REPROCESS_LIMIT,
      },
    })
  }

  logger.info(
    {
      jobName: JOB_NAME,
      candidatesScanned: candidates.length,
      resolved,
      stillFailing,
      escalatedToHuman,
    },
    'dead-letter-reprocess.completed',
  )
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  JOB_NAME,
  BATCH_SIZE,
  REPROCESS_LIMIT,
  sanitizeErrorMessage,
}
