/**
 * Handler do worker de processamento assíncrono (Card 6.4 — núcleo).
 *
 * Recebe um `jobId`, recarrega o `Job` do Postgres (fonte da verdade) e executa
 * o pipeline LRO: claim atômico → download dos inputs → parse isolado (thread) →
 * validações de plano (SSOT) → merge → upload do output → COMPLETED → purge.
 *
 * Desacoplado do BullMQ de propósito (testável sem Redis): o bootstrap
 * (`src/worker.ts`, Fase 4) extrai `jobId/attempt/maxAttempts` do job do BullMQ
 * e chama `processJob`. A classificação de erro decide se BullMQ deve retentar.
 *
 * INVARIANTES (do plano / bindings do 6.3):
 *  - B-6.4.2: claim aceita só PENDING|PROCESSING (rejeita terminal COMPLETED/
 *    FAILED) → late-enqueue de job compensado vira no-op idempotente.
 *  - B-6.4.3: paths reconstruídos SÓ via key-builder ancorado em `Job.createdAt`.
 *  - B-6.4.4: extensão lida do metadata (`inputFiles.files[].ext`); o parser
 *    recebe um fileName SINTÉTICO (anti-spoofing de extensão pelo nome do user).
 *  - C-1: o worker NÃO toca em `usage` (quota já reservada no enqueue/6.3).
 *
 * @owner: @planner + @security + @reviewer
 * @card: 6.4
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import type { Redis } from 'ioredis'
import { prisma } from '../prisma'
import { env } from '../../config/env'
import { logger } from '../logger'
import { Sentry } from '../../config/sentry'
import { AppError, Errors } from '../../errors/app-error'
import { sanitizeErrorMessage } from '../sanitize-error'
import { getStorageAdapter } from '../storage'
import { buildJobInputPath } from '../storage/key-builder'
import {
  type ParsedSpreadsheet,
  type OutputFormat,
  validateColumns,
  mergeSpreadsheets,
  generateOutputFile,
} from '../spreadsheet'
import {
  parseInWorkerThread,
  ParseTimeoutError,
} from '../spreadsheet/parse-in-thread'
import {
  validateColumnCount,
  validateRowLimits,
} from '../../modules/process/process.service'
import { ASYNC_FILE_SIZE_LIMIT } from '../../modules/process/process-async.service'
import {
  PROCESS_QUEUE_NAME,
  DEFAULT_PROCESS_JOB_OPTIONS,
  type ProcessJobPayload,
} from './process-queue'
import {
  jobInputFilesSchema,
  type JobInputFileMeta,
} from '../../modules/process/process-async.input-files.schema'

export interface ProcessJobArgs {
  jobId: string
  /** Tentativa atual (1-based) — vem do BullMQ (`attemptsMade + 1`). */
  attempt: number
  /** Máximo de tentativas configurado na fila. */
  maxAttempts: number
  /** Timeout duro do parse por arquivo (ms). */
  timeoutMs: number
}

export type ProcessJobOutcome = {
  status: 'completed' | 'failed' | 'skipped'
  jobId: string
}

/**
 * Erro é PERMANENTE (não adianta retentar) quando é determinístico no input:
 *  - AppError: validação de colunas/linhas/formato, storage indisponível (config).
 *  - ParseTimeoutError: parse travado (ReDoS / arquivo crafted) — retry re-trava.
 * Qualquer outro (storage 5xx, rede, DB) é TRANSIENTE → BullMQ retenta.
 */
function isPermanent(err: unknown): boolean {
  // OOM do worker_thread (xlsx crafted que estoura o heap) é DETERMINÍSTICO —
  // retry só re-OOMa e queima compute pago. `ERR_WORKER_OUT_OF_MEMORY` chega via
  // `worker.once('error')` → runInThread rejeita com esse Error (@security/@devops
  // ALTO). Tratamos como permanente pra cair direto em FAILED sem retry-loop.
  if (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
  ) {
    return true
  }
  return err instanceof AppError || err instanceof ParseTimeoutError
}

/** Catálogo de mensagens genéricas (R-6 — nunca vaza path/stack/detalhe interno). */
function toUserMessage(err: unknown): string {
  if (err instanceof ParseTimeoutError) {
    return 'O processamento excedeu o tempo limite. O arquivo pode ser muito grande ou complexo.'
  }
  if (err instanceof AppError) {
    return 'Não foi possível processar os arquivos: formato inválido, colunas ausentes ou limite de linhas excedido.'
  }
  return 'Falha no processamento. Tente novamente mais tarde.'
}

/**
 * Purga best-effort os inputs do Storage. Conta os removidos com sucesso —
 * `inputsPurgedAt` só é setado se TODOS saíram (espelha M-03 da saga 6.3);
 * parciais ficam NULL pro cron 6.7 reprocessar (anti órfão permanente de PII).
 */
async function purgeJobInputs(args: {
  storage: NonNullable<ReturnType<typeof getStorageAdapter>>
  userId: string
  jobId: string
  createdAt: Date
  files: JobInputFileMeta[]
}): Promise<{ removed: number; total: number }> {
  const { storage, userId, jobId, createdAt, files } = args
  let removed = 0
  for (const f of files) {
    try {
      await storage.removeByPath(
        buildJobInputPath({
          userId,
          jobId,
          index: f.index,
          ext: f.ext,
          now: createdAt,
        }),
      )
      removed++
    } catch (err) {
      logger.warn(
        { jobId, index: f.index, err: sanitizeErrorMessage(err) },
        '[worker] purge de input falhou — cron 6.7 recupera',
      )
    }
  }
  return { removed, total: files.length }
}

/**
 * Processa um job async. Idempotente e seguro contra retry/late-enqueue.
 *
 * @returns outcome ('completed' | 'skipped'); em falha LANÇA (permanente →
 *   UnrecoverableError, BullMQ não retenta; transiente → Error, BullMQ retenta).
 */
export async function processJob(
  args: ProcessJobArgs,
): Promise<ProcessJobOutcome> {
  const { jobId, attempt, maxAttempts, timeoutMs } = args

  // 1. Claim atômico (B-6.4.2): só PENDING|PROCESSING. Terminal → no-op.
  const claim = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['PENDING', 'PROCESSING'] } },
    data: { status: 'PROCESSING', startedAt: new Date() },
  })
  if (claim.count === 0) {
    logger.info(
      { jobId, metric: 'worker.job.skipped' },
      '[worker] job não-claimável (terminal ou inexistente) — ack idempotente',
    )
    return { status: 'skipped', jobId }
  }

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      userId: true,
      createdAt: true,
      inputFiles: true,
      outputFormat: true,
    },
  })
  const { userId, createdAt } = job

  // Hoisted pra ficarem acessíveis no catch (purge). `files` fica [] se o
  // read-back do inputFiles falhar → purge no-op (sem paths; 6.7 limpa órfãos).
  const storage = getStorageAdapter()
  let files: JobInputFileMeta[] = []

  try {
    if (!storage) {
      // Misconfig (prod garante Storage no boot) — permanente, retry não cura.
      throw Errors.internal(
        'Storage indisponível para o worker de processamento',
      )
    }

    // 2. Read-back validado do inputFiles (não confia no shape do DB).
    const parsedInput = jobInputFilesSchema.safeParse(job.inputFiles)
    if (!parsedInput.success) {
      throw Errors.validationError(
        'inputFiles do job inválido (shape inesperado)',
      )
    }
    files = parsedInput.data.files
    const { selectedColumns } = parsedInput.data
    validateColumnCount(selectedColumns)

    const outputFormat = job.outputFormat
    if (outputFormat !== 'csv' && outputFormat !== 'xlsx') {
      throw Errors.validationError('outputFormat do job inválido')
    }

    // 3. Download + parse (isolado em thread, com timeout duro) + validações.
    const parsedSheets: ParsedSpreadsheet[] = []
    for (const f of files) {
      const path = buildJobInputPath({
        userId,
        jobId,
        index: f.index,
        ext: f.ext,
        now: createdAt,
      })
      const { buffer } = await storage.downloadByPath(path)
      // Defense in depth (@security a90f3b): revalida o tamanho do conteúdo
      // baixado contra o cap do async — não confia que o 6.3/bucket respeitaram
      // o limite no enqueue. Permanente (não adianta retentar conteúdo grande).
      if (buffer.length > ASYNC_FILE_SIZE_LIMIT) {
        throw Errors.validationError(
          'Arquivo de input excede o limite permitido',
        )
      }
      // fileName sintético dirigido pela ext do metadata (B-6.4.4) — o nome do
      // usuário NÃO governa o parse (anti-spoofing de extensão).
      const syntheticName = `input-${String(f.index).padStart(2, '0')}.${f.ext}`
      const sheet = await parseInWorkerThread(buffer, syntheticName, timeoutMs)
      validateColumns(sheet.headers, selectedColumns, syntheticName)
      parsedSheets.push(sheet)
    }
    validateRowLimits(parsedSheets)

    // 4. Merge + gera output.
    const merged = mergeSpreadsheets(parsedSheets, selectedColumns)
    const output = generateOutputFile(merged, outputFormat as OutputFormat)

    // 5. Upload do output (idempotente, upsert:true — D-7).
    const { path: outputPath } = await storage.uploadJobOutput({
      userId,
      jobId,
      ext: outputFormat,
      buffer: output.buffer,
      contentType: output.mimeType,
      createdAt,
    })

    // 6. COMPLETED — write GUARDADO por status (@dba ALTO): `updateMany WHERE
    //    status='PROCESSING'` torna o PRIMEIRO escritor terminal o vencedor.
    //    Sob double-claim concorrente (BullMQ stalled re-delivery), count===0
    //    significa que outro executor já finalizou → no-op idempotente (não
    //    sobrescreve nem purga). Padrão consagrado no Card #189. outputSize em
    //    BigInt (coluna BIGINT, anti foot-gun int4).
    const completed = await prisma.job.updateMany({
      where: { id: jobId, status: 'PROCESSING' },
      data: {
        status: 'COMPLETED',
        outputFormat,
        outputSize: BigInt(output.buffer.length),
        outputFileUrl: outputPath,
        completedAt: new Date(),
      },
    })
    if (completed.count === 0) {
      logger.warn(
        { jobId, metric: 'worker.job.terminal_skip' },
        '[worker] job já finalizado por outro executor — COMPLETED no-op',
      )
      return { status: 'skipped', jobId }
    }

    // 7. Purge dos inputs (best-effort). inputsPurgedAt só se todos saíram (M-03).
    const purge = await purgeJobInputs({
      storage,
      userId,
      jobId,
      createdAt,
      files,
    })
    if (purge.total > 0 && purge.removed === purge.total) {
      await prisma.job.update({
        where: { id: jobId },
        data: { inputsPurgedAt: new Date() },
      })
    }

    logger.info(
      {
        jobId,
        userId,
        files: purge.total,
        rows: merged.totalRows,
        // R-1: pico de memória pós-parse — alerta de aproximação do teto do
        // Fly (256MB) antes de virar OOM kill.
        rssBytes: process.memoryUsage().rss,
        metric: 'worker.job.completed',
      },
      '[worker] job concluído',
    )
    return { status: 'completed', jobId }
  } catch (err) {
    const permanent = isPermanent(err)
    const lastAttempt = attempt >= maxAttempts

    // Transiente que ainda tem retry: NÃO marca FAILED nem purga (preserva os
    // inputs pro reprocesso). Deixa status PROCESSING e relança → BullMQ retenta;
    // o próximo claim aceita PROCESSING (B-6.4.2).
    if (!permanent && !lastAttempt) {
      logger.warn(
        {
          jobId,
          userId,
          attempt,
          maxAttempts,
          metric: 'worker.job.retry',
          err: sanitizeErrorMessage(err),
        },
        '[worker] falha transiente — BullMQ vai retentar',
      )
      throw err instanceof Error ? err : new Error('transient worker failure')
    }

    // Permanente OU última tentativa: marca FAILED + purga + reporta. Se o
    // storage estiver indisponível (misconfig), purge é no-op (0/0).
    const purge = storage
      ? await purgeJobInputs({ storage, userId, jobId, createdAt, files })
      : { removed: 0, total: 0 }
    // FAILED GUARDADO por status (@dba ALTO): não sobrescreve um terminal já
    // escrito por outro executor concorrente (evita regressão COMPLETED→FAILED).
    const failed = await prisma.job.updateMany({
      where: { id: jobId, status: 'PROCESSING' },
      data: {
        status: 'FAILED',
        errorMessage: toUserMessage(err),
        completedAt: new Date(),
        inputsPurgedAt:
          purge.total > 0 && purge.removed === purge.total ? new Date() : null,
      },
    })
    if (failed.count === 0) {
      // Outro executor já finalizou (terminal) — não regride o estado. Ack
      // idempotente (não relança: o trabalho já está resolvido no DB).
      logger.warn(
        { jobId, metric: 'worker.job.terminal_skip' },
        '[worker] job já finalizado por outro executor — FAILED no-op',
      )
      return { status: 'skipped', jobId }
    }

    logger.error(
      {
        jobId,
        userId,
        permanent,
        attempt,
        metric: 'worker.job.failed',
        err: sanitizeErrorMessage(err),
      },
      '[worker] job FAILED',
    )
    // Sentry enxuto (@security 5e7c1f): pra AppError (validação) enviamos só o
    // code — `details` carrega dados de domínio (ex: nomes de colunas). Pra erro
    // genuíno (bug/infra) enviamos o erro completo (stack é essencial pra debug).
    const reportErr =
      err instanceof AppError ? new Error(`AppError:${err.code}`) : err
    Sentry.captureException(reportErr, {
      tags: { component: 'process-worker' },
      extra: { jobId },
      user: { id: userId },
    })

    // Permanente → UnrecoverableError (BullMQ não retenta). Transiente na última
    // tentativa → relança o erro original (BullMQ marca failed sem novo retry).
    if (permanent) {
      throw new UnrecoverableError(toUserMessage(err))
    }
    throw err instanceof Error ? err : new Error('worker failure')
  }
}

/**
 * Cria o BullMQ `Worker` que consome a fila e delega ao `processJob`.
 *
 * Recebe a `connection` por PARÂMETRO porque:
 *  - no processo worker (`src/worker.ts`) a conexão é exclusiva deste consumidor
 *    (não há `Queue` produtora no mesmo processo); o BullMQ ainda duplica a
 *    conexão internamente pros comandos blocking (BRPOPLPUSH);
 *  - testes de integração apontam pra um Redis efêmero (container) sem depender
 *    da `REDIS_URL` (que exige `rediss://` TLS).
 *
 * `concurrency: 1` (decisão D-2 / R-1): processamento sequencial limita o pico
 * de memória no Fly 256MB.
 *
 * **lock / stalled (@devops MÉDIO):** `mergeSpreadsheets`/`generateOutputFile`
 * rodam no event loop (só o parse é isolado em thread) e podem segurá-lo por
 * datasets grandes. `lockDuration` folgado (60s) evita o BullMQ marcar o job
 * como stalled e re-entregá-lo (double-process). `maxStalledCount: 2` tolera 1
 * restart de deploy (SIGKILL) sem matar job legítimo prematuramente.
 */
const WORKER_LOCK_DURATION_MS = 60_000
const WORKER_STALLED_INTERVAL_MS = 30_000
const WORKER_MAX_STALLED_COUNT = 2

export function createProcessWorker(
  connection: Redis,
): Worker<ProcessJobPayload, ProcessJobOutcome> {
  return new Worker<ProcessJobPayload, ProcessJobOutcome>(
    PROCESS_QUEUE_NAME,
    async (job: Job<ProcessJobPayload>) =>
      processJob({
        jobId: job.data.jobId,
        attempt: job.attemptsMade + 1,
        maxAttempts:
          job.opts.attempts ?? DEFAULT_PROCESS_JOB_OPTIONS.attempts ?? 3,
        timeoutMs: env.PROCESS_WORKER_TIMEOUT_MS,
      }),
    {
      connection,
      concurrency: 1,
      lockDuration: WORKER_LOCK_DURATION_MS,
      stalledInterval: WORKER_STALLED_INTERVAL_MS,
      maxStalledCount: WORKER_MAX_STALLED_COUNT,
    },
  )
}
