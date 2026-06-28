import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import * as webhookController from '../controllers/webhook.controller'
import { errorResponseSchema } from '../../schemas/common.schema'

// Schema apenas para documentação (webhook usa raw body)
const webhookResponseSchema = z.object({
  received: z.boolean(),
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
        // Card #215 (gate 7.5): envelope canônico { error: { code, message } }.
        // O webhookErrorSchema antigo (error: string) divergia do AppError.toJSON
        // → o serializer Zod falhava na 400 e devolvia 500 (mesma classe #105-107).
        // 400 = assinatura inválida/ausente; 429 = circuit breaker ban; 500 = falha
        // de processamento / secret não configurado.
        400: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: webhookController.stripeWebhook,
  })
}
