/**
 * Retention job — Card #146 (5.2b) F3.
 *
 * Handler `purgeExpiredFiles` executado pelo scheduler (Card #145 F4) diariamente
 * às 03:00 BRT (`'0 6 * * *'` UTC). Implementa **two-phase delete LGPD** (D-3
 * Card 5.2 + plano #146):
 *
 *   FASE A — Soft-delete + audit:
 *     1. SELECT 500 rows com `expiresAt < NOW() AND deletedAt IS NULL`
 *        FOR UPDATE SKIP LOCKED (anti split-brain DB-level).
 *     2. Para cada row: `recordLegalEvent(purge_pending)` AWAIT.
 *     3. `UPDATE file_history SET deletedAt = NOW()` para o batch — mesma tx.
 *     4. COMMIT.
 *
 *   FASE B — Storage delete + hard-delete:
 *     5. Para cada row (FORA da tx): `adapter.removeByPath(storagePath)`.
 *     6. Se sucesso ou 404: `DELETE FROM file_history WHERE id = X`
 *        + `recordLegalEvent(purge_completed)`.
 *     7. Se erro real: `UPDATE purge_attempts = purge_attempts + 1`.
 *
 *   FASE C — Reconciliação (mesmo loop, filtro complementar):
 *     8. SELECT rows com `deletedAt < NOW() - 1h AND purge_attempts < 5`.
 *        Pula Fase A (já feito), entra direto em Fase B.
 *
 *   FASE D — Dead-letter move (AMB-4=C):
 *     9. SELECT rows com `purge_attempts >= 5 AND deletedAt IS NOT NULL`.
 *        Move pra `file_history_dead_letter` (INSERT) + DELETE da origem.
 *        Audit `recordLegalEvent(purge_failed)`.
 *
 *   FASE E — Gauge + cron_runs finalize:
 *     10. `SELECT COUNT(*) FROM file_history WHERE deletedAt IS NOT NULL AND
 *         purge_attempts < 5` → `setPurgePendingCount('history-purge', count)`.
 *     11. UPDATE cron_runs SET status='success' WHERE id = runId.
 *
 * **Hard rules invioláveis:**
 *   - HTTP/Storage delete acontece FORA de qualquer `prisma.$transaction`
 *     (trava xmin horizon). Documentado inline em cada chamada.
 *   - `recordLegalEvent(purge_pending)` commitado ANTES do Storage delete —
 *     senão prova LGPD inverte (Art. 16). Pattern Card #150 D-1.
 *   - Heartbeat antes de cada batch — se `lock.heartbeat()` retorna false,
 *     aborta gracefully (split-brain detectado, próxima janela reconcilia).
 *   - Dry-run mode (`env.CRON_DRY_RUN=true`): loga o que faria, NÃO muta DB
 *     nem Storage.
 *   - Batch sleep 100ms entre commits — reduz pressure no DB.
 *
 * **Idempotência:** handler é `CronJobDefinition.idempotent: true`. Reentry
 * após crash mid-batch é safe porque:
 *   - Fase A não-cometida → rollback automático Postgres.
 *   - Fase A cometida + Fase B parcial → reconciliação cobre.
 *   - Storage 404 = sucesso (objeto já não existe ou deleted antes).
 *   - audit_log_legal eventId é UNIQUE constraint — P2002 absorve retry.
 *
 * @owner: @dba + @security + @planner
 * @card: #146 (5.2b) F3
 * @plan: .claude/plans/2026-05-18-card-146-5.2b-cron-purge-two-phase.md §7
 */
import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { hashStoragePathForAudit } from '../lib/audit/storage-path-hash'
import { hashResourceV1 } from '../lib/audit-hash'
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { sanitizeErrorMessage } from '../lib/sanitize-error'
import { getStorageAdapter } from '../lib/storage'
import {
  LegalActor,
  LegalEventType,
  LegalOutcome,
} from '../modules/audit-legal/audit-legal.types'
import { recordLegalEvent } from '../modules/audit-legal/audit-legal.service'
import { env } from '../config/env'
import { Sentry } from '../config/sentry'
import { setPurgePendingCount } from '../scheduler/metrics'
import { emitSchedulerEvent } from '../scheduler/observability'
import type { LockHandle } from '../scheduler/types'

// ============================================
// CONSTANTES
// ============================================

/**
 * Job name registrado no scheduler. Usado também em métricas/Sentry tags.
 * Mudar = breaking pra dashboard + runbooks (#176/#177).
 */
const JOB_NAME = 'history-purge'

/**
 * Tamanho do batch. 500 é trade-off:
 *  - Maior: menos commits, mais pressure por tx (lock_timeout risco)
 *  - Menor: mais commits, mais round-trips
 * Plano #146 §6 D-G validou 500 com sleep 100ms.
 */
const BATCH_SIZE = 500

/**
 * Sleep entre batches em ms. Reduz pressure no DB (~3 batches/seg max =
 * 1500 rows/seg). Plano #146 D-G.
 */
const BATCH_SLEEP_MS = 100

/**
 * Reconciliação considera rows com `deletedAt < NOW() - this`. Soft-deletes
 * recentes (< 1h) podem estar em Fase B em execução paralela — não interfere.
 */
const RECONCILIATION_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Threshold de tentativas pra mover pra dead-letter (Card #146 AMB-4=C).
 * Após 5 falhas Storage delete, row é movida pra file_history_dead_letter
 * pra investigação humana / cron weekly reprocess (Card #146 F4.7).
 */
const DEAD_LETTER_THRESHOLD = 5

/**
 * Statement/lock timeouts por sessão. Defesa contra query travada.
 * Aplicado via $executeRawUnsafe('SET LOCAL ...') na 1ª query da tx
 * (mitigation A-5 do plano).
 */
const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '30s'

// ============================================
// TIPOS LOCAIS
// ============================================

interface ExpiredFileRow {
  id: string
  userId: string
  storagePath: string
  originalFilename: string
  mimeType: string
  fileSize: number
  expiresAt: Date
  purgeAttempts: number
}

interface ReconcileFileRow extends ExpiredFileRow {
  deletedAt: Date
}

interface PurgeResult {
  rowsSoftDeleted: number
  rowsHardDeleted: number
  rowsRetried: number
  rowsMovedToDeadLetter: number
}

// ============================================
// HELPERS
// ============================================

// Card #147 fix-pack ciclo 2 (discovery resolvido @dba+@security convergente):
// sanitizeErrorMessage extraído pra src/lib/sanitize-error.ts (SSOT).
// Duplicação com quota-alert.job.ts eliminada.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============================================
// CRON_RUNS LIFECYCLE
// ============================================

/**
 * INSERT em cron_runs com status='running'. Retorna runId pra UPDATE no fim.
 * Falha de write NÃO derruba o handler (degraded — log warning + segue).
 * AMB-3=A do plano: cron_runs é nice-to-have, não bloqueador.
 */
async function recordRunStart(): Promise<string> {
  const runId = randomUUID()
  try {
    await prisma.cronRun.create({
      data: {
        id: runId,
        jobName: JOB_NAME,
        startedAt: new Date(),
        status: 'running',
        attempts: 1,
      },
    })
  } catch (err) {
    logger.warn(
      {
        jobName: JOB_NAME,
        runId,
        errCode: err instanceof Error ? err.name : 'unknown',
        errMessage: sanitizeErrorMessage(err),
      },
      'retention.job.cron_runs.insert_failed_degraded',
    )
    // NÃO throw — gauge in-memory do scheduler ainda funciona; cron_runs
    // é histórico secundário.
  }
  return runId
}

/**
 * UPDATE cron_runs no terminal state. Falha NÃO derruba (já no fim do handler).
 */
async function recordRunEnd(args: {
  runId: string
  status: 'success' | 'failure'
  startedAt: Date
  rowsProcessed: number
  errorCode?: string
  errorMessage?: string
}): Promise<void> {
  const finishedAt = new Date()
  try {
    await prisma.cronRun.update({
      where: { id: args.runId },
      data: {
        finishedAt,
        status: args.status,
        durationMs: finishedAt.getTime() - args.startedAt.getTime(),
        rowsProcessed: args.rowsProcessed,
        errorCode: args.errorCode ?? null,
        errorMessage: args.errorMessage ?? null,
      },
    })
  } catch (err) {
    logger.warn(
      {
        jobName: JOB_NAME,
        runId: args.runId,
        targetStatus: args.status,
        errCode: err instanceof Error ? err.name : 'unknown',
        errMessage: sanitizeErrorMessage(err),
      },
      'retention.job.cron_runs.update_failed_degraded',
    )
  }
}

// ============================================
// FASE A — Soft-delete + audit (tx única)
// ============================================

/**
 * Seleciona batch de rows expiradas + soft-delete + audit purge_pending,
 * tudo numa única transação. Retorna as rows pra Fase B fora da tx.
 *
 * **CRÍTICO LGPD**: audit_log_legal(purge_pending) é committed ANTES do
 * Storage delete (que acontece em Fase B, FORA da tx). Garante prova
 * jurídica mesmo em crash mid-handler. Pattern Card #150 D-1.
 */
async function selectAndSoftDeleteBatch(): Promise<ExpiredFileRow[]> {
  return prisma.$transaction(async (tx) => {
    // A-5 mitigation: SET LOCAL como PRIMEIRA query da tx pra garantir efeito.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
    await tx.$executeRawUnsafe(
      `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
    )

    // FOR UPDATE SKIP LOCKED: anti split-brain DB-level (R-4). Tipagem via
    // Prisma.sql + $queryRaw template tag (não $queryRawUnsafe — input
    // de schema, mas defesa em profundidade).
    const rows = await tx.$queryRaw<ExpiredFileRow[]>`
      SELECT id, user_id AS "userId", storage_path AS "storagePath",
             original_filename AS "originalFilename", mime_type AS "mimeType",
             file_size AS "fileSize", expires_at AS "expiresAt",
             purge_attempts AS "purgeAttempts"
      FROM file_history
      WHERE expires_at < NOW()
        AND deleted_at IS NULL
      ORDER BY expires_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `

    if (rows.length === 0) return []

    // Audit purge_pending pra CADA row. AWAIT — falha aborta tx → rollback
    // automático Postgres → reentrância safe (Prisma rollback + sem soft-delete).
    //
    // Card #146 F5 fix-pack (ciclo 1 CRÍTICO @dba a5f3b2e9c1d4): passa `tx`
    // pra recordLegalEvent SSOT na MESMA conexão da tx pai. Sem isso,
    // audit INSERT ia pra conexão separada (audit órfão + pool exhaustion +
    // xmin horizon).
    for (const row of rows) {
      await recordLegalEvent(
        {
          eventId: randomUUID(),
          eventType: LegalEventType.PURGE_PENDING,
          userId: row.userId,
          resourceType: 'file_history',
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
            phase: 'soft_delete',
          },
        },
        tx,
      )
    }

    // Soft-delete o batch inteiro num único UPDATE.
    // Card #146 hotfix (descoberto em primeira execução integration local):
    // sem cast `::uuid` cada bind vai como text, Postgres rejeita com
    // `operator does not exist: uuid = text` (CWE-704 type confusion).
    // Cast por elemento via Prisma.sql template literal.
    const ids = rows.map((r) => r.id)
    const idsList = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))
    await tx.$executeRaw`
      UPDATE file_history
      SET deleted_at = NOW()
      WHERE id IN (${idsList})
    `

    return rows
  })
}

// ============================================
// FASE B — Storage delete + hard-delete
// ============================================

/**
 * Para cada row do batch: chama `adapter.removeByPath` FORA de qualquer tx
 * (R-3 hard-rule). Sucesso → hard-delete + audit purge_completed.
 * Falha real → UPDATE purge_attempts++ (próxima reconciliação retoma).
 *
 * 404 é IDEMPOTENTE (objeto não existe → sucesso). `removeByPath` retorna
 * `notFound: true` sem throw.
 */
async function processStorageDeletes(
  rows: ExpiredFileRow[],
): Promise<{ hardDeleted: number; retried: number }> {
  const adapter = getStorageAdapter()
  if (!adapter) {
    // Em dev/test sem env de Storage. Em prod, env.ts superRefine bloqueia
    // boot — chegar aqui em prod = bug crítico de config. Sentry alerta.
    logger.error(
      { jobName: JOB_NAME, batchSize: rows.length },
      'retention.job.storage_adapter_unavailable',
    )
    return { hardDeleted: 0, retried: 0 }
  }

  let hardDeleted = 0
  let retried = 0

  for (const row of rows) {
    try {
      // FORA da tx — chamada HTTP REST ao Supabase Storage.
      const result = await adapter.removeByPath(row.storagePath)

      // Sucesso (deletado OU 404 idempotente) → hard-delete + audit completed.
      // Wrap em tx pequena (só DB) pra atomicidade audit + delete.
      // Card #146 fix-pack ciclo 1: recordLegalEvent recebe `tx` — mesma
      // conexão da tx pai (D-1 LGPD atômico). Risco INVERTIDO se sem tx:
      // DELETE commitaria sem audit purge_completed = row apagada sem prova
      // LGPD (catástrofe forense).
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
        await tx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
        )
        await tx.fileHistory.delete({ where: { id: row.id } })
        await recordLegalEvent(
          {
            eventId: randomUUID(),
            eventType: LegalEventType.PURGE_COMPLETED,
            userId: row.userId,
            resourceType: 'file_history',
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
              phase: 'storage_deleted',
              storageNotFound: result.notFound,
            },
          },
          tx,
        )
      })
      hardDeleted++
    } catch (err) {
      // Erro real (Supabase 5xx, timeout, etc) — INCR purge_attempts.
      // Next reconciliation retomará (idempotência via deletedAt + attempts).
      const errCode = err instanceof Error ? err.name : 'unknown'
      const errMessage = sanitizeErrorMessage(err)
      try {
        await prisma.fileHistory.update({
          where: { id: row.id },
          data: { purgeAttempts: { increment: 1 } },
        })
        retried++
        logger.warn(
          {
            jobName: JOB_NAME,
            fileHistoryId: row.id,
            pathHash: hashStoragePathForAudit(row.storagePath),
            newAttempts: row.purgeAttempts + 1,
            errCode,
            errMessage,
          },
          'retention.job.storage_delete_failed_retry',
        )
      } catch (incrErr) {
        // Não conseguiu incr — log Sentry, segue próximo. Próxima reconciliação
        // verá `deletedAt < NOW() - 1h` e tentará de novo.
        logger.error(
          {
            jobName: JOB_NAME,
            fileHistoryId: row.id,
            errCode: incrErr instanceof Error ? incrErr.name : 'unknown',
            errMessage: sanitizeErrorMessage(incrErr),
          },
          'retention.job.purge_attempts_incr_failed',
        )
      }
    }
  }

  return { hardDeleted, retried }
}

// ============================================
// FASE C — Reconciliação (Fase B em rows pendentes antigas)
// ============================================

async function selectReconciliationBatch(): Promise<ReconcileFileRow[]> {
  const ageCutoff = new Date(Date.now() - RECONCILIATION_MIN_AGE_MS)

  return prisma.$queryRaw<ReconcileFileRow[]>`
    SELECT id, user_id AS "userId", storage_path AS "storagePath",
           original_filename AS "originalFilename", mime_type AS "mimeType",
           file_size AS "fileSize", expires_at AS "expiresAt",
           deleted_at AS "deletedAt", purge_attempts AS "purgeAttempts"
    FROM file_history
    WHERE deleted_at IS NOT NULL
      AND deleted_at < ${ageCutoff}
      AND purge_attempts < ${DEAD_LETTER_THRESHOLD}
    ORDER BY deleted_at ASC
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `
}

// ============================================
// FASE D — Dead-letter move (AMB-4=C)
// ============================================

/**
 * Move rows com `purge_attempts >= 5` pra `file_history_dead_letter` +
 * DELETE da file_history original. Audit `purge_failed`.
 *
 * Pós-move, alerta Sentry CRITICAL (`cron.purge.dead_letter`) — on-call
 * deve investigar (cron weekly `dead-letter-reprocess` Card #146 F4.7
 * tenta 3 vezes adicionais antes de declarar "intervenção humana obrigatória").
 */
async function moveToDeadLetter(): Promise<number> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string
      userId: string
      storagePath: string
      originalFilename: string
      mimeType: string
      fileSize: number
      expiresAt: Date
      deletedAt: Date
      purgeAttempts: number
    }>
  >`
    SELECT id, user_id AS "userId", storage_path AS "storagePath",
           original_filename AS "originalFilename", mime_type AS "mimeType",
           file_size AS "fileSize", expires_at AS "expiresAt",
           deleted_at AS "deletedAt", purge_attempts AS "purgeAttempts"
    FROM file_history
    WHERE deleted_at IS NOT NULL
      AND purge_attempts >= ${DEAD_LETTER_THRESHOLD}
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `

  if (rows.length === 0) return 0

  let moved = 0
  for (const row of rows) {
    try {
      await prisma.$transaction(async (tx) => {
        // Card #146 fix-pack ciclo 1 (@dba MÉDIO): lock_timeout antes do
        // statement_timeout pra consistência defensiva com selectAndSoftDeleteBatch.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
        await tx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
        )

        // INSERT na quarentena. UNIQUE PARTIAL uq_fhdl_active_per_origin
        // absorve duplicação via P2002 (race ou re-execução).
        await tx.fileHistoryDeadLetter.create({
          data: {
            originalFileHistoryId: row.id,
            userId: row.userId,
            storagePath: row.storagePath,
            originalFilename: row.originalFilename,
            mimeType: row.mimeType,
            fileSize: row.fileSize,
            expiresAt: row.expiresAt,
            deletedAt: row.deletedAt,
            purgeAttempts: row.purgeAttempts,
            lastErrorCode: 'STORAGE_DELETE_THRESHOLD_REACHED',
            lastErrorMessage: `Storage delete failed ${row.purgeAttempts} times`,
          },
        })

        // DELETE da origem.
        await tx.fileHistory.delete({ where: { id: row.id } })

        // Audit purge_failed (5y LGPD). Card #146 fix-pack ciclo 1: passa `tx`
        // pra recordLegalEvent — sem isso, audit INSERT vai pra conexão
        // separada e DELETE da origem pode commitar sem audit purge_failed
        // (catástrofe forense: row sumiu sem prova de tentativa).
        await recordLegalEvent(
          {
            eventId: randomUUID(),
            eventType: LegalEventType.PURGE_FAILED,
            userId: row.userId,
            resourceType: 'file_history',
            resourceId: row.id,
            legalBasis: 'retention_expired',
            actor: LegalActor.CRON_PURGE_WORKER,
            outcome: LegalOutcome.FAILURE,
            errorCode: 'STORAGE_DELETE_THRESHOLD_REACHED',
            expiresAtOriginal: row.expiresAt,
            resourceHash: new Uint8Array(
              hashResourceV1(row.userId, row.storagePath),
            ),
            metadata: {
              pathHash: hashStoragePathForAudit(row.storagePath),
              jobName: JOB_NAME,
              phase: 'moved_to_dead_letter',
              purgeAttempts: row.purgeAttempts,
            },
          },
          tx,
        )
      })
      moved++
    } catch (err) {
      // P2002 (UNIQUE active_per_origin) ou erro genérico — log + segue.
      logger.error(
        {
          jobName: JOB_NAME,
          fileHistoryId: row.id,
          errCode: err instanceof Error ? err.name : 'unknown',
          errMessage: sanitizeErrorMessage(err),
        },
        'retention.job.dead_letter_move_failed',
      )
    }
  }

  if (moved > 0) {
    emitSchedulerEvent({
      level: 'error',
      event: 'cron.purge.dead_letter',
      jobName: JOB_NAME,
      context: {
        movedCount: moved,
        threshold: DEAD_LETTER_THRESHOLD,
      },
    })
  }

  return moved
}

// ============================================
// FASE E — Gauge update
// ============================================

async function updatePurgePendingGauge(): Promise<number> {
  const result = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM file_history
    WHERE deleted_at IS NOT NULL
      AND purge_attempts < ${DEAD_LETTER_THRESHOLD}
  `
  const count = Number(result[0]?.count ?? 0n)
  setPurgePendingCount(JOB_NAME, count)

  // Alerta se gauge > 1000 (signal de cron sobrecarregado ou Storage
  // sistemicamente indisponível).
  if (count > 1000) {
    emitSchedulerEvent({
      level: 'warning',
      event: 'cron.purge.pending_overdue',
      jobName: JOB_NAME,
      context: { pendingCount: count, threshold: 1000 },
    })
  }

  return count
}

// ============================================
// DRY-RUN MODE
// ============================================

async function runDryMode(runId: string, startedAt: Date): Promise<void> {
  emitSchedulerEvent({
    level: 'info',
    event: 'cron.purge.dry_run.start',
    jobName: JOB_NAME,
    context: { runId },
  })

  const expired = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM file_history
    WHERE expires_at < NOW() AND deleted_at IS NULL
  `
  const reconcileAgeCutoff = new Date(Date.now() - RECONCILIATION_MIN_AGE_MS)
  const reconcile = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM file_history
    WHERE deleted_at IS NOT NULL
      AND deleted_at < ${reconcileAgeCutoff}
      AND purge_attempts < ${DEAD_LETTER_THRESHOLD}
  `
  const deadLetter = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM file_history
    WHERE deleted_at IS NOT NULL
      AND purge_attempts >= ${DEAD_LETTER_THRESHOLD}
  `

  const wouldPurge = Number(expired[0]?.count ?? 0n)
  const wouldReconcile = Number(reconcile[0]?.count ?? 0n)
  const wouldMoveToDeadLetter = Number(deadLetter[0]?.count ?? 0n)

  logger.info(
    {
      jobName: JOB_NAME,
      runId,
      dryRun: true,
      wouldPurge,
      wouldReconcile,
      wouldMoveToDeadLetter,
    },
    `[DRY_RUN] would process ${wouldPurge} expired + ${wouldReconcile} reconcile + ${wouldMoveToDeadLetter} dead-letter`,
  )

  await recordRunEnd({
    runId,
    status: 'success',
    startedAt,
    rowsProcessed: 0,
  })
}

// ============================================
// HANDLER PRINCIPAL
// ============================================

/**
 * Orquestrador two-phase delete LGPD. Chamado pelo scheduler.
 *
 * **Lifecycle**:
 *   1. INSERT cron_runs (status='running')
 *   2. Check dry-run → if true, log + return
 *   3. Loop Fase A+B até esgotar expired
 *   4. Loop Fase C+B até esgotar reconcile
 *   5. Fase D move dead-letter
 *   6. Fase E atualiza gauge
 *   7. UPDATE cron_runs (status='success')
 *
 * Heartbeat antes de cada batch. Erros NÃO escalam — runner do scheduler
 * já trata via Promise.catch (emit cron.run.failure).
 */
export async function purgeExpiredFiles(lock: LockHandle): Promise<void> {
  const startedAt = new Date()
  const runId = await recordRunStart()

  if (env.CRON_DRY_RUN) {
    await runDryMode(runId, startedAt)
    return
  }

  const result: PurgeResult = {
    rowsSoftDeleted: 0,
    rowsHardDeleted: 0,
    rowsRetried: 0,
    rowsMovedToDeadLetter: 0,
  }

  try {
    // FASE A+B — loop até esgotar expired.
    while (true) {
      if (!(await lock.heartbeat())) {
        logger.warn(
          { jobName: JOB_NAME, runId },
          'retention.job.heartbeat_lost_aborting',
        )
        // Próxima janela reconcilia rows com soft-delete sem hard-delete.
        break
      }

      const batch = await selectAndSoftDeleteBatch()
      if (batch.length === 0) break

      result.rowsSoftDeleted += batch.length
      const { hardDeleted, retried } = await processStorageDeletes(batch)
      result.rowsHardDeleted += hardDeleted
      result.rowsRetried += retried

      await sleep(BATCH_SLEEP_MS)
    }

    // FASE C — reconciliação (Fase B em rows pendentes antigas).
    // Card #146 hotfix (descoberto em primeira execução integration local):
    // Guard `seenIds` previne que Storage 5xx persistente leve mesma row de
    // purge_attempts=1→5 num single run via loop que re-SELECT a mesma row
    // (sem o guard, 1 run com Storage indisponível movia row pra dead-letter
    // imediatamente, ignorando intencionalmente o cooldown de 1h entre
    // tentativas que a reconciliação documenta).
    const seenIds = new Set<string>()
    while (true) {
      if (!(await lock.heartbeat())) break

      const batch = await selectReconciliationBatch()
      const fresh = batch.filter((r) => !seenIds.has(r.id))
      if (fresh.length === 0) break
      fresh.forEach((r) => seenIds.add(r.id))

      const { hardDeleted, retried } = await processStorageDeletes(fresh)
      result.rowsHardDeleted += hardDeleted
      result.rowsRetried += retried

      await sleep(BATCH_SLEEP_MS)
    }

    // FASE D — dead-letter move (não-batched loop, single pass — volume baixo).
    if (await lock.heartbeat()) {
      result.rowsMovedToDeadLetter = await moveToDeadLetter()
    }

    // FASE E — gauge update.
    await updatePurgePendingGauge()

    await recordRunEnd({
      runId,
      status: 'success',
      startedAt,
      rowsProcessed:
        result.rowsHardDeleted +
        result.rowsMovedToDeadLetter +
        result.rowsRetried,
    })

    logger.info(
      { jobName: JOB_NAME, runId, ...result },
      'retention.job.completed',
    )
  } catch (err) {
    // Erro inesperado — runner do scheduler (cron.ts) emite cron.run.failure
    // via emitSchedulerEvent. Aqui apenas atualizamos cron_runs antes do
    // re-throw (que NÃO acontece — runner é catch-all).
    const errCode = err instanceof Error ? err.name : 'unknown'
    const errMessage = sanitizeErrorMessage(err)
    Sentry.captureException(err, {
      tags: { jobName: JOB_NAME, runId },
      extra: { ...result } as Record<string, unknown>,
    })
    await recordRunEnd({
      runId,
      status: 'failure',
      startedAt,
      rowsProcessed:
        result.rowsHardDeleted +
        result.rowsMovedToDeadLetter +
        result.rowsRetried,
      errorCode: errCode,
      errorMessage: errMessage,
    })
    throw err
  }
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  JOB_NAME,
  BATCH_SIZE,
  BATCH_SLEEP_MS,
  RECONCILIATION_MIN_AGE_MS,
  DEAD_LETTER_THRESHOLD,
  sanitizeErrorMessage,
  recordRunStart,
  recordRunEnd,
  selectAndSoftDeleteBatch,
  processStorageDeletes,
  selectReconciliationBatch,
  moveToDeadLetter,
  updatePurgePendingGauge,
  runDryMode,
}
