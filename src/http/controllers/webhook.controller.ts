import { FastifyRequest, FastifyReply } from 'fastify'
import Stripe from 'stripe'
import { constructWebhookEvent } from '../../modules/billing/stripe.service'
import { processStripeEvent } from '../../modules/billing/webhook-idempotency'
import { Errors, AppError, ErrorCodes } from '../../errors/app-error'
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
    // Card #221: distinguir FORGERY (assinatura inválida → 400, erro de CLIENTE) de
    // MISCONFIG do servidor (STRIPE_WEBHOOK_SECRET ausente → 500, falha NOSSA). Só a
    // forgery dispara a forensics anti-abuso (circuit breaker + audit A09): contabilizar
    // uma falha de configuração nossa contra o IP do Stripe legítimo poluiria o circuit
    // breaker e registraria um "ataque" que não existe. Misconfig = 500 propaga limpo
    // pro handler global, SEM a forensics anti-forgery — e AGORA dispara Sentry (Card
    // #224: AppError statusCode>=500 alerta no handler global). Em prod o secret é
    // exigido no boot (env.ts superRefine), então este ramo é praticamente inalcançável lá.
    const isSignatureFailure =
      error instanceof AppError &&
      error.code === ErrorCodes.WEBHOOK_SIGNATURE_INVALID

    if (!isSignatureFailure) {
      throw error
    }

    // Card #222: assinatura inválida é um 400 ESPERADO (forgery/probe) — loga em WARN,
    // não error, e sem stack. A trilha forense real é o audit_log A09 + circuit breaker
    // abaixo; um log.error com stack a cada forjada infla dashboard/alerta de erro (ruído
    // controlável pelo atacante = DoS-on-observability leve).
    request.log.warn(
      { ip: request.ip, code: error.code },
      '[Webhook] Assinatura inválida (forgery/probe)',
    )
    // Registra falha no circuit breaker (fire-and-forget, nunca lança).
    recordWebhookSignatureFailure(request.ip).catch(() => {})
    // Auditoria forense: tentativa de forgery (OWASP A07/A09). Sem event.id
    // (não foi parseado) — metadata registra apenas a presença da assinatura.
    emitAuditEvent({
      action: AuditAction.WEBHOOK_SIGNATURE_FAILED,
      actor: 'stripe',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      success: false,
      metadata: { signaturePresent: true },
    })
    // Re-lança o 400 (AppError não dispara Sentry). A forensics já foi registrada.
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
