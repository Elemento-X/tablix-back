/**
 * Async cleanup jobs — Card 6.7 (Fase 6 — Fila Assíncrona) + sweeper #197.
 *
 * Dois handlers de cron, registrados em `scheduler/jobs.bootstrap.ts`:
 *
 *  1. `sweepOrphanJobs` (cron `async-job-sweeper`, a cada 5min) — recuperação de
 *     estado preso, TEMPO-SENSÍVEL. NÃO toca o Storage (handler enxuto pro cron
 *     frequente; toda purga de Storage é centralizada no handler 2):
 *       a) **PENDING órfão da fila (#197):** job que reservou quota no enqueue
 *          mas nunca entrou na fila BullMQ (crash entre `job.create` e o
 *          `enqueueProcessJob`). Decisão D-4: re-enfileira (se dentro do TTL +
 *          fila ok + inputs metadata válido) OU marca FAILED + estorna quota
 *          (no período do `createdAt`). Refund idempotente por transição de
 *          status (`updateMany WHERE status='PENDING'` → count===1).
 *       b) **PROCESSING travado (6.7b):** worker morto mid-flight + BullMQ
 *          esgotou retries → DB preso em PROCESSING. Marca FAILED (status-guard),
 *          **sem** estorno (D-2b: alinha A-REFUND — serviço foi tentado). Só
 *          força FAILED se o job está AUSENTE da fila ou em estado terminal nela
 *          (completed/failed) — nunca se ainda ativo/retentando (anti R-1).
 *
 *  2. `purgeAsyncJobStorage` (cron `async-storage-cleanup`, diário 09:00 BRT) —
 *     purga de Storage, NÃO tempo-sensível (DB-driven, D-1):
 *       a) **Inputs de terminais não purgados (B-6.7.1 / M-03):** jobs
 *          COMPLETED/FAILED com `inputs_purged_at IS NULL` — enumera os inputs
 *          via metadata (`inputFiles`) e remove individualmente (D-3, NÃO
 *          delete-by-prefix). `inputs_purged_at` só é setado se TODOS saíram;
 *          parciais ficam NULL pro próximo run (anti órfão permanente de PII).
 *       b) **Outputs expirados (A-4):** jobs `expires_at < now()` ainda não
 *          baixados (`downloaded_at IS NULL`) com output presente
 *          (`output_file_url IS NOT NULL`) — remove o output e seta
 *          `output_file_url = NULL` (tombstone, evita re-scan eterno).
 *
 * **Idempotência:** ambos `idempotent: true` no scheduler. As transições são
 * status-guarded (`WHERE status=...`) e o purge de Storage é 404-safe
 * (`removeByPath` idempotente). Reentry após crash/lockLost é seguro.
 *
 * **Anti-race com o worker (R-3):** o worker claima `WHERE status IN
 * ('PENDING','PROCESSING')`; o sweeper transita `WHERE status='PENDING'` /
 * `WHERE status='PROCESSING'`. O lock de linha do Postgres elege 1 vencedor; o
 * re-enqueue é idempotente por `Job.id`. Nenhuma chamada externa (Redis/Storage)
 * roda dentro de transação.
 *
 * @owner: @planner + @dba + @devops + @security
 * @card: 6.7 (+ #197)
 * @plan: .claude/plans/2026-06-22-card-6.7-async-cleanup-e-sweeper-197.md
 */
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { sanitizeErrorMessage } from '../lib/sanitize-error'
import { getStorageAdapter } from '../lib/storage'
import {
  buildJobInputPath,
  buildJobOutputPath,
} from '../lib/storage/key-builder'
import type { AllowedExtension } from '../lib/storage/types'
import {
  enqueueProcessJob,
  getProcessJobState,
  isProcessQueueConfigured,
} from '../lib/queue/process-queue'
import {
  decrementUsageForPeriod,
  getCurrentPeriod,
} from '../modules/usage/usage.service'
import { jobInputFilesSchema } from '../modules/process/process-async.input-files.schema'
import { env } from '../config/env'
import { Sentry } from '../config/sentry'
import { setAsyncCleanupCount } from '../scheduler/metrics'
import { emitSchedulerEvent } from '../scheduler/observability'
import type { LockHandle } from '../scheduler/types'

// ============================================
// CONSTANTES
// ============================================

const JOB_NAME_SWEEP = 'async-job-sweeper'
const JOB_NAME_STORAGE = 'async-storage-cleanup'

/** Tamanho do batch dos SELECTs. Volume esperado baixo (órfãos são raros). */
const BATCH_SIZE = 500

/** Sleep entre batches (ms) — reduz pressure no DB/Redis/Storage. */
const BATCH_SLEEP_MS = 100

/**
 * Margem de TTL pro re-enqueue (D-4): só re-enfileira um PENDING órfão se ainda
 * houver pelo menos esta folga até o `expires_at` — senão o job expiraria antes
 * do worker terminar. Abaixo da margem → FAILED + refund.
 */
const REENQUEUE_TTL_MARGIN_MS = 60 * 60 * 1000 // 1h

/**
 * Estados terminais de um job na fila BullMQ. Para o force-fail (6.7b): só
 * marcamos FAILED se o job está AUSENTE da fila OU num destes estados. Qualquer
 * outro estado (active/waiting/delayed/...) ou desconhecido → conservador, NÃO
 * força (BullMQ ainda gerencia; anti R-1 — não matar job legítimo).
 */
const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed'])

// ============================================
// HELPERS
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `getProcessJobState` resiliente por-linha (@reviewer BAIXO): um blip transitório
 * do Redis na inspeção da fila NÃO deve abortar o batch inteiro. Em erro, loga e
 * retorna `null` (tratado pelos callers como inconclusivo → pula a linha; o
 * próximo run reavalia, idempotente).
 */
async function safeGetJobState(
  jobId: string,
): ReturnType<typeof getProcessJobState> {
  try {
    return await getProcessJobState(jobId)
  } catch (err) {
    logger.warn(
      { jobId, err: sanitizeErrorMessage(err) },
      '[async-cleanup] inspeção da fila falhou — linha pulada (retry próximo run)',
    )
    return null
  }
}

interface PendingOrphanRow {
  id: string
  userId: string
  createdAt: Date
  expiresAt: Date | null
  inputFiles: unknown
}

/**
 * Marca um PENDING órfão como FAILED e estorna a quota (D-4). Idempotente: o
 * estorno só ocorre se a transição `WHERE status='PENDING'` venceu (count===1) —
 * se o worker pegou o job nesse meio-tempo, count===0 e NÃO estorna (anti
 * double-refund / refund de job que será processado). Estorno no período do
 * `createdAt` (não o corrente) pra contabilidade correta cross-mês.
 *
 * NÃO purga inputs aqui — o cron `async-storage-cleanup` (status IN terminal +
 * inputs_purged_at IS NULL) cobre, mantendo o sweeper enxuto.
 *
 * @returns 'failed_refunded' | 'lost_to_worker' (count===0) | 'error' (tx falhou,
 *   rollback — job permanece PENDING, retry no próximo run; best-effort por-linha)
 */
async function failAndRefundPending(
  row: PendingOrphanRow,
  reason: 'ttl_or_queue' | 'invalid_input_meta',
): Promise<'failed_refunded' | 'lost_to_worker' | 'error'> {
  const period = getCurrentPeriod(row.createdAt)
  // F-pack @devops: errorMessage derivada do reason (não mente ao usuário no
  // /process/status — metadata inválida ≠ "expirou na fila").
  const errorMessage =
    reason === 'invalid_input_meta'
      ? 'job não pôde ser processado (dados de entrada inválidos)'
      : 'job não pôde ser processado (expirou na fila)'

  // F-pack @security/@dba: claim PENDING→FAILED + estorno na MESMA transação
  // (ambos DB puro; getProcessJobState/Redis já rodou ANTES, fora). status↔refund
  // atômico → sem janela de "FAILED sem estorno" por crash. Idempotência mantida
  // pelo gate de transição (count===1); concorrência segura (worker é job-only,
  // enqueue/validateAndIncrementUsage é usage-only → sem deadlock cross-lock).
  let outcome: 'failed_refunded' | 'lost_to_worker'
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const claim = await tx.job.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'FAILED', errorMessage, completedAt: new Date() },
      })
      if (claim.count === 0) {
        // O worker venceu a corrida entre o SELECT e o claim — vai processar.
        return 'lost_to_worker' as const
      }
      const refunded = await decrementUsageForPeriod(row.userId, period, tx)
      if (!refunded) {
        // count já 0 / usage ausente — não deveria ocorrer pós-reserva; sinaliza
        // inconsistência de contabilidade (não derruba a tx — o FAILED é correto).
        logger.warn(
          { jobId: row.id, period, metric: 'async.cleanup.refund.noop' },
          '[async-cleanup] estorno não afetou linha (count 0 ou usage ausente?)',
        )
      }
      return 'failed_refunded' as const
    })
  } catch (err) {
    // Erro de DB na tx → rollback de AMBOS (claim + estorno). O job permanece
    // PENDING e será reavaliado no próximo run. Best-effort POR LINHA: uma linha
    // problemática NÃO aborta o batch inteiro (caller trata 'error' como skip).
    logger.error(
      { jobId: row.id, period, err: sanitizeErrorMessage(err) },
      '[async-cleanup] tx de FAILED+estorno falhou (rollback) — retry no próximo run',
    )
    return 'error'
  }

  if (outcome === 'failed_refunded') {
    logger.info(
      {
        jobId: row.id,
        reason,
        period,
        metric: 'async.cleanup.sweep.failed_refunded',
      },
      '[async-cleanup] PENDING órfão marcado FAILED + estornado',
    )
  }
  return outcome
}

// ============================================
// HANDLER 1 — SWEEPER (#197 + 6.7b)
// ============================================

interface SweepResult {
  orphanReenqueued: number
  orphanFailedRefunded: number
  orphanLostToWorker: number
  orphanSkippedInQueue: number
  stuckFailed: number
  stuckSkipped: number
}

/**
 * Fase a) — varre PENDING órfãos da fila e re-enfileira ou FAILED+refund (#197).
 */
async function sweepPendingOrphans(
  lock: LockHandle,
  result: SweepResult,
): Promise<void> {
  const cutoff = new Date(
    Date.now() - env.ASYNC_PENDING_SWEEP_MINUTES * 60 * 1000,
  )
  const queueConfigured = isProcessQueueConfigured()
  const seenIds = new Set<string>()

  while (true) {
    if (!(await lock.heartbeat())) {
      logger.warn(
        { jobName: JOB_NAME_SWEEP },
        'async-cleanup.sweep.heartbeat_lost_aborting',
      )
      break
    }

    const batch = await prisma.job.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        userId: true,
        createdAt: true,
        expiresAt: true,
        inputFiles: true,
      },
    })
    const fresh = batch.filter((r) => !seenIds.has(r.id))
    if (fresh.length === 0) break
    fresh.forEach((r) => seenIds.add(r.id))

    for (const row of fresh) {
      // Cross-check da fila: distingue órfão (ausente) de "ainda na fila".
      const state = await safeGetJobState(row.id)
      if (state === null) {
        // Fila não configurada — inconclusivo. NÃO marca órfão às cegas.
        continue
      }
      if (state.present) {
        // Está na fila (worker só não pegou ainda) — não é órfão.
        result.orphanSkippedInQueue++
        continue
      }

      // Órfão confirmado (ausente da fila). D-4: re-enqueue ou FAILED+refund.
      const meta = jobInputFilesSchema.safeParse(row.inputFiles)
      const withinTtl =
        row.expiresAt !== null &&
        row.expiresAt.getTime() > Date.now() + REENQUEUE_TTL_MARGIN_MS
      const canReenqueue = meta.success && withinTtl && queueConfigured

      if (canReenqueue) {
        try {
          await enqueueProcessJob({ jobId: row.id })
          result.orphanReenqueued++
          logger.info(
            { jobId: row.id, metric: 'async.cleanup.sweep.reenqueued' },
            '[async-cleanup] PENDING órfão re-enfileirado',
          )
          continue
        } catch (err) {
          // Re-enqueue falhou (fila caiu agora) → cai pro FAILED+refund.
          logger.warn(
            { jobId: row.id, err: sanitizeErrorMessage(err) },
            '[async-cleanup] re-enqueue falhou — FAILED+refund',
          )
        }
      }

      const outcome = await failAndRefundPending(
        row,
        meta.success ? 'ttl_or_queue' : 'invalid_input_meta',
      )
      if (outcome === 'failed_refunded') result.orphanFailedRefunded++
      else if (outcome === 'lost_to_worker') result.orphanLostToWorker++
      // 'error' → tx rollback, já logado; não conta (retry no próximo run).
    }

    if (fresh.length < BATCH_SIZE) break
    await sleep(BATCH_SLEEP_MS)
  }
}

/**
 * Fase b) — varre PROCESSING travados e força FAILED (6.7b), sem refund (D-2b).
 */
async function sweepStuckProcessing(
  lock: LockHandle,
  result: SweepResult,
): Promise<void> {
  const cutoff = new Date(
    Date.now() - env.ASYNC_STUCK_PROCESSING_MINUTES * 60 * 1000,
  )
  const seenIds = new Set<string>()

  while (true) {
    if (!(await lock.heartbeat())) break

    const batch = await prisma.job.findMany({
      where: { status: 'PROCESSING', startedAt: { lt: cutoff } },
      orderBy: { startedAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, userId: true, startedAt: true },
    })
    const fresh = batch.filter((r) => !seenIds.has(r.id))
    if (fresh.length === 0) break
    fresh.forEach((r) => seenIds.add(r.id))

    for (const row of fresh) {
      const state = await safeGetJobState(row.id)
      if (state === null) {
        // Fila não configurada — inconclusivo, não força.
        result.stuckSkipped++
        continue
      }
      // Só força FAILED se ausente da fila OU terminal nela. Qualquer estado
      // ativo/desconhecido → conservador (BullMQ ainda gerencia; anti R-1).
      const shouldFail =
        !state.present ||
        (state.state !== undefined && TERMINAL_QUEUE_STATES.has(state.state))
      if (!shouldFail) {
        result.stuckSkipped++
        continue
      }

      const failed = await prisma.job.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          errorMessage: 'job interrompido (worker indisponível)',
          completedAt: new Date(),
        },
      })
      if (failed.count === 1) {
        result.stuckFailed++
        logger.warn(
          {
            jobId: row.id,
            queueState: state.present ? state.state : 'absent',
            metric: 'async.cleanup.stuck.failed',
          },
          '[async-cleanup] PROCESSING travado marcado FAILED',
        )
      }
    }

    if (fresh.length < BATCH_SIZE) break
    await sleep(BATCH_SLEEP_MS)
  }
}

/**
 * Handler do cron `async-job-sweeper` (#197 + 6.7b). Ver doc do módulo.
 */
export async function sweepOrphanJobs(lock: LockHandle): Promise<void> {
  const result: SweepResult = {
    orphanReenqueued: 0,
    orphanFailedRefunded: 0,
    orphanLostToWorker: 0,
    orphanSkippedInQueue: 0,
    stuckFailed: 0,
    stuckSkipped: 0,
  }

  if (env.CRON_DRY_RUN) {
    // ALERTABLE_IN_PROD_ONLY: dry-run em prod = recuperação de quota desligada.
    emitSchedulerEvent({
      level: 'info',
      event: 'cron.async_cleanup.dry_run.start',
      jobName: JOB_NAME_SWEEP,
      context: {},
    })
    const cutoffPending = new Date(
      Date.now() - env.ASYNC_PENDING_SWEEP_MINUTES * 60 * 1000,
    )
    const cutoffStuck = new Date(
      Date.now() - env.ASYNC_STUCK_PROCESSING_MINUTES * 60 * 1000,
    )
    const [pending, stuck] = await Promise.all([
      prisma.job.count({
        where: { status: 'PENDING', createdAt: { lt: cutoffPending } },
      }),
      prisma.job.count({
        where: { status: 'PROCESSING', startedAt: { lt: cutoffStuck } },
      }),
    ])
    logger.info(
      {
        jobName: JOB_NAME_SWEEP,
        dryRun: true,
        wouldScanPending: pending,
        wouldScanStuck: stuck,
      },
      `[DRY_RUN] sweeper veria ${pending} PENDING + ${stuck} PROCESSING candidatos`,
    )
    return
  }

  try {
    await sweepPendingOrphans(lock, result)
    await sweepStuckProcessing(lock, result)
  } catch (err) {
    Sentry.captureException(err, {
      tags: { jobName: JOB_NAME_SWEEP },
      extra: { ...result } as Record<string, unknown>,
    })
    throw err
  }

  // Gauges separados (@devops MÉDIO): auto-cura (reenqueued) vs serviço perdido
  // (failed-refunded) têm significados operacionais distintos.
  setAsyncCleanupCount('orphan-reenqueued', result.orphanReenqueued)
  setAsyncCleanupCount('orphan-failed-refunded', result.orphanFailedRefunded)
  setAsyncCleanupCount('stuck-processing', result.stuckFailed)

  // #197 sinal PRIMÁRIO: órfão PERDIDO (FAILED+estornado) = cliente não recebeu
  // o que reservou → on-call investiga o enqueue path. ALERTABLE.
  if (result.orphanFailedRefunded > 0) {
    emitSchedulerEvent({
      level: 'warning',
      event: 'cron.async_cleanup.orphan_failed_refunded',
      jobName: JOB_NAME_SWEEP,
      context: {
        orphanFailedRefunded: result.orphanFailedRefunded,
        orphanReenqueued: result.orphanReenqueued,
      },
    })
  }

  if (result.stuckFailed > 0) {
    emitSchedulerEvent({
      level: 'warning',
      event: 'cron.async_cleanup.stuck_failed',
      jobName: JOB_NAME_SWEEP,
      context: { stuckFailed: result.stuckFailed },
    })
  }

  logger.info(
    { jobName: JOB_NAME_SWEEP, ...result },
    'async-cleanup.sweep.completed',
  )
}

// ============================================
// HANDLER 2 — STORAGE CLEANUP (6.7a)
// ============================================

interface StorageResult {
  inputsJobsPurged: number
  inputsJobsPartial: number
  inputsUnparseable: number
  outputsPurged: number
  outputsSkippedBadFormat: number
}

interface TerminalInputsRow {
  id: string
  userId: string
  createdAt: Date
  inputFiles: unknown
}

/**
 * Fase a) — purga inputs de terminais não purgados (M-03 / D-3).
 */
async function purgeTerminalInputs(
  lock: LockHandle,
  storage: NonNullable<ReturnType<typeof getStorageAdapter>>,
  result: StorageResult,
): Promise<void> {
  const seenIds = new Set<string>()

  while (true) {
    if (!(await lock.heartbeat())) {
      logger.warn(
        { jobName: JOB_NAME_STORAGE },
        'async-cleanup.storage.inputs.heartbeat_lost_aborting',
      )
      break
    }

    const batch = await prisma.job.findMany({
      where: {
        status: { in: ['COMPLETED', 'FAILED'] },
        inputsPurgedAt: null,
      },
      orderBy: { completedAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, userId: true, createdAt: true, inputFiles: true },
    })
    const fresh = (batch as TerminalInputsRow[]).filter(
      (r) => !seenIds.has(r.id),
    )
    if (fresh.length === 0) break
    fresh.forEach((r) => seenIds.add(r.id))

    for (const row of fresh) {
      const meta = jobInputFilesSchema.safeParse(row.inputFiles)
      if (!meta.success) {
        // inputFiles ilegível (DB corrompido / write divergente). NÃO trava o
        // batch; deixa inputs_purged_at NULL e alerta (R-6). Não dá pra
        // enumerar os paths sem o metadata.
        result.inputsUnparseable++
        logger.error(
          { jobId: row.id, metric: 'async.cleanup.inputfiles_unparseable' },
          '[async-cleanup] inputFiles ilegível — purga de inputs pulada',
        )
        continue
      }

      let removed = 0
      const total = meta.data.files.length
      for (const f of meta.data.files) {
        try {
          await storage.removeByPath(
            buildJobInputPath({
              userId: row.userId,
              jobId: row.id,
              index: f.index,
              ext: f.ext as AllowedExtension,
              now: row.createdAt,
            }),
          )
          removed++
        } catch (err) {
          logger.warn(
            { jobId: row.id, index: f.index, err: sanitizeErrorMessage(err) },
            '[async-cleanup] remove de input falhou — próximo run reprocessa',
          )
        }
      }

      // M-03: só seta inputs_purged_at se TODOS saíram; parcial fica NULL.
      if (total > 0 && removed === total) {
        await prisma.job.update({
          where: { id: row.id },
          data: { inputsPurgedAt: new Date() },
        })
        result.inputsJobsPurged++
      } else {
        result.inputsJobsPartial++
      }
    }

    if (fresh.length < BATCH_SIZE) break
    await sleep(BATCH_SLEEP_MS)
  }
}

interface ExpiredOutputRow {
  id: string
  userId: string
  createdAt: Date
  outputFormat: string | null
}

/**
 * Fase b) — purga outputs expirados não baixados (A-4) + tombstone.
 */
async function purgeExpiredOutputs(
  lock: LockHandle,
  storage: NonNullable<ReturnType<typeof getStorageAdapter>>,
  result: StorageResult,
): Promise<void> {
  const seenIds = new Set<string>()

  while (true) {
    if (!(await lock.heartbeat())) break

    const batch = await prisma.job.findMany({
      where: {
        expiresAt: { lt: new Date() },
        downloadedAt: null,
        outputFileUrl: { not: null },
      },
      orderBy: { expiresAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, userId: true, createdAt: true, outputFormat: true },
    })
    const fresh = (batch as ExpiredOutputRow[]).filter(
      (r) => !seenIds.has(r.id),
    )
    if (fresh.length === 0) break
    fresh.forEach((r) => seenIds.add(r.id))

    for (const row of fresh) {
      const ext = row.outputFormat
      if (ext !== 'csv' && ext !== 'xlsx') {
        // Output presente mas formato inconsistente — não dá pra montar o path
        // (precisaria do ext). Quase-dead-code: o CHECK jobs_output_format_check
        // restringe output_format a {xlsx,csv} ou NULL; só dispara com escrita
        // inconsistente do worker. Loga forense (@security/@dba BAIXO — PII órfã)
        // p/ reconciliação bucket-wide manual e tombstona (evita re-scan eterno).
        result.outputsSkippedBadFormat++
        logger.error(
          {
            jobId: row.id,
            userId: row.userId,
            metric: 'async.cleanup.output_bad_format_orphan',
          },
          '[async-cleanup] output com formato inválido — não purgável via path; órfão de Storage registrado p/ reconciliação',
        )
        await prisma.job.update({
          where: { id: row.id },
          data: { outputFileUrl: null },
        })
        continue
      }

      try {
        await storage.removeByPath(
          buildJobOutputPath({
            userId: row.userId,
            jobId: row.id,
            ext,
            now: row.createdAt,
          }),
        )
      } catch (err) {
        // Erro real de Storage (não-404) — deixa outputFileUrl pro próximo run.
        logger.warn(
          { jobId: row.id, err: sanitizeErrorMessage(err) },
          '[async-cleanup] remove de output falhou — próximo run reprocessa',
        )
        continue
      }

      // Tombstone: zera outputFileUrl pra não re-escanear (A-4).
      await prisma.job.update({
        where: { id: row.id },
        data: { outputFileUrl: null },
      })
      result.outputsPurged++
    }

    if (fresh.length < BATCH_SIZE) break
    await sleep(BATCH_SLEEP_MS)
  }
}

/**
 * Handler do cron `async-storage-cleanup` (6.7a). Ver doc do módulo.
 */
export async function purgeAsyncJobStorage(lock: LockHandle): Promise<void> {
  const result: StorageResult = {
    inputsJobsPurged: 0,
    inputsJobsPartial: 0,
    inputsUnparseable: 0,
    outputsPurged: 0,
    outputsSkippedBadFormat: 0,
  }

  if (env.CRON_DRY_RUN) {
    // ALERTABLE_IN_PROD_ONLY: dry-run em prod = purga de PII desligada.
    emitSchedulerEvent({
      level: 'info',
      event: 'cron.async_cleanup.dry_run.start',
      jobName: JOB_NAME_STORAGE,
      context: {},
    })
    const [inputs, outputs] = await Promise.all([
      prisma.job.count({
        where: {
          status: { in: ['COMPLETED', 'FAILED'] },
          inputsPurgedAt: null,
        },
      }),
      prisma.job.count({
        where: {
          expiresAt: { lt: new Date() },
          downloadedAt: null,
          outputFileUrl: { not: null },
        },
      }),
    ])
    logger.info(
      {
        jobName: JOB_NAME_STORAGE,
        dryRun: true,
        wouldPurgeInputs: inputs,
        wouldPurgeOutputs: outputs,
      },
      `[DRY_RUN] storage cleanup veria ${inputs} jobs c/ inputs + ${outputs} outputs expirados`,
    )
    return
  }

  const storage = getStorageAdapter()
  if (!storage) {
    // Em prod o boot garante Storage quando async on; chegar aqui = misconfig.
    logger.error(
      { jobName: JOB_NAME_STORAGE },
      'async-cleanup.storage.adapter_unavailable',
    )
    return
  }

  try {
    await purgeTerminalInputs(lock, storage, result)
    await purgeExpiredOutputs(lock, storage, result)
  } catch (err) {
    Sentry.captureException(err, {
      tags: { jobName: JOB_NAME_STORAGE },
      extra: { ...result } as Record<string, unknown>,
    })
    throw err
  }

  // Gauge: terminais ainda com inputs por purgar (converge a 0 em operação normal).
  const pending = await prisma.job.count({
    where: { status: { in: ['COMPLETED', 'FAILED'] }, inputsPurgedAt: null },
  })
  setAsyncCleanupCount('storage-purge-pending', pending)
  if (pending > 1000) {
    emitSchedulerEvent({
      level: 'warning',
      event: 'cron.async_cleanup.purge_pending_overdue',
      jobName: JOB_NAME_STORAGE,
      context: { pendingCount: pending, threshold: 1000 },
    })
  }

  if (result.inputsUnparseable > 0) {
    emitSchedulerEvent({
      level: 'error',
      event: 'cron.async_cleanup.inputfiles_unparseable',
      jobName: JOB_NAME_STORAGE,
      context: { count: result.inputsUnparseable },
    })
  }

  logger.info(
    { jobName: JOB_NAME_STORAGE, ...result, pendingAfter: pending },
    'async-cleanup.storage.completed',
  )
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  JOB_NAME_SWEEP,
  JOB_NAME_STORAGE,
  BATCH_SIZE,
  BATCH_SLEEP_MS,
  REENQUEUE_TTL_MARGIN_MS,
  TERMINAL_QUEUE_STATES,
  failAndRefundPending,
  sweepPendingOrphans,
  sweepStuckProcessing,
  purgeTerminalInputs,
  purgeExpiredOutputs,
}
