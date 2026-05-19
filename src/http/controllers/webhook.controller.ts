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
import { emitAuditEvent } from '../../lib/audit/audit.service'
import { AuditAction } from '../../lib/audit/audit.types'
import {
  isWebhookSignatureBanned,
  recordWebhookSignatureFailure,
} from '../../lib/security/webhook-circuit-breaker'

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
  // Circuit breaker (OWASP A07/A09): bloqueia IPs com histórico de falhas
  // de assinatura antes de qualquer processamento — evita DoS de auditoria
  // por forja em massa. Stripe legítimo nunca dispara signature failure,
  // então o contador é zero em operação normal.
  if (await isWebhookSignatureBanned(request.ip)) {
    request.log.warn(
      { ip: request.ip },
      '[Webhook] IP banido por falhas de assinatura',
    )
    throw Errors.rateLimited()
  }

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
    // Registra falha no circuit breaker (fire-and-forget, nunca lança).
    recordWebhookSignatureFailure(request.ip).catch(() => {})
    // Auditoria forense: tentativa de forgery (OWASP A07). Sem event.id
    // (não foi parseado) — metadata registra IP para correlação.
    emitAuditEvent({
      action: AuditAction.WEBHOOK_SIGNATURE_FAILED,
      actor: 'stripe',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      success: false,
      metadata: { signaturePresent: true },
    })
    throw error
  }

  // Deduplicacao: tenta registrar o event.id
  const isNew = await registerStripeEvent(event)

  if (!isNew) {
    request.log.info(
      { eventId: event.id, type: event.type },
      '[Webhook] Evento duplicado, ignorando',
    )
    emitAuditEvent({
      action: AuditAction.WEBHOOK_DUPLICATE,
      actor: 'stripe',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      success: true,
      metadata: { eventId: event.id, eventType: event.type },
    })
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

  // Audita processamento bem-sucedido. Registrado apenas depois dos
  // handlers retornarem — falha em handler propaga 500 e Stripe retenta,
  // nesse caso o evento NÃO é contado como processado.
  emitAuditEvent({
    action: AuditAction.WEBHOOK_PROCESSED,
    actor: 'stripe',
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    success: true,
    metadata: { eventId: event.id, eventType: event.type },
  })

  return reply.send({ received: true })
}
