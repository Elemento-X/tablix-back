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

    // api-contract.md: X-RateLimit-Reset é Unix timestamp em SEGUNDOS
    // (padrão Stripe/GitHub). @upstash/ratelimit retorna `reset` em ms.
    reply.header('X-RateLimit-Limit', limit)
    reply.header('X-RateLimit-Remaining', remaining)
    reply.header('X-RateLimit-Reset', Math.ceil(reset / 1000))

    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000)
      reply.header('Retry-After', retryAfter)
      throw Errors.rateLimited()
    }
  }
}

/**
 * Factory para middleware de rate limit com identifier FIXO ('global:all') —
 * soma todas as requisições do endpoint independente de IP/usuário.
 *
 * Uso: barreira anti denial-of-wallet em rotas que disparam chamada externa
 * paga (Stripe, Resend, provider de email). O limiter per-IP (5/min) sozinho
 * permite 1000 IPs × 5 req = 5000 chamadas Stripe/minuto — custo real na
 * fatura. Este cap global é o teto absoluto do endpoint.
 *
 * Ordem de aplicação (em `preHandler: [...]`):
 *   1. cap global primeiro — se estourou, nem consulta Redis per-IP
 *   2. limiter per-IP depois — este sim seta X-RateLimit-* (info do bucket
 *      do cliente, não do cap global que não é contrato com ele)
 *
 * Headers:
 *   - NÃO seta X-RateLimit-Limit/Remaining/Reset (o middleware per-IP é dono).
 *   - Seta Retry-After em caso de block — dá dica de quanto esperar.
 */
export function createGlobalCapMiddleware(type: RateLimiterType) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isRateLimitEnabled()) {
      return
    }

    const limiter = rateLimiters[type]
    if (!limiter) {
      return
    }

    const { success, reset } = await limiter.limit('global:all')

    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000)
      reply.header('Retry-After', retryAfter)
      request.log.warn(
        {
          url: request.url,
          method: request.method,
          limiter: type,
          retryAfter,
        },
        '[rate-limit] global cap atingido — denial-of-wallet guard',
      )
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
  checkoutGlobalCap: createGlobalCapMiddleware('checkoutGlobalCap'),
  billing: createRateLimitMiddleware('billing'),
  process: createRateLimitMiddleware('process'),
  health: createRateLimitMiddleware('health'),
  usage: createRateLimitMiddleware('usage'),
  limits: createRateLimitMiddleware('limits'),
}
