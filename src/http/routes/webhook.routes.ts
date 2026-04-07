import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import * as webhookController from '../controllers/webhook.controller'

// Schema apenas para documentação (webhook usa raw body)
const webhookResponseSchema = z.object({
  received: z.boolean(),
})

const webhookErrorSchema = z.object({
  error: z.string(),
})

export async function webhookRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // IMPORTANTE: O webhook do Stripe envia raw body, não JSON
  // Precisamos desabilitar o parser de JSON para esta rota
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      done(null, body)
    },
  )

  // POST /webhooks/stripe - Recebe webhooks do Stripe
  server.post('/stripe', {
    schema: {
      tags: ['Billing'],
      summary: 'Webhook Stripe',
      description: `Recebe eventos do Stripe. Não chamar diretamente - este endpoint é chamado pelo Stripe.

**Eventos tratados:**
- \`checkout.session.completed\` - Gera token Pro e envia por email
- \`customer.subscription.updated\` - Atualiza status da assinatura
- \`customer.subscription.deleted\` - Marca token como cancelado
- \`invoice.payment_failed\` - Notifica falha de pagamento`,
      response: {
        200: webhookResponseSchema,
        400: webhookErrorSchema,
      },
    },
    handler: webhookController.stripeWebhook,
  })
}
