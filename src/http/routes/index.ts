import { FastifyInstance } from 'fastify'
import { authRoutes } from './auth.routes'
import { billingRoutes } from './billing.routes'
import { webhookRoutes } from './webhook.routes'
import { processRoutes } from './process.routes'
import { healthRoutes } from './health.routes'

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

  // Futuras rotas serão adicionadas aqui:
  // await app.register(usageRoutes, { prefix: '/usage' })
}
