import { FastifyRequest, FastifyReply } from 'fastify'
import {
  rateLimiters,
  RateLimiterType,
  isRateLimitEnabled,
} from '../config/rate-limit'
import { Errors } from '../errors/app-error'

/**
 * Retorna o identifier para rate limiting:
 * - Usuário autenticado: usa userId (mais justo que IP).
 * - Não autenticado: usa `request.ip` do Fastify (respeita `trustProxy`
 *   configurado em app.ts — ver Card 1.12).
 *
 * Card 1.12: NUNCA lê `x-forwarded-for` cru. Resolução de XFF é
 * responsabilidade do Fastify via `trustProxy`, que só confia em hops
 * permitidos. Ler XFF direto permitiria spoof trivial.
 *
 * Fail-closed: se `request.ip` estiver ausente (caso extremo, não
 * deveria acontecer com Fastify), a requisição é rejeitada com
 * IP_UNRESOLVABLE. Fallback para bucket compartilhado ("unknown")
 * seria uma via de bypass — todos os requests sem IP compartilhariam
 * o mesmo counter e poderiam afogar uns aos outros.
 */
function getRateLimitIdentifier(request: FastifyRequest): string {
  if (request.user?.userId) {
    return `user:${request.user.userId}`
  }
  const ip = request.ip
  if (!ip) {
    // Observability: fail-closed é silencioso por default. Log estruturado
    // permite alerta em dashboard se a taxa de IP_UNRESOLVABLE subir
    // (bug de trustProxy, proxy novo mal configurado, etc.).
    request.log.warn(
      { url: request.url, method: request.method },
      '[rate-limit] request.ip ausente — fail-closed (IP_UNRESOLVABLE)',
    )
    throw Errors.ipUnresolvable()
  }
  return `ip:${ip}`
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
