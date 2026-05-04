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
 * - checkout: /billing/create-checkout (5 req/min POR IP/usuário) - anti brute-force
 * - checkoutGlobalCap: /billing/create-checkout (30 req/min AGREGADO) - anti denial-of-wallet
 *                     identifier fixo 'global:all'; soma todos os IPs/usuários.
 *                     Sem esse cap, N IPs × 5 req vira N×5 chamadas à Stripe/minuto.
 * - billing: /billing/* exceto checkout (20 req/min)
 * - process: /process/* (10 req/min) - futuro
 * - health: /health e /health/ready (60/min) - Card 2.3, anti-abuse de probes externos
 *           /health/live é exclusão total (sem rate limit, ver health.routes.ts)
 * - usage: GET /usage (60/min) - Card 4.1, polling do front (use-usage hook)
 * - limits: GET /limits (100/min) - Card 4.1, mais leve que usage (estático por plan)
 */
export const rateLimiters = {
  global: createLimiter(100, '1m', 'global'),
  validateToken: createLimiter(5, '1m', 'validate-token'),
  authRefresh: createLimiter(10, '1m', 'auth-refresh'),
  authMe: createLimiter(60, '1m', 'auth-me'),
  checkout: createLimiter(5, '1m', 'checkout'),
  checkoutGlobalCap: createLimiter(30, '1m', 'checkout-global-cap'),
  billing: createLimiter(20, '1m', 'billing'),
  process: createLimiter(10, '1m', 'process'),
  health: createLimiter(60, '1m', 'health'),
  usage: createLimiter(60, '1m', 'usage'),
  limits: createLimiter(100, '1m', 'limits'),
} as const

export type RateLimiterType = keyof typeof rateLimiters

/**
 * Verifica se rate limiting está habilitado
 */
export function isRateLimitEnabled(): boolean {
  return redis !== null
}
