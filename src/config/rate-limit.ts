import { Ratelimit, Duration } from '@upstash/ratelimit'
import { redis } from './redis'

/**
 * Configuração dos rate limiters por tipo de endpoint
 * Usando sliding window para distribuição mais justa
 */

// Rate limiters só são criados se Redis estiver configurado
const createLimiter = (requests: number, window: Duration, prefix: string) => {
  if (!redis) return null
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: `tablix:ratelimit:${prefix}`,
    analytics: true,
  })
}

/**
 * Rate limiters disponíveis
 * - global: fallback para qualquer endpoint (100 req/min)
 * - validateToken: /auth/validate-token (5 req/min) - anti brute-force
 * - authRefresh: /auth/refresh (10 req/min)
 * - authMe: /auth/me (60 req/min) - frontend pode fazer polling
 * - billing: /billing/* (20 req/min)
 * - process: /process/* (10 req/min) - futuro
 */
export const rateLimiters = {
  global: createLimiter(100, '1m', 'global'),
  validateToken: createLimiter(5, '1m', 'validate-token'),
  authRefresh: createLimiter(10, '1m', 'auth-refresh'),
  authMe: createLimiter(60, '1m', 'auth-me'),
  billing: createLimiter(20, '1m', 'billing'),
  process: createLimiter(10, '1m', 'process'),
} as const

export type RateLimiterType = keyof typeof rateLimiters

/**
 * Verifica se rate limiting está habilitado
 */
export function isRateLimitEnabled(): boolean {
  return redis !== null
}
