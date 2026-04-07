import { FastifyRequest, FastifyReply } from 'fastify'
import { extractBearerToken, verifyJwtOrThrow } from '../lib/jwt'
import { Errors } from '../errors/app-error'
import { prisma } from '../lib/prisma'

/**
 * Middleware de autenticação JWT
 * Valida o token e injeta o usuário no request
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

  // Verifica e decodifica o JWT
  const payload = verifyJwtOrThrow(token)

  // Verifica se o token Pro ainda existe e está ativo no banco
  const tokenRecord = await prisma.token.findUnique({
    where: { id: payload.sub },
  })

  if (!tokenRecord) {
    throw Errors.invalidToken('Token não encontrado')
  }

  if (tokenRecord.status !== 'ACTIVE') {
    if (tokenRecord.status === 'CANCELLED') {
      // Verifica se ainda está no período de graça
      if (tokenRecord.expiresAt && tokenRecord.expiresAt > new Date()) {
        // Ainda tem acesso até expirar
        request.user = payload
        return
      }
      throw Errors.subscriptionExpired('Assinatura cancelada')
    }
    throw Errors.subscriptionExpired('Assinatura expirada')
  }

  // Verifica se expirou (mesmo que status seja ACTIVE)
  if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
    // Atualiza status para EXPIRED
    await prisma.token.update({
      where: { id: tokenRecord.id },
      data: { status: 'EXPIRED' },
    })
    throw Errors.subscriptionExpired('Assinatura expirada')
  }

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
    // Sem token, continua como usuário Free
    return
  }

  try {
    // Tenta autenticar
    await authMiddleware(request, _reply)
  } catch {
    // Falha silenciosa - continua como Free
    request.user = undefined
  }
}
