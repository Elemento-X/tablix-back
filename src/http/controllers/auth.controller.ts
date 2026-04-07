import { FastifyRequest, FastifyReply } from 'fastify'
import {
  validateTokenSchema,
  refreshTokenSchema,
} from '../../modules/auth/auth.schema'
import {
  validateProToken,
  refreshSession,
  getUserInfo,
} from '../../modules/auth/auth.service'
import { Errors } from '../../errors/app-error'

/**
 * POST /auth/validate-token
 * Valida um token Pro e retorna JWT de sessão
 */
export async function validateToken(
  request: FastifyRequest<{ Body: { token: string; fingerprint: string } }>,
  reply: FastifyReply,
) {
  const validation = validateTokenSchema.safeParse(request.body)

  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  const { token, fingerprint } = validation.data
  const result = await validateProToken(token, fingerprint)

  return reply.send({
    jwt: result.jwt,
    user: result.user,
  })
}

/**
 * POST /auth/refresh
 * Renova um JWT expirado
 */
export async function refresh(
  request: FastifyRequest<{ Body: { refreshToken: string } }>,
  reply: FastifyReply,
) {
  const validation = refreshTokenSchema.safeParse(request.body)

  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  const { refreshToken } = validation.data
  const result = await refreshSession(refreshToken)

  return reply.send({
    jwt: result.jwt,
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

  const userInfo = await getUserInfo(request.user)

  return reply.send({ user: userInfo })
}

/**
 * POST /auth/logout
 * Logout (client-side - apenas retorna sucesso)
 */
export async function logout(request: FastifyRequest, reply: FastifyReply) {
  // JWT é stateless - logout é feito no cliente removendo o token
  // Este endpoint existe apenas para consistência da API
  return reply.send({ success: true })
}
