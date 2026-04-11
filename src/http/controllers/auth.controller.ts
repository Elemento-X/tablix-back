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

  const result = await validateProToken(token, {
    fingerprint,
    userAgent: request.headers['user-agent'],
    ipAddress: request.ip,
  })

  return reply.send({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: result.user,
  })
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
  const result = await refreshSession(refreshToken)

  return reply.send({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  })
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

  return reply.send({ success: true, sessionsRevoked: count })
}
