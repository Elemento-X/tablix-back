import { FastifyRequest, FastifyReply } from 'fastify'
import Stripe from 'stripe'
import { constructWebhookEvent } from '../../modules/billing/stripe.service'
import {
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
} from '../../modules/billing/webhook.handler'
import { Errors } from '../../errors/app-error'

/**
 * POST /webhooks/stripe
 * Recebe e processa webhooks do Stripe
 */
export async function stripeWebhook(
  request: FastifyRequest<{ Headers: { 'stripe-signature'?: string } }>,
  reply: FastifyReply,
) {
  const signature = request.headers['stripe-signature']

  if (!signature) {
    throw Errors.webhookFailed('Assinatura do webhook não fornecida')
  }

  // O body já vem como Buffer por causa do content type parser
  const payload = request.body as Buffer

  // Valida a assinatura do webhook
  let event: Stripe.Event

  try {
    event = constructWebhookEvent(payload, signature)
  } catch (error) {
    console.error('[Webhook] Erro de validação:', error)
    throw error
  }

  console.log('[Webhook] Evento recebido:', event.type)

  // Processa o evento
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session,
        )
        break

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        )
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        )
        break

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break

      default:
        console.log('[Webhook] Evento não tratado:', event.type)
    }
  } catch (error) {
    console.error('[Webhook] Erro ao processar evento:', error)
    // Retorna 200 mesmo com erro para o Stripe não reenviar
    // O erro já foi logado
  }

  // Stripe espera um 200 OK
  return reply.send({ received: true })
}
