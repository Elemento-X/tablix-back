import { FastifyRequest, FastifyReply } from 'fastify'
import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { constructWebhookEvent } from '../../modules/billing/stripe.service'
import {
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
} from '../../modules/billing/webhook.handler'
import { prisma } from '../../lib/prisma'
import { Errors } from '../../errors/app-error'

/**
 * Registra evento do Stripe para deduplicacao.
 * Retorna true se o evento foi registrado (novo).
 * Retorna false se ja foi processado (duplicata - P2002).
 */
async function registerStripeEvent(event: Stripe.Event): Promise<boolean> {
  try {
    await prisma.stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
      },
    })
    return true
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return false
    }
    throw error
  }
}

/**
 * POST /webhooks/stripe
 * Recebe e processa webhooks do Stripe.
 *
 * Idempotencia: registra event.id em stripe_events antes de processar.
 * Duplicata retorna 200 sem side effects.
 * Erros reais propagam (500) para a Stripe reenviar.
 */
export async function stripeWebhook(
  request: FastifyRequest<{
    Headers: { 'stripe-signature'?: string }
  }>,
  reply: FastifyReply,
) {
  const signature = request.headers['stripe-signature']

  if (!signature) {
    throw Errors.webhookFailed('Assinatura do webhook nao fornecida')
  }

  const payload = request.body as Buffer

  let event: Stripe.Event

  try {
    event = constructWebhookEvent(payload, signature)
  } catch (error) {
    request.log.error(
      { err: error },
      '[Webhook] Erro de validacao de assinatura',
    )
    throw error
  }

  // Deduplicacao: tenta registrar o event.id
  const isNew = await registerStripeEvent(event)

  if (!isNew) {
    request.log.info(
      { eventId: event.id, type: event.type },
      '[Webhook] Evento duplicado, ignorando',
    )
    return reply.send({ received: true, duplicate: true })
  }

  request.log.info(
    { eventId: event.id, type: event.type },
    '[Webhook] Processando evento',
  )

  // Processa o evento - erros propagam para Fastify retornar 500
  // e a Stripe reenvia automaticamente
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(
        event.data.object as Stripe.Checkout.Session,
      )
      break

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
      break

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
      break

    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.Invoice)
      break

    default:
      request.log.info(
        { eventId: event.id, type: event.type },
        '[Webhook] Evento nao tratado',
      )
  }

  return reply.send({ received: true })
}
