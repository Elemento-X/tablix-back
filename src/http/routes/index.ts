import { FastifyInstance } from 'fastify'
import { authRoutes } from './auth.routes'
import { billingRoutes } from './billing.routes'
import { webhookRoutes } from './webhook.routes'
import { processRoutes } from './process.routes'
import { healthRoutes } from './health.routes'
import { usageRoutes } from './usage.routes'
import { historyRoutes } from './history.routes'
import { adminRoutes } from '../../scheduler/admin.routes'

/**
 * Registra todas as rotas da aplicação
 * Ordem importa: webhook deve vir antes para ter raw body parser
 */
export async function registerRoutes(app: FastifyInstance) {
  // Webhook deve vir ANTES das outras rotas
  // Pois configura content type parser diferente (raw body para Stripe)
  await app.register(webhookRoutes, { prefix: '/webhooks' })

  // Health checks (Card 2.3) — /health, /health/live, /health/ready
  // Públicas por design (probes do orquestrador). Sem auth.
  await app.register(healthRoutes, { prefix: '/health' })

  // Rotas de autenticação
  await app.register(authRoutes, { prefix: '/auth' })

  // Rotas de billing
  await app.register(billingRoutes, { prefix: '/billing' })

  // Rotas de processamento
  await app.register(processRoutes, { prefix: '/process' })

  // Rotas de usage & limits (Card 4.1) — GET /usage, GET /limits
  // Não tem prefix dedicado porque são endpoints distintos no top-level
  // (front consome /usage e /limits como rotas separadas, sem agrupar
  // sob /usage/*).
  await app.register(usageRoutes)

  // Rotas de histórico opt-in PRO (Card #145 — 5.2a — Fase 5 Storage)
  // 6 endpoints: POST /history/enable, POST /history/disable,
  // GET /history, GET /history/:id, DELETE /history/:id, DELETE /history.
  // Sem prefix — endpoints já carregam /history no path.
  await app.register(historyRoutes)

  // Rotas admin do scheduler (Card #145 — 5.2a F4 + WV-2026-006)
  // 2 endpoints: POST /admin/jobs/run/:name, GET /admin/jobs/list.
  // Auth completa: JWT + ADMIN_USER_IDS allowlist + step-up reauth (D#3 9 mit).
  // Sem prefix — endpoints já carregam /admin/jobs no path.
  await app.register(adminRoutes)
}
