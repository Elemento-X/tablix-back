/**
 * Card #189 — Idempotent receiver de webhooks Stripe (RECEIVED → PROCESSED).
 *
 * PROBLEMA QUE ESTE MÓDULO RESOLVE:
 * Antes, o controller registrava `event.id` em `stripe_events` (autocommit)
 * ANTES de processar o handler. Uma falha transitória no handler (deadlock,
 * pool timeout, connection drop) deixava a row gravada mas o efeito (token +
 * email) nunca acontecia. No retry do Stripe, o INSERT batia P2002 → o
 * controller respondia "duplicate" sem reprocessar → o cliente pagava e nunca
 * recebia o token. Bug CRÍTICO de billing.
 *
 * CORREÇÃO (Opção B, tiebreaker @reviewer + desenho @dba):
 * - O INSERT (status=RECEIVED) é o GATE de DEDUP (serializa via unique `id`).
 * - O PROCESSAMENTO roda numa transação sob advisory lock e só marca PROCESSED
 *   no fim — atomicamente com os writes do handler. Falha → rollback de tudo →
 *   status permanece RECEIVED → o retry do Stripe REPROCESSA.
 * - Retry de evento `PROCESSED` é duplicata real e é ignorado.
 * - Retry de evento `RECEIVED` (tentativa anterior falhou) é reprocessado.
 *
 * INVARIANTES (não revisitar sem nova versão):
 * - I/O externo (email) e auditoria NUNCA dentro da transação (R-2). Handlers
 *   retornam side-effects; o orquestrador os executa pós-commit (D-3).
 * - Advisory lock NÃO-bloqueante (`pg_try_advisory_xact_lock`) em AMBOS os
 *   caminhos (novo e reprocesso, D-2) — serializa o processamento do mesmo
 *   event.id; o INSERT serializa o dedup. São pontos distintos e ambos
 *   necessários.
 * - Lock não-adquirido + ainda não PROCESSED → THROW 500 (Stripe redelivera).
 *   NUNCA responder 200 para trabalho não confirmado (R-4).
 *
 * @owner: @planner + @dba + @security + @reviewer
 * @card: #189
 */
import { Prisma } from '@prisma/client'
import type Stripe from 'stripe'
import type { FastifyBaseLogger } from 'fastify'
import { prisma } from '../../lib/prisma'
import { Errors } from '../../errors/app-error'
import { emitAuditEvent } from '../../lib/audit/audit.service'
import { AuditAction } from '../../lib/audit/audit.types'
import {
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
} from './webhook.handler'
import type { WebhookSideEffects, WebhookOutcome } from './webhook.types'

interface ProcessContext {
  ip: string | null
  userAgent: string | null
  log: FastifyBaseLogger
}

/**
 * Registra o evento com status RECEIVED. Retorna true se é novo, false se já
 * existe (P2002 = unique violation no `id`). É o GATE de deduplicação.
 */
async function insertReceived(event: Stripe.Event): Promise<boolean> {
  try {
    await prisma.stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        status: 'RECEIVED',
        // received_at é nullable na fase EXPAND (sem default no DB ainda) —
        // setamos explícito no app. Vira NOT NULL DEFAULT now() no CONTRACT.
        receivedAt: new Date(),
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
 * Dispatch para o handler de negócio. Os handlers escrevem via `tx` e retornam
 * os side-effects (emails/audits) a executar pós-commit. Evento sem handler de
 * negócio é marcado PROCESSED (dedup de tipos não tratados, como antes).
 */
async function runHandler(
  event: Stripe.Event,
  tx: Prisma.TransactionClient,
): Promise<WebhookSideEffects> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(
        event.data.object as Stripe.Checkout.Session,
        tx,
      )
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(
        event.data.object as Stripe.Subscription,
        tx,
      )
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
        tx,
      )
    case 'invoice.payment_failed':
      return handlePaymentFailed(event.data.object as Stripe.Invoice, tx)
    default:
      return {}
  }
}

/** Emite o audit de duplicata (fora de qualquer transação). */
function emitDuplicate(event: Stripe.Event, ctx: ProcessContext): void {
  emitAuditEvent({
    action: AuditAction.WEBHOOK_DUPLICATE,
    actor: 'stripe',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    success: true,
    metadata: { eventId: event.id, eventType: event.type },
  })
}

/**
 * Processa um evento Stripe de forma idempotente e atômica.
 *
 * Erros transitórios propagam (o caller retorna 500 e o Stripe redelivera).
 * Evento já processado retorna sem side-effects.
 */
export async function processStripeEvent(
  event: Stripe.Event,
  ctx: ProcessContext,
): Promise<WebhookOutcome> {
  // (1) Gate de dedup: registra RECEIVED. P2002 → já existe.
  const isNew = await insertReceived(event)

  // (2) Duplicata real? Só se já está PROCESSED.
  if (!isNew) {
    const existing = await prisma.stripeEvent.findUnique({
      where: { id: event.id },
      select: { status: true },
    })
    if (existing?.status === 'PROCESSED') {
      emitDuplicate(event, ctx)
      return 'duplicate'
    }
    // status RECEIVED → tentativa anterior falhou (transitório). Reprocessa.
    // Este é exatamente o caminho que não existia e deixava o cliente sem token.
    ctx.log.info(
      { eventId: event.id, type: event.type },
      '[Webhook] reprocessando evento RECEIVED',
    )
  }

  // (3) Processamento atômico sob advisory lock (novo E reprocesso — D-2).
  // pg_try_advisory_xact_lock é NÃO-bloqueante (retorna imediatamente) e
  // libera no commit/rollback — funciona sob pgbouncer transaction mode.
  // Nenhum I/O externo aqui dentro (R-2): handler só faz DB-writes via tx.
  const sideEffects = await prisma.$transaction(
    async (tx): Promise<WebhookSideEffects | null> => {
      const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${'stripe_event:' + event.id})) AS locked
      `
      if (!lockRows[0]?.locked) {
        // Contention: outro delivery do mesmo event.id está processando agora.
        return null
      }

      // Double-check: o holder concorrente pode ter virado PROCESSED entre o
      // nosso P2002/INSERT e a aquisição do lock.
      const current = await tx.stripeEvent.findUnique({
        where: { id: event.id },
        select: { status: true },
      })
      if (current?.status === 'PROCESSED') {
        return null
      }

      const effects = await runHandler(event, tx)
      await tx.stripeEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', processedAt: new Date() },
      })
      return effects
    },
  )

  // (4) Lock não adquirido OU virou PROCESSED concorrente.
  if (sideEffects === null) {
    const row = await prisma.stripeEvent.findUnique({
      where: { id: event.id },
      select: { status: true },
    })
    if (row?.status === 'PROCESSED') {
      // Outro holder concluiu → duplicata, responde 200.
      emitDuplicate(event, ctx)
      return 'duplicate'
    }
    // Ainda RECEIVED sem lock → trabalho não confirmado. 500 → Stripe redelivera.
    // NUNCA responder 200 aqui (R-4): deixaria o evento preso para sempre.
    ctx.log.warn(
      { eventId: event.id },
      '[Webhook] lock não adquirido, retornando 500 para redelivery',
    )
    throw Errors.webhookFailed('Processamento concorrente em andamento')
  }

  // (5) Pós-commit (fora de qualquer transação): audits + emails fire-and-forget,
  // por fim o WEBHOOK_PROCESSED. O estado PROCESSED já é durável aqui.
  for (const audit of sideEffects.audits ?? []) {
    emitAuditEvent(audit)
  }
  for (const send of sideEffects.emails ?? []) {
    try {
      await send()
    } catch (err) {
      // Falha de email não bloqueia o webhook (o estado já é durável). Mas
      // NÃO engolir em silêncio: no caminho de pagamento, "token gravado no
      // DB mas email não entregue" é o irmão silencioso do CRÍTICO #189 e
      // precisa ser observável pelo oncall (teste das 3am). Sem PII no log.
      ctx.log.error(
        { err, eventId: event.id, eventType: event.type },
        '[Webhook] falha ao enviar email pós-processamento',
      )
    }
  }
  emitAuditEvent({
    action: AuditAction.WEBHOOK_PROCESSED,
    actor: 'stripe',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    success: true,
    metadata: { eventId: event.id, eventType: event.type },
  })
  return 'processed'
}
