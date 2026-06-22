/**
 * POST /process/async — controller (Card 6.3, LRO).
 *
 * Aceita multipart (30MB/arquivo), exige Idempotency-Key (428 se ausente),
 * cria o job via async.service e responde 202 + Location pro polling. A
 * idempotência (Card #74) garante que um double-POST/retry com a mesma key
 * NÃO crie 2 jobs nem cobre 2x — o resultado (jobId) é cacheado e re-servido.
 *
 * @owner: @security + @reviewer
 * @card: 6.3
 */
import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError, ErrorCodes, Errors } from '../../errors/app-error'
import { PRO_LIMITS } from '../../config/plan-limits'
import {
  idempotencyKeySchema,
  processAsyncInputSchema,
  type ProcessAsyncInput,
  type ProcessAsyncResponse,
} from '../../modules/process/process-async.schema'
import { createAsyncJob } from '../../modules/process/process-async.service'
import { collectSpreadsheetMultipart } from './helpers/collect-spreadsheet-multipart'
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  releaseIdempotencyKey,
} from '../../lib/idempotency/idempotency.service'

/** Cap de bytes por arquivo no async (A-LIMITS, 30MB) — espelha o service. */
const ASYNC_FILE_SIZE_LIMIT = 30 * 1024 * 1024
const IDEMPOTENCY_SCOPE = 'process-async'

/**
 * Hash determinístico da request async pra detecção de conflito de idempotência
 * (mesma key + payload diferente → 422). Inclui os METADADOS (colunas, formato)
 * E os BYTES de cada arquivo (via SHA-256 incremental) — dois uploads
 * diferentes com a mesma key não colidem. A ORDEM dos arquivos faz parte do
 * contrato (define a ordem do merge), então não é normalizada.
 */
function hashAsyncRequest(
  files: { buffer: Buffer; fileName: string }[],
  input: ProcessAsyncInput,
): string {
  const h = createHash('sha256')
  h.update(
    JSON.stringify({
      selectedColumns: input.selectedColumns,
      outputFormat: input.outputFormat,
    }),
  )
  for (const f of files) {
    h.update(f.fileName)
    h.update(createHash('sha256').update(f.buffer).digest())
  }
  return h.digest('hex')
}

/** Envia o 202 Accepted com Location pro polling (LRO). */
function send202(
  reply: FastifyReply,
  result: ProcessAsyncResponse,
  degraded?: boolean,
) {
  reply
    .status(202)
    .header('Location', `/process/status/${result.jobId}`)
    .header('Cache-Control', 'no-store')
  if (degraded) {
    // Redis configurado mas falhou — operação prosseguiu sem proteção de
    // idempotência. Ops alarma via header + métrica do idempotency.service.
    reply.header('Idempotency-Degraded', 'true')
  }
  return reply.send(result)
}

export async function processAsync(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }
  const userId = request.user.userId
  const plan = request.user.role // 'PRO' garantido por requireRole('PRO')

  // 1. Idempotency-Key OBRIGATÓRIA (428 se ausente; 400 se formato inválido).
  const rawKey = request.headers['idempotency-key']
  const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey
  if (!idempotencyKey) {
    throw Errors.idempotencyKeyRequired()
  }
  const keyParse = idempotencyKeySchema.safeParse(idempotencyKey)
  if (!keyParse.success) {
    throw Errors.validationError('Idempotency-Key inválida', {
      errors: keyParse.error.flatten().formErrors,
    })
  }

  // 2. Coleta multipart (30MB override + guards anti-abuso Card 1.16).
  const collected = await collectSpreadsheetMultipart(request, {
    fileSizeLimitBytes: ASYNC_FILE_SIZE_LIMIT,
    maxTotalBytes: PRO_LIMITS.maxTotalSize,
    maxFiles: PRO_LIMITS.maxInputFiles,
    fileSizeLabel: '30MB por arquivo',
    totalSizeLabel: `${PRO_LIMITS.maxTotalSize} bytes no total`,
    userId,
  })
  if (collected.files.length === 0) {
    throw Errors.validationError('Nenhum arquivo enviado')
  }

  // 3. Valida o corpo (colunas/formato) via Zod.
  const validation = processAsyncInputSchema.safeParse({
    selectedColumns: collected.selectedColumns,
    outputFormat: collected.outputFormat,
  })
  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  // 4. Hash do payload pra conflito de idempotência.
  const bodyHash = hashAsyncRequest(collected.files, validation.data)

  // 5. Adquire o lock de idempotência.
  const begin = await beginIdempotentOperation<ProcessAsyncResponse>({
    key: idempotencyKey,
    scope: IDEMPOTENCY_SCOPE,
    identifier: userId,
    bodyHash,
  })

  if (begin.status === 'conflict') {
    throw Errors.idempotencyConflict()
  }
  if (begin.status === 'in_progress') {
    reply.header('Retry-After', '5')
    throw Errors.idempotencyInProgress()
  }
  if (begin.status === 'hit' && begin.cached) {
    // Retry da MESMA operação — re-serve o mesmo jobId sem reexecutar.
    return send202(reply, begin.cached, begin.degraded)
  }

  // 6. miss → executa de fato.
  try {
    const result = await createAsyncJob({
      userId,
      plan,
      files: collected.files,
      input: validation.data,
    })
    await completeIdempotentOperation({
      key: idempotencyKey,
      scope: IDEMPOTENCY_SCOPE,
      identifier: userId,
      bodyHash,
      data: result,
    })
    return send202(reply, result, begin.degraded)
  } catch (err) {
    // Falha → libera a key pra retry imediato (não prende o cliente 24h).
    await releaseIdempotencyKey({
      key: idempotencyKey,
      scope: IDEMPOTENCY_SCOPE,
      identifier: userId,
    })
    // 503 de fila indisponível DEVE carregar Retry-After (api-contract.md:
    // obrigatório em 429/503) — senão o cliente retenta sem backoff e gera
    // thundering herd contra um Redis já em recuperação (@devops D-2). Header
    // setado antes do throw persiste no error handler global (mesmo padrão do
    // idempotencyInProgress acima).
    if (err instanceof AppError && err.code === ErrorCodes.QUEUE_UNAVAILABLE) {
      reply.header('Retry-After', '5')
    }
    throw err
  }
}
