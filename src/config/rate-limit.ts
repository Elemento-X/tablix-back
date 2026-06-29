import { Ratelimit, Duration } from '@upstash/ratelimit'
import { redis } from './redis'
import { env } from './env'

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
 * - process: POST /process/sync e GET /process/download (PRO). Default 10/min, mas
 *            tunável via env PROCESS_RATE_LIMIT_PER_MIN — afrouxado SÓ em staging na
 *            janela do load test (Card 7.5/R-8); travado em 10 em prod (guard env.ts).
 * - health: /health e /health/ready (60/min) - Card 2.3, anti-abuse de probes externos
 *           /health/live é exclusão total (sem rate limit, ver health.routes.ts)
 * - usage: GET /usage (60/min) - Card 4.1, polling do front (use-usage hook)
 * - limits: GET /limits (100/min) - Card 4.1, mais leve que usage (estático por plan)
 *
 * History opt-in PRO (Card #145 — 5.2a — Fase 5 Storage):
 * - historyOptIn: POST /history/enable e /history/disable (10 req/min) — operação
 *                 de baixa frequência por user (mudança de preferência)
 * - historyList: GET /history e /history/:id (60 req/min) — polling-friendly
 * - historyDeleteOne: DELETE /history/:id (5 req/min) — anti-abuse de delete em loop
 * - historyDeleteAll: DELETE /history (1 req / 5min POR USER) — operação destrutiva
 *                 irreversível; atrito proposital. Residual D#1 do WV-2026-006.
 * - historyDeleteAllGlobalCap: DELETE /history (5 req / 5min AGREGADO) — anti
 *                 denial-of-wallet (Supabase delete API é paga; cap global protege
 *                 contra N users × 1 req = N chamadas Storage/min). Identifier fixo.
 *                 Padrão estabelecido em checkoutGlobalCap (memory feedback_denial_of_wallet_cap).
 *
 * Admin jobs (Card #145 D#3 mitigation 6):
 * - adminJobs: POST /admin/jobs/run/:name (5 req/min POR ADMIN) — endpoint nominativo,
 *                 atacante sabe que existe. Limit estrito.
 * - adminJobsGlobalCap: POST /admin/jobs/run/:name (20 req/min AGREGADO) — defense
 *                 em profundidade contra credential leak (1 admin comprometido = 5/min;
 *                 5 admins comprometidos = 20/min total bate o cap).
 */
export const rateLimiters = {
  global: createLimiter(100, '1m', 'global'),
  validateToken: createLimiter(5, '1m', 'validate-token'),
  authRefresh: createLimiter(10, '1m', 'auth-refresh'),
  authMe: createLimiter(60, '1m', 'auth-me'),
  checkout: createLimiter(5, '1m', 'checkout'),
  checkoutGlobalCap: createLimiter(30, '1m', 'checkout-global-cap'),
  billing: createLimiter(20, '1m', 'billing'),
  // Tunável via env (Card 7.5 / R-8): default 10/min = produção. Afrouxa só em
  // staging na janela do load test pra saturar o cap #219; restaura no teardown.
  process: createLimiter(env.PROCESS_RATE_LIMIT_PER_MIN, '1m', 'process'),
  health: createLimiter(60, '1m', 'health'),
  usage: createLimiter(60, '1m', 'usage'),
  limits: createLimiter(100, '1m', 'limits'),
  // Card #145 — 5.2a
  historyOptIn: createLimiter(10, '1m', 'history-optin'),
  historyList: createLimiter(60, '1m', 'history-list'),
  historyDeleteOne: createLimiter(5, '1m', 'history-delete-one'),
  historyDeleteAll: createLimiter(1, '5m', 'history-delete-all'),
  historyDeleteAllGlobalCap: createLimiter(
    5,
    '5m',
    'history-delete-all-global-cap',
  ),
  adminJobs: createLimiter(5, '1m', 'admin-jobs'),
  adminJobsGlobalCap: createLimiter(20, '1m', 'admin-jobs-global-cap'),
  // Processamento assíncrono (Card 6.3):
  // - processAsync: POST /process/async (5 req/min POR IP/USER) — cada job é
  //   um processamento pago no worker + upload no Storage; limite estrito.
  // - processAsyncGlobalCap: POST /process/async (30 req/min AGREGADO) — anti
  //   denial-of-wallet. A fila BullMQ + worker + Storage têm custo; sem o cap,
  //   N IPs × 5 enfileiramentos viram N×5 jobs pagos/min. Identifier fixo.
  processAsync: createLimiter(5, '1m', 'process-async'),
  processAsyncGlobalCap: createLimiter(30, '1m', 'process-async-global-cap'),
  // GET /process/status/:jobId (Card 6.5) — read barato (sem custo de worker/
  // Storage), mas o front faz POLLING. 60/min por IP/user acompanha o padrão
  // do authMe (polling-friendly) sem virar vetor de abuso.
  processStatus: createLimiter(60, '1m', 'process-status'),
} as const

export type RateLimiterType = keyof typeof rateLimiters

/**
 * Verifica se rate limiting está habilitado
 */
export function isRateLimitEnabled(): boolean {
  return redis !== null
}
