import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { authMiddleware } from '../../middleware/auth.middleware'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import * as billingController from '../controllers/billing.controller'
import {
  createCheckoutBodySchema,
  createCheckoutResponseSchema,
  createPortalBodySchema,
  createPortalResponseSchema,
  pricesResponseSchema,
  errorResponseSchema,
} from '../../modules/billing/billing.schema'

export async function billingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // POST /billing/create-checkout - Cria sessão de checkout Stripe
  // Rate limit em 2 camadas (defesa em profundidade):
  //   1. checkoutGlobalCap (30/min agregado) — anti denial-of-wallet
  //   2. checkout (5/min por IP/usuário) — anti brute-force individual
  server.post('/create-checkout', {
    preHandler: [
      rateLimitMiddleware.checkoutGlobalCap,
      rateLimitMiddleware.checkout,
    ],
    schema: {
      tags: ['Billing'],
      summary: 'Criar checkout',
      description:
        'Cria uma sessão de checkout embedded do Stripe para upgrade para plano Pro.',
      body: createCheckoutBodySchema,
      response: {
        200: createCheckoutResponseSchema,
        400: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: billingController.createCheckout,
  })

  // POST /billing/portal - Gera URL do Customer Portal
  server.post('/portal', {
    preHandler: [rateLimitMiddleware.billing, authMiddleware],
    schema: {
      tags: ['Billing'],
      summary: 'Acessar Customer Portal',
      description:
        'Gera URL para o Stripe Customer Portal onde o usuário pode gerenciar assinatura, cartão e faturas.',
      security: [{ bearerAuth: [] }],
      body: createPortalBodySchema,
      response: {
        200: createPortalResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: billingController.portal,
  })

  // GET /billing/prices - Retorna preços disponíveis
  server.get('/prices', {
    preHandler: rateLimitMiddleware.global,
    schema: {
      tags: ['Billing'],
      summary: 'Listar preços',
      description:
        'Retorna os preços disponíveis para o plano Pro (mensal e anual).',
      response: {
        200: pricesResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: billingController.prices,
  })
}
