/**
 * Async processing service — Card 6.3 (Fase 6 — Fila Assíncrona).
 *
 * Coração do caminho LRO. Recebe os arquivos já parseados do multipart (pelo
 * controller), reserva quota atômica, cria o `Job`, sobe os inputs no Storage
 * e enfileira no BullMQ. Retorna o DTO do 202. O worker (6.4) processa depois.
 *
 * **Saga de compensação:** a reserva de quota acontece ANTES da saga (se
 * estourar o plano, nada foi criado). A partir da reserva bem-sucedida, QUALQUER
 * falha (create Job / upload / enqueue) compensa: estorna a quota, marca o Job
 * FAILED e remove os inputs já subidos. Isso materializa a decisão fechada:
 * falha de INFRA (pré-aceitação) devolve a quota — distinto do A-REFUND (falha
 * de PROCESSAMENTO no worker NÃO devolve).
 *
 * **Anti-bypass (A-QUOTA/D-3):** quota reservada no ENQUEUE (aqui), não no
 * worker — senão mass-enqueue burlaria o limite.
 *
 * @owner: @planner + @dba + @security
 * @card: 6.3
 */
import { Prisma, type Plan } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { sanitizeErrorMessage } from '../../lib/sanitize-error'
import { AppError, Errors } from '../../errors/app-error'
import { env } from '../../config/env'
import { PRO_LIMITS } from '../../config/plan-limits'
import { getStorageAdapter, type StorageAdapter } from '../../lib/storage'
import {
  ALLOWED_EXTENSIONS,
  EXTENSION_TO_MIME,
  type AllowedExtension,
} from '../../lib/storage/types'
import { buildJobInputPath } from '../../lib/storage/key-builder'
import {
  enqueueProcessJob,
  QueueUnavailableError,
} from '../../lib/queue/process-queue'
import {
  decrementUsage,
  validateAndIncrementUsage,
} from '../usage/usage.service'
import type {
  ProcessAsyncInput,
  ProcessAsyncResponse,
} from './process-async.schema'

/**
 * Cap de bytes POR ARQUIVO no async (A-LIMITS): 30MB, elevado vs 2MB do sync
 * pra permitir um arquivo grande. O teto cumulativo (`PRO_LIMITS.maxTotalSize`,
 * 30MB) é enforçado INCREMENTALMENTE na coleta multipart (collect helper) — sem
 * isso, 15 arquivos no limite individual bufferizariam ~450MB em RAM antes de
 * qualquer reject (OOM/DoS, @security F-1). Aqui revalidamos o total como
 * defense in depth (o service não confia no caller). O teto anti-DoS de
 * conteúdo é LINHAS (75k), validado no worker após o parse.
 */
export const ASYNC_FILE_SIZE_LIMIT = 30 * 1024 * 1024

/**
 * Timeout do enqueue. Com `lazyConnect` + `maxRetriesPerRequest:null`, um Redis
 * inalcançável faria `queue.add()` pendurar a request. O race converte isso em
 * 503 rápido (QueueUnavailableError → Errors.queueUnavailable).
 */
const ENQUEUE_TIMEOUT_MS = 5_000

export interface AsyncJobFile {
  buffer: Buffer
  fileName: string
}

export interface CreateAsyncJobParams {
  /** userId do JWT (NUNCA do body) — ownership. */
  userId: string
  /** Plano do JWT pra resolver o limite de quota. */
  plan: Plan | 'FREE'
  files: AsyncJobFile[]
  input: ProcessAsyncInput
}

/**
 * Shape do `Job.inputFiles` (Json) — o worker (6.4) lê daqui pra reconstruir
 * os paths (`buildJobInputPath` a partir de userId+jobId+index+ext) e saber
 * quais colunas extrair. NÃO guarda bytes, só metadados.
 */
interface AsyncInputFileMeta {
  index: number
  fileName: string
  ext: AllowedExtension
  size: number
}
interface AsyncJobInputFiles {
  files: AsyncInputFileMeta[]
  selectedColumns: string[]
}

/**
 * Extrai a extensão storage-safe (sem ponto) do filename e valida contra a
 * whitelist. O controller já validou na borda; revalidamos (defense in depth,
 * o service não confia no caller).
 */
function resolveStorageExt(fileName: string): AllowedExtension {
  const dot = fileName.lastIndexOf('.')
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw Errors.validationError(
      `Formato de arquivo não suportado: ${fileName}`,
      { validFormats: [...ALLOWED_EXTENSIONS] },
    )
  }
  return ext as AllowedExtension
}

/** Enqueue com timeout — não pendura a request se o Redis estiver inalcançável. */
async function enqueueWithTimeout(jobId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new QueueUnavailableError()),
      ENQUEUE_TIMEOUT_MS,
    )
  })
  try {
    await Promise.race([enqueueProcessJob({ jobId }), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Compensação da saga. SEMPRE best-effort: loga falhas, nunca propaga (o erro
 * original do caller é o que importa). Ordem: estorna quota → remove inputs
 * subidos → marca Job FAILED.
 */
async function compensateFailedJob(args: {
  userId: string
  jobId: string | null
  /** Âncora temporal do path — `Job.createdAt`. null se o Job nem foi criado. */
  createdAt: Date | null
  prepared: { index: number; ext: AllowedExtension }[]
  uploadedCount: number
  storage: StorageAdapter
}): Promise<void> {
  const { userId, jobId, createdAt, prepared, uploadedCount, storage } = args

  // 1. Estorna a quota reservada (falha de infra ≠ serviço prestado).
  try {
    const refunded = await decrementUsage(userId)
    if (!refunded) {
      logger.warn(
        { userId, jobId, metric: 'async.refund.noop' },
        '[async] estorno de quota não afetou linha (count já 0?)',
      )
    }
  } catch (err) {
    logger.error(
      { userId, jobId, err: sanitizeErrorMessage(err) },
      '[async] estorno de quota falhou — pode haver slot perdido',
    )
  }

  // 2. Remove os inputs já subidos (evita lixo órfão no Storage). uploadedCount>0
  //    só ocorre após jobId setado — guard externo satisfaz o type narrowing.
  //    Conta os removes BEM-SUCEDIDOS pra decidir o inputsPurgedAt (M-03): só
  //    marcamos purgado se TODOS saíram; senão deixamos NULL pro cron 6.7
  //    reprocessar os que sobraram (senão `WHERE inputs_purged_at IS NULL`
  //    pularia órfão permanente — custo + resíduo de PII/LGPD).
  let removedCount = 0
  if (jobId !== null && createdAt !== null) {
    const currentJobId = jobId
    for (let i = 0; i < uploadedCount; i++) {
      const p = prepared[i]
      try {
        await storage.removeByPath(
          buildJobInputPath({
            userId,
            jobId: currentJobId,
            index: p.index,
            ext: p.ext,
            now: createdAt,
          }),
        )
        removedCount++
      } catch (err) {
        logger.warn(
          {
            userId,
            jobId: currentJobId,
            index: p.index,
            err: sanitizeErrorMessage(err),
          },
          '[async] cleanup de input órfão falhou — cron 6.7 recupera',
        )
      }
    }
  }

  // 3. Marca o Job FAILED (se chegou a ser criado). inputsPurgedAt só é setado
  //    quando TODOS os inputs subidos foram removidos com sucesso — caso
  //    contrário fica NULL pro cron 6.7 reprocessar (M-03).
  if (jobId) {
    const allInputsPurged = uploadedCount > 0 && removedCount === uploadedCount
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: 'enqueue/upload failed before processing',
          completedAt: new Date(),
          inputsPurgedAt: allInputsPurged ? new Date() : null,
        },
      })
    } catch (err) {
      logger.error(
        {
          userId,
          jobId,
          err: sanitizeErrorMessage(err),
        },
        '[async] marcação de Job FAILED falhou',
      )
    }
  }
}

/**
 * Cria um job de processamento assíncrono. Ver doc do módulo pra a saga.
 *
 * @throws {AppError} limitExceeded (400, quota/limites), queueUnavailable (503),
 *   validationError (400), processingFailed (500).
 */
export async function createAsyncJob(
  params: CreateAsyncJobParams,
): Promise<ProcessAsyncResponse> {
  const { userId, plan, files, input } = params

  // 1. Validação estrutural (defense in depth — controller validou na borda).
  if (files.length === 0) {
    throw Errors.validationError('Nenhum arquivo enviado')
  }
  if (files.length > PRO_LIMITS.maxInputFiles) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.maxInputFiles} arquivos por unificação`,
      `${files.length} enviados`,
    )
  }

  let totalBytes = 0
  const prepared = files.map((f, index) => {
    const ext = resolveStorageExt(f.fileName)
    if (f.buffer.length > ASYNC_FILE_SIZE_LIMIT) {
      throw Errors.limitExceeded(
        '30MB por arquivo',
        `${f.buffer.length} bytes`,
        f.fileName,
      )
    }
    totalBytes += f.buffer.length
    return { buffer: f.buffer, fileName: f.fileName, ext, index }
  })
  if (totalBytes > PRO_LIMITS.maxTotalSize) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.maxTotalSize} bytes no total`,
      `${totalBytes} bytes`,
    )
  }

  const storage = getStorageAdapter()
  if (!storage) {
    // Em produção o boot garante o Storage; cobre dev/test sem config.
    throw Errors.internal('Storage indisponível para processamento assíncrono')
  }

  // 2. Reserva quota ATÔMICA (anti-bypass: antes de criar Job/upload). Lança
  //    limitExceeded (400) se o plano estourou — nada a compensar (não reservou).
  await validateAndIncrementUsage(userId, plan)

  // 3. Saga: a partir daqui, qualquer falha compensa (estorna quota + cleanup).
  let jobId: string | null = null
  let createdJobAt: Date | null = null
  let uploadedCount = 0
  try {
    const expiresAt = new Date(
      Date.now() + env.ASYNC_JOB_TTL_HOURS * 60 * 60 * 1000,
    )
    const inputFiles: AsyncJobInputFiles = {
      files: prepared.map((p) => ({
        index: p.index,
        fileName: p.fileName,
        ext: p.ext,
        size: p.buffer.length,
      })),
      selectedColumns: input.selectedColumns,
    }

    const job = await prisma.job.create({
      data: {
        userId,
        status: 'PENDING',
        inputFiles: inputFiles as unknown as Prisma.InputJsonValue,
        outputFormat: input.outputFormat,
        expiresAt,
      },
      select: { id: true, createdAt: true },
    })
    jobId = job.id
    createdJobAt = job.createdAt

    // 4. Sobe os N inputs no Storage (path por-input via buildJobInputPath).
    for (const p of prepared) {
      await storage.uploadJobInput({
        userId,
        jobId,
        index: p.index,
        ext: p.ext,
        buffer: p.buffer,
        contentType: EXTENSION_TO_MIME[p.ext],
        createdAt: job.createdAt,
      })
      uploadedCount++
    }

    // 5. Enfileira (com timeout — não pendura se o Redis estiver fora).
    await enqueueWithTimeout(jobId)

    logger.info(
      {
        userId,
        jobId,
        files: prepared.length,
        totalBytes,
        metric: 'async.job.created',
      },
      '[async] job criado e enfileirado',
    )

    return {
      jobId,
      status: 'PENDING',
      createdAt: job.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }
  } catch (err) {
    await compensateFailedJob({
      userId,
      jobId,
      createdAt: createdJobAt,
      prepared,
      uploadedCount,
      storage,
    })

    // Mapeia pro contrato. Fila fora → 503 (cliente retenta).
    if (err instanceof QueueUnavailableError) {
      // Métrica do caminho de RECEITA caindo (Redis/fila inalcançável no
      // enqueue). Simétrica ao sucesso (async.job.created) — sem ela um outage
      // de fila fica silencioso e só vira ticket de usuário (@devops D-1).
      logger.error(
        {
          userId,
          jobId,
          metric: 'async.enqueue.failed',
          reason: 'queue_unavailable',
        },
        '[async] enqueue falhou — fila indisponível (compensado)',
      )
      throw Errors.queueUnavailable()
    }
    // AppError já-tipado (ex: limitExceeded da revalidação) preserva o contrato.
    // Erros do adapter de Storage são Error PURO com `.storageError` (NÃO
    // AppError) — caem no fallthrough abaixo e viram processingFailed 500
    // genérico, sem vazar o detalhe interno do Supabase ao cliente.
    if (err instanceof AppError) {
      throw err
    }
    logger.error(
      {
        userId,
        jobId,
        metric: 'async.job.failed',
        err: sanitizeErrorMessage(err),
      },
      '[async] falha inesperada ao criar job — compensado',
    )
    throw Errors.processingFailed(
      'Falha ao criar job de processamento assíncrono',
    )
  }
}
