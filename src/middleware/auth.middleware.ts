import { FastifyRequest, FastifyReply } from 'fastify'
import { extractBearerToken, verifyAccessTokenOrThrow } from '../lib/jwt'
import { Errors } from '../errors/app-error'
import { prisma } from '../lib/prisma'

/**
 * Middleware de autenticação JWT + Session
 * Valida o access token e verifica se a session está ativa no DB
 */
export async function authMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization
  const token = extractBearerToken(authHeader)

  if (!token) {
    throw Errors.unauthorized('Token de autenticação não fornecido')
  }

  // Verifica e decodifica o access token JWT
  const payload = verifyAccessTokenOrThrow(token)

  // Verifica se a session está ativa no banco
  const session = await prisma.session.findUnique({
    where: { id: payload.sub },
  })

  if (!session) {
    throw Errors.unauthorized('Sessão não encontrada')
  }

  if (session.revokedAt) {
    throw Errors.unauthorized('Sessão revogada. Faça login novamente.')
  }

  if (session.expiresAt < new Date()) {
    throw Errors.unauthorized('Sessão expirada. Faça login novamente.')
  }

  // Atualiza lastActivityAt (fire-and-forget, não bloqueia o request)
  prisma.session
    .update({
      where: { id: session.id },
      data: { lastActivityAt: new Date() },
    })
    .catch(() => {
      // Falha silenciosa — não impede o request
    })

  // Injeta o payload no request
  request.user = payload
}

/**
 * Middleware opcional de autenticação
 * Tenta autenticar mas não falha se não houver token
 * Útil para rotas que funcionam para ambos (Free e Pro)
 */
export async function optionalAuthMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization
  const token = extractBearerToken(authHeader)

  if (!token) {
    return
  }

  try {
    await authMiddleware(request, _reply)
  } catch {
    request.user = undefined
  }
}

/**
 * Factory para middleware de verificação de role
 * Deve ser usado APÓS authMiddleware
 */
export function requireRole(...roles: Array<'FREE' | 'PRO'>) {
  return async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    if (!request.user) {
      throw Errors.unauthorized('Autenticação necessária')
    }

    const userRole = request.user.role
    if (!roles.includes(userRole)) {
      throw Errors.forbidden()
    }
  }
}
