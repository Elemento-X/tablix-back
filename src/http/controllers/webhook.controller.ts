import { FastifyRequest, FastifyReply } from 'fastify'
import Stripe from 'stripe'
import { constructWebhookEvent } from '../../modules/billing/stripe.service'
import { processStripeEvent } from '../../modules/billing/webhook-idempotency'
import { Errors } from '../../errors/app-error'
import { emitAuditEvent } from '../../lib/audit/audit.service'
import { AuditAction } from '../../lib/audit/audit.types'
import {
  isWebhookSignatureBanned,
  recordWebhookSignatureFailure,
} from '../../lib/security/webhook-circuit-breaker'

/**
 * POST /webhooks/stripe
 * Recebe e processa webhooks do Stripe.
 *
 * O controller cuida da BORDA: circuit breaker por IP, verificação de
 * assinatura e auditoria de forgery. A idempotência atômica (RECEIVED →
 * PROCESSED, advisory lock, side-effects pós-commit) vive em
 * `processStripeEvent` (Card #189). Erros transitórios propagam (500) e o
 * Stripe reenvia.
 */
export async function stripeWebhook(
  request: FastifyRequest<{
    Headers: { 'stripe-signature'?: string }
  }>,
  reply: FastifyReply,
) {
  // Circuit breaker (OWASP A07/A09): bloqueia IPs com histórico de falhas de
  // assinatura antes de qualquer processamento. Stripe legítimo nunca dispara
  // signature failure, então o contador é zero em operação normal.
  if (await isWebhookSignatureBanned(request.ip)) {
    request.log.warn(
      { ip: request.ip },
      '[Webhook] IP banido por falhas de assinatura',
    )
    throw Errors.rateLimited()
  }

  const signature = request.headers['stripe-signature']

  if (!signature) {
    // @security F1 (gate 7.5): forensics SIMÉTRICO ao caminho de sig inválida —
    // header ausente também é probe/forgery. Sem isto, atacante omite o header
    // pra probar invisível (sem registrar no circuit breaker nem no audit_log A09).
    recordWebhookSignatureFailure(request.ip).catch(() => {})
    emitAuditEvent({
      action: AuditAction.WEBHOOK_SIGNATURE_FAILED,
      actor: 'stripe',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      success: false,
      metadata: { signaturePresent: false },
    })
    // Card #215 (gate 7.5): header ausente é erro de CLIENTE → 400, não 500.
    throw Errors.webhookSignatureInvalid('Assinatura do webhook não fornecida')
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
    // (não foi parseado) — metadata registra apenas a presença da assinatura.
    emitAuditEvent({
      action: AuditAction.WEBHOOK_SIGNATURE_FAILED,
      actor: 'stripe',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      success: false,
      metadata: { signaturePresent: true },
    })
    // Re-lança o erro de constructWebhookEvent — agora Errors.webhookSignatureInvalid
    // (400) para falha de assinatura (Card #215 / gate 7.5), preservando um eventual
    // 500 real (ex: secret não configurado) sem mascarar. A forensics (audit_log +
    // circuit breaker) já foi registrada acima. AppError 400 não dispara Sentry.
    throw error
  }

  // Processamento idempotente e atômico. Dedup, advisory lock, flip PROCESSED
  // e side-effects pós-commit ficam encapsulados no orquestrador.
  await processStripeEvent(event, {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    log: request.log,
  })

  return reply.send({ received: true })
}
