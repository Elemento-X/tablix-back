import { FastifyInstance } from 'fastify'
import { authRoutes } from './auth.routes'
import { billingRoutes } from './billing.routes'
import { webhookRoutes } from './webhook.routes'
import { processRoutes } from './process.routes'
import { healthRoutes } from './health.routes'
import { usageRoutes } from './usage.routes'

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
}
