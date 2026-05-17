/**
 * History controller — Card #145 (5.2a, Fase 5 Storage).
 *
 * 6 handlers REST sobre o feature opt-in de histórico de arquivos PRO.
 * Toda rota exige JWT (auth middleware aplicado upstream em routes).
 *
 * **Invariante D#4 cross-card:** GET /history E /history/:id E DELETE /:id
 * E DELETE / retornam 403 `FEATURE_DISABLED` quando `historyOptIn=false`.
 * `checkHistoryOptIn` é o gate único — chamadas helpers do service NÃO
 * checam pra evitar duplicação. POST /enable E /disable NÃO precisam (são
 * operações de toggle do próprio consentimento).
 *
 * **Idempotency-Key (residual D#1):** DELETE /history (em massa) exige
 * header MANDATORY (operação destrutiva irreversível). Idempotência
 * protege contra retry de timeout que dispararia segundo wipe.
 *
 * **Cache headers (api-contract.md):**
 *  - GET /history: `private, no-cache` + `Vary: Authorization`
 *  - GET /history/:id: `private, no-store` (signedUrl é efêmera)
 *  - POST/DELETE: `Cache-Control: no-store`
 *
 * @owner: @planner + @reviewer
 * @card: #145 (5.2a) F3
 */
import { createHash } from 'node:crypto'

import { FastifyRequest, FastifyReply } from 'fastify'

import { Errors } from '../../errors/app-error'
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  hashBody,
  releaseIdempotencyKey,
} from '../../lib/idempotency/idempotency.service'
import { logger } from '../../lib/logger'
import { prisma } from '../../lib/prisma'
import { getStorageAdapter } from '../../lib/storage'
import {
  type ALLOWED_EXTENSIONS,
  type AllowedExtension,
} from '../../lib/storage'
import {
  disableHistory,
  enableHistory,
  getOneHistory,
  listUserHistory,
  softDeleteAll,
  softDeleteOne,
  toFileHistoryDto,
} from '../../modules/history/history.service'
import type {
  DeleteAllHistoryRequest,
  DeleteAllHistoryResponse,
  DeleteOneHistoryParams,
  DeleteOneHistoryResponse,
  DisableHistoryResponse,
  EnableHistoryResponse,
  GetHistoryParams,
  GetHistoryResponse,
  ListHistoryQuery,
  ListHistoryResponse,
} from '../../modules/history/history.schema'

/**
 * TTL curto pra signed URL (R-9 mitigation residual D#1). Atacante com URL
 * pré-gerada continua acessando até este TTL mesmo após DELETE da row.
 * Card #158 endereça revogação imediata. 60s minimiza janela de leak.
 */
const SIGNED_URL_TTL_SECONDS = 60

/**
 * Hash SHA-256 do storage path para audit trail forense (M3 do runbook
 * `signed-url-survives-delete.md`, Card #145 F5 fix-pack). NUNCA logar
 * path cru — vaza estrutura interna (`history/{userId}/{jobId}.{ext}`)
 * e pode incluir partes do userId/jobId (PII indireta).
 *
 * Hash determinístico permite correlacionar logs de signed URL emitidos
 * com audit_log_legal (purge_pending) em investigação LGPD pós-incidente.
 */
function hashStoragePathForAudit(storagePath: string): string {
  return createHash('sha256').update(storagePath).digest('hex')
}

/**
 * Idempotency-Key constraints (Card #74 pattern). Header obrigatório em
 * DELETE em massa; UUID v4 strict pra evitar key fraca/reusable.
 */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
const IDEMPOTENCY_KEY_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ============================================
// HELPERS
// ============================================

/**
 * Gate único do D#4 invariante: lê `historyOptIn` do user e throw 403
 * `FEATURE_DISABLED` se desligado. Cache 30s seria útil em produção mas
 * over-engineering pra F3 — query é trivial (PK lookup com index).
 *
 * @throws AppError(FEATURE_DISABLED) com details.feature='history' (403)
 * @throws AppError(UNAUTHORIZED) se user não existe (improvável após auth
 *   middleware, mas defesa em profundidade)
 */
async function requireHistoryOptIn(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { historyOptIn: true },
  })

  if (!user) {
    throw Errors.unauthorized('Sessão inválida')
  }

  if (!user.historyOptIn) {
    throw Errors.featureDisabled(
      'history',
      'Histórico desabilitado nas suas preferências. Dados anteriores serão purgados conforme política de retenção.',
    )
  }
}

/**
 * Parse de UserScopedPath `{userId-uuid}/{yyyy-mm-dd UTC}/{jobId-cuid}.{ext}`
 * pros componentes consumidos pelo storage adapter (`{userId, jobId, ext}`).
 *
 * Formato validado por CHECK constraint do DB (regex strict). Se o path do
 * banco bater no parsing, é por construção — sem fallback de erro silencioso.
 */
function parseStoragePath(path: string): {
  userId: string
  jobId: string
  ext: AllowedExtension
} {
  const parts = path.split('/')
  if (parts.length !== 3) {
    // Defesa em profundidade: se row do DB passou na CHECK constraint mas
    // não bate no parser, é bug grave (driver corrompido, encoding).
    throw new Error('Invalid storage_path shape (expected 3 segments)')
  }
  const [userId, , filename] = parts
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx <= 0) {
    throw new Error('Invalid storage_path filename (missing extension)')
  }
  const jobId = filename.slice(0, dotIdx)
  const ext = filename.slice(dotIdx + 1) as AllowedExtension
  // Defesa em profundidade contra ext fora da whitelist após parsing
  // (CHECK do DB já garante, mas paranoia justificada antes de pasar
  // pro adapter que confia no caller).
  const allowed: ReadonlyArray<AllowedExtension> = [
    'csv',
    'xlsx',
    'xls',
  ] satisfies (typeof ALLOWED_EXTENSIONS)[number][]
  if (!allowed.includes(ext)) {
    throw new Error(`Invalid storage_path extension: ${ext}`)
  }
  return { userId, jobId, ext }
}

// ============================================
// 1. POST /history/enable
// ============================================

export async function postEnableHistory(
  _request: FastifyRequest<{ Body: Record<string, never> }>,
  reply: FastifyReply,
): Promise<void> {
  const request = _request as FastifyRequest
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const { historyOptInAt } = await enableHistory({
    userId: request.user.userId,
  })

  reply.header('Cache-Control', 'no-store')
  const response: EnableHistoryResponse = {
    data: {
      historyOptIn: true,
      historyOptInAt: historyOptInAt.toISOString(),
    },
  }
  return reply.send(response)
}

// ============================================
// 2. POST /history/disable
// ============================================

export async function postDisableHistory(
  _request: FastifyRequest<{ Body: Record<string, never> }>,
  reply: FastifyReply,
): Promise<void> {
  const request = _request as FastifyRequest
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const { historyOptOutAt, purgeScheduledFor, affectedRowCount, truncated } =
    await disableHistory({
      userId: request.user.userId,
    })

  reply.header('Cache-Control', 'no-store')
  const response: DisableHistoryResponse = {
    data: {
      historyOptIn: false,
      historyOptOutAt: historyOptOutAt.toISOString(),
      purgeScheduledFor: purgeScheduledFor.toISOString(),
      affectedRowCount,
      truncated,
    },
  }
  return reply.send(response)
}

// ============================================
// 3. GET /history (listagem paginada)
// ============================================

export async function getListHistory(
  request: FastifyRequest<{ Querystring: ListHistoryQuery }>,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  await requireHistoryOptIn(request.user.userId)

  const { items, nextCursor, hasMore } = await listUserHistory({
    userId: request.user.userId,
    cursor: request.query.cursor,
    limit: request.query.limit,
  })

  reply.header('Cache-Control', 'private, no-cache')
  reply.header('Vary', 'Authorization')

  const response: ListHistoryResponse = {
    data: items,
    meta: { nextCursor, hasMore },
  }
  return reply.send(response)
}

// ============================================
// 4. GET /history/:id (detalhe + signed URL)
// ============================================

export async function getOneHistoryHandler(
  request: FastifyRequest<{ Params: GetHistoryParams }>,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  await requireHistoryOptIn(request.user.userId)

  const row = await getOneHistory({
    userId: request.user.userId,
    id: request.params.id,
  })

  const adapter = getStorageAdapter()
  if (!adapter) {
    // Em production o boot falha sem adapter (env.ts superRefine). Aqui
    // só cobrimos dev/test sem config — feature não opera sem storage.
    throw Errors.internal('Storage adapter não configurado')
  }

  const { jobId, ext } = parseStoragePath(row.storagePath)
  const { url, expiresAt } = await adapter.getSignedUrlForUser({
    userId: request.user.userId,
    jobId,
    ext,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  })

  // M3 (Card #145 F5 fix-pack — runbook signed-url-survives-delete.md):
  // audit trail local de signed URLs emitidas. Documenta R-9 (janela de
  // exposição pós-DELETE) com pathHash SHA-256 (NÃO path cru). Cruzar
  // com audit_log_legal (purge_pending) em forense LGPD.
  logger.info(
    {
      userId: request.user.userId,
      pathHash: hashStoragePathForAudit(row.storagePath),
      ttlSeconds: SIGNED_URL_TTL_SECONDS,
      jobId,
    },
    'storage.signed_url.created',
  )

  reply.header('Cache-Control', 'private, no-store')
  reply.header('Vary', 'Authorization')

  const response: GetHistoryResponse = {
    data: {
      ...toFileHistoryDto(row),
      signedUrl: url,
      signedUrlExpiresAt: expiresAt.toISOString(),
    },
  }
  return reply.send(response)
}

// ============================================
// 5. DELETE /history/:id (purga individual)
// ============================================

export async function deleteOneHistoryHandler(
  request: FastifyRequest<{ Params: DeleteOneHistoryParams }>,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  await requireHistoryOptIn(request.user.userId)

  const { deletedAt } = await softDeleteOne({
    userId: request.user.userId,
    id: request.params.id,
  })

  reply.header('Cache-Control', 'no-store')
  const response: DeleteOneHistoryResponse = {
    data: {
      id: request.params.id,
      deletedAt: deletedAt.toISOString(),
    },
  }
  return reply.send(response)
}

// ============================================
// 6. DELETE /history (purga em massa) — D#1 + Idempotency MANDATORY
// ============================================

export async function deleteAllHistoryHandler(
  request: FastifyRequest<{ Body: DeleteAllHistoryRequest }>,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  await requireHistoryOptIn(request.user.userId)

  // Idempotency-Key MANDATORY (residual D#1). Diferente de billing/checkout
  // (opcional), aqui é hard requirement — operação destrutiva irreversível
  // sem proteção contra retry seria denial-of-data.
  const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER]
  const idempotencyKey = typeof rawKey === 'string' ? rawKey : ''
  if (!IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
    throw Errors.validationError(
      'Idempotency-Key header é obrigatório nesta operação destrutiva. Envie UUID v4 lowercase.',
      { header: IDEMPOTENCY_KEY_HEADER },
    )
  }

  const scope = 'history-delete-all'
  const identifier = request.user.userId
  const bodyHash = hashBody({
    confirmation: request.body.confirmation,
  })

  const begin = await beginIdempotentOperation<DeleteAllHistoryResponse>({
    key: idempotencyKey,
    scope,
    identifier,
    bodyHash,
  })

  if (begin.status === 'hit' && begin.cached) {
    reply.header('Idempotency-Replay', 'true')
    reply.header('Cache-Control', 'no-store')
    return reply.send(begin.cached)
  }

  if (begin.status === 'conflict') {
    throw Errors.idempotencyConflict()
  }

  if (begin.status === 'in_progress') {
    reply.header('Retry-After', '5')
    throw Errors.idempotencyInProgress()
  }

  if (begin.degraded) {
    reply.header('Idempotency-Degraded', 'true')
    logger.warn(
      { scope, userId: identifier },
      'idempotency.degraded.delete_all',
    )
  }

  // Captura IP/UA pra audit_log_legal forense (residual D#1)
  const ip = request.ip
  const userAgent = String(request.headers['user-agent'] ?? 'unknown').slice(
    0,
    512,
  )

  try {
    const { affectedRowCount, deletedAt, truncated } = await softDeleteAll({
      userId: request.user.userId,
      ip,
      userAgent,
      // request.id é o X-Request-Id setado por Fastify — fingerprint
      // estável pra correlacionar audit ↔ logs.
      fingerprint: typeof request.id === 'string' ? request.id : undefined,
    })

    const response: DeleteAllHistoryResponse = {
      data: {
        affectedRowCount,
        deletedAt: deletedAt.toISOString(),
        truncated,
      },
    }

    await completeIdempotentOperation<DeleteAllHistoryResponse>({
      key: idempotencyKey,
      scope,
      identifier,
      bodyHash,
      data: response,
    })

    reply.header('Cache-Control', 'no-store')
    return reply.send(response)
  } catch (err) {
    await releaseIdempotencyKey({ key: idempotencyKey, scope, identifier })
    throw err
  }
}
