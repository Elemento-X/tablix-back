import { FastifyRequest, FastifyReply } from 'fastify'
import {
  validateTokenBodySchema,
  refreshBodySchema,
} from '../../modules/auth/auth.schema'
import {
  validateProToken,
  refreshSession,
  getUserInfo,
  revokeSession,
  revokeAllSessions,
} from '../../modules/auth/auth.service'
import { Errors } from '../../errors/app-error'
import { emitAuditEvent } from '../../lib/audit/audit.service'
import { AuditAction } from '../../lib/audit/audit.types'

/**
 * Extrai o campo `code` de um AppError para uso em metadata do audit.
 * Retorna 'unknown' para erros sem `code` — escapa PII por design: só
 * aceita string enum-like, nunca a mensagem bruta do erro.
 */
function errorCode(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown'
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : 'unknown'
}

/**
 * POST /auth/validate-token
 * Valida um token Pro e retorna access + refresh tokens
 */
export async function validateToken(
  request: FastifyRequest<{ Body: { token: string; fingerprint: string } }>,
  reply: FastifyReply,
) {
  const validation = validateTokenBodySchema.safeParse(request.body)

  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  const { token, fingerprint } = validation.data
  const ip = request.ip
  const userAgent = request.headers['user-agent'] ?? null

  try {
    const result = await validateProToken(token, {
      fingerprint,
      userAgent: userAgent ?? undefined,
      ipAddress: ip,
    })

    emitAuditEvent({
      action: AuditAction.TOKEN_VALIDATE_SUCCESS,
      actor: result.user.id,
      ip,
      userAgent,
      success: true,
    })

    return reply.send({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    })
  } catch (err) {
    // Audita falha sem vazar o token em claro: `actor` fica null pois user
    // não foi autenticado; motivo vai em `metadata.reason` derivado do
    // código do AppError (escapa PII por design — só enum-like strings).
    const reason = errorCode(err)
    emitAuditEvent({
      action: AuditAction.TOKEN_VALIDATE_FAILURE,
      actor: null,
      ip,
      userAgent,
      success: false,
      metadata: { reason },
    })
    throw err
  }
}

/**
 * POST /auth/refresh
 * Renova tokens usando refresh token
 */
export async function refresh(
  request: FastifyRequest<{ Body: { refreshToken: string } }>,
  reply: FastifyReply,
) {
  const validation = refreshBodySchema.safeParse(request.body)

  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  const { refreshToken } = validation.data
  const ip = request.ip
  const userAgent = request.headers['user-agent'] ?? null

  try {
    const result = await refreshSession(refreshToken)

    emitAuditEvent({
      action: AuditAction.SESSION_REFRESH,
      actor: null,
      ip,
      userAgent,
      success: true,
    })

    return reply.send({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })
  } catch (err) {
    const reason = errorCode(err)
    emitAuditEvent({
      action: AuditAction.SESSION_REFRESH_FAILURE,
      actor: null,
      ip,
      userAgent,
      success: false,
      metadata: { reason },
    })
    throw err
  }
}

/**
 * GET /auth/me
 * Retorna dados do usuário autenticado
 */
export async function me(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const userInfo = await getUserInfo(request.user.userId)

  return reply.send({ user: userInfo })
}

/**
 * POST /auth/logout
 * Revoga a sessão atual
 */
export async function logout(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  await revokeSession(request.user.sub)

  emitAuditEvent({
    action: AuditAction.LOGOUT,
    actor: request.user.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    success: true,
    metadata: { sessionId: request.user.sub },
  })

  return reply.send({ success: true })
}

/**
 * POST /auth/logout-all
 * Revoga todas as sessões do usuário
 */
export async function logoutAll(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const count = await revokeAllSessions(request.user.userId)

  emitAuditEvent({
    action: AuditAction.LOGOUT_ALL,
    actor: request.user.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    success: true,
    metadata: { sessionsRevoked: count },
  })

  return reply.send({ success: true, sessionsRevoked: count })
}
