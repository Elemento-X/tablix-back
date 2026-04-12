import { FastifyRequest, FastifyReply } from 'fastify'
import {
  rateLimiters,
  RateLimiterType,
  isRateLimitEnabled,
} from '../config/rate-limit'
import { Errors } from '../errors/app-error'

/**
 * Extrai o IP do cliente para rate limiting
 */
function getClientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for']
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]
    return ip.trim()
  }
  return request.ip || 'unknown'
}

/**
 * Retorna o identifier para rate limiting:
 * - Usuário autenticado: usa userId (mais justo que IP)
 * - Não autenticado: usa IP
 */
function getRateLimitIdentifier(request: FastifyRequest): string {
  if (request.user?.userId) {
    return `user:${request.user.userId}`
  }
  return `ip:${getClientIp(request)}`
}

/**
 * Factory para criar middleware de rate limit
 */
export function createRateLimitMiddleware(type: RateLimiterType) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isRateLimitEnabled()) {
      return
    }

    const limiter = rateLimiters[type]
    if (!limiter) {
      return
    }

    const identifier = getRateLimitIdentifier(request)
    const { success, limit, remaining, reset } = await limiter.limit(identifier)

    reply.header('X-RateLimit-Limit', limit)
    reply.header('X-RateLimit-Remaining', remaining)
    reply.header('X-RateLimit-Reset', reset)

    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000)
      reply.header('Retry-After', retryAfter)
      throw Errors.rateLimited()
    }
  }
}

export const rateLimitMiddleware = {
  global: createRateLimitMiddleware('global'),
  validateToken: createRateLimitMiddleware('validateToken'),
  authRefresh: createRateLimitMiddleware('authRefresh'),
  authMe: createRateLimitMiddleware('authMe'),
  checkout: createRateLimitMiddleware('checkout'),
  billing: createRateLimitMiddleware('billing'),
  process: createRateLimitMiddleware('process'),
}
