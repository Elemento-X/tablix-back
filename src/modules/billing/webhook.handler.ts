/**
 * Handlers de webhook Stripe (Card #189 — idempotent receiver).
 *
 * Cada handler é uma UNIT-OF-WORK pura: recebe o `tx` da transação do
 * orquestrador (`processStripeEvent`), faz APENAS DB-writes via `tx`, e
 * RETORNA os side-effects (emails/audits) — que o orquestrador executa
 * pós-commit. Nenhum email/auditoria/`$transaction` interno aqui (R-2/D-3).
 *
 * Atomicidade: como tudo roda dentro da transação do orquestrador, qualquer
 * erro faz rollback de todos os writes (incluindo o flip para PROCESSED em
 * stripe_events) — o evento permanece RECEIVED e o retry do Stripe reprocessa.
 * Por isso NÃO há mais `catch P2002` defensivo: dentro de uma interactive
 * transaction um erro já aborta a tx; a serialização por advisory lock
 * (por event.id) + o gate de dedup tornam a race de duplo-create quase
 * impossível, e se ocorrer o rollback+retry converge corretamente.
 *
 * @owner: @security + @dba
 * @card: #189
 */
import type Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { generateProToken } from '../../lib/token-generator'
import { Errors } from '../../errors/app-error'
import {
  sendTokenEmail,
  sendCancellationEmail,
  sendPaymentFailedEmail,
} from '../../lib/email'
import { AuditAction } from '../../lib/audit/audit.types'
import type { AuditEventInput } from '../../lib/audit/audit.types'
import type { WebhookSideEffects } from './webhook.types'

/**
 * Handler para checkout.session.completed — pagamento confirmado.
 * Cria/atualiza User (role PRO) + Token Pro, retornando o email do token
 * como side-effect pós-commit.
 */
export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  tx: Prisma.TransactionClient,
): Promise<WebhookSideEffects> {
  const email = session.customer_email || session.customer_details?.email

  if (!email) {
    throw Errors.webhookFailed()
  }

  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id

  if (!customerId || !subscriptionId) {
    throw Errors.webhookFailed()
  }

  const audits: AuditEventInput[] = []

  // Estado anterior pra discriminar ACCOUNT_CREATED vs ROLE_CHANGED (ASVS V7.1).
  const existingUser = await tx.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  })

  const user = await tx.user.upsert({
    where: { email },
    update: {
      stripeCustomerId: customerId,
      role: 'PRO',
    },
    create: {
      email,
      stripeCustomerId: customerId,
      role: 'PRO',
    },
  })

  if (!existingUser) {
    audits.push({
      action: AuditAction.ACCOUNT_CREATED,
      actor: user.id,
      ip: null,
      userAgent: null,
      success: true,
      metadata: { stripeCustomerId: customerId, reason: 'checkout_completed' },
    })
  } else if (existingUser.role !== 'PRO') {
    audits.push({
      action: AuditAction.ROLE_CHANGED,
      actor: user.id,
      ip: null,
      userAgent: null,
      success: true,
      metadata: {
        from: existingUser.role,
        to: 'PRO',
        reason: 'checkout_completed',
      },
    })
  }

  // Token já existe para este user+subscription? Apenas reativa se necessário.
  const existingToken = await tx.token.findFirst({
    where: {
      userId: user.id,
      stripeSubscriptionId: subscriptionId,
    },
  })

  if (existingToken) {
    if (existingToken.status !== 'ACTIVE') {
      await tx.token.update({
        where: { id: existingToken.id },
        data: { status: 'ACTIVE', expiresAt: null },
      })
    }
    return { audits }
  }

  // Cria novo token. Sem catch P2002: dentro da tx, um conflito aborta a
  // transação e o retry do Stripe reprocessa (achando o token já existente).
  // O @@unique([userId, stripeSubscriptionId]) é a barreira final.
  const token = generateProToken()
  await tx.token.create({
    data: {
      token,
      userId: user.id,
      stripeSubscriptionId: subscriptionId,
      plan: 'PRO',
      status: 'ACTIVE',
    },
  })

  return {
    audits,
    emails: [() => sendTokenEmail({ to: email, token })],
  }
}

/**
 * Handler para customer.subscription.updated — assinatura modificada.
 */
export async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
  tx: Prisma.TransactionClient,
): Promise<WebhookSideEffects> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id

  if (!customerId) {
    throw Errors.webhookFailed()
  }

  const user = await tx.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    throw Errors.webhookFailed()
  }

  const token = await tx.token.findFirst({
    where: {
      userId: user.id,
      stripeSubscriptionId: subscription.id,
    },
  })

  if (!token) {
    throw Errors.webhookFailed()
  }

  let status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED' = 'ACTIVE'
  let expiresAt: Date | null = null
  let userRole: 'FREE' | 'PRO' = 'PRO'

  switch (subscription.status) {
    case 'active':
    case 'trialing':
      status = 'ACTIVE'
      userRole = 'PRO'
      break
    case 'canceled':
      status = 'CANCELLED'
      userRole = 'PRO' // Mantem PRO durante periodo de graca
      break
    case 'past_due':
    case 'unpaid': {
      status = 'ACTIVE'
      userRole = 'PRO'
      const periodEnd = (
        subscription as unknown as {
          current_period_end?: number
        }
      ).current_period_end
      if (periodEnd) {
        expiresAt = new Date(periodEnd * 1000)
      }
      break
    }
    case 'incomplete':
    case 'incomplete_expired':
      status = 'EXPIRED'
      userRole = 'FREE'
      break
  }

  // Writes sequenciais na transação do orquestrador (atômico) — substitui o
  // prisma.$transaction([...]) interno antigo, que não pode aninhar numa tx.
  await tx.token.update({
    where: { id: token.id },
    data: {
      status,
      expiresAt,
      stripeSubscriptionId: subscription.id,
    },
  })
  await tx.user.update({
    where: { id: user.id },
    data: { role: userRole },
  })

  const audits: AuditEventInput[] = []
  // ASVS V7.1: auditar mudança de privilégio só quando houve mudança real.
  if (user.role !== userRole) {
    audits.push({
      action: AuditAction.ROLE_CHANGED,
      actor: user.id,
      ip: null,
      userAgent: null,
      success: true,
      metadata: {
        from: user.role,
        to: userRole,
        reason: `subscription_${subscription.status}`,
      },
    })
  }

  return { audits }
}

/**
 * Handler para customer.subscription.deleted — assinatura cancelada.
 */
export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  tx: Prisma.TransactionClient,
): Promise<WebhookSideEffects> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id

  if (!customerId) {
    throw Errors.webhookFailed()
  }

  const user = await tx.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    throw Errors.webhookFailed()
  }

  const token = await tx.token.findFirst({
    where: {
      userId: user.id,
      stripeSubscriptionId: subscription.id,
    },
  })

  if (!token) {
    throw Errors.webhookFailed()
  }

  const periodEnd = (subscription as unknown as { current_period_end?: number })
    .current_period_end
  const gracePeriodEnd = periodEnd ? new Date(periodEnd * 1000) : new Date()

  await tx.token.update({
    where: { id: token.id },
    data: {
      status: 'CANCELLED',
      expiresAt: gracePeriodEnd,
    },
  })

  return {
    emails: [
      () =>
        sendCancellationEmail({ to: user.email, expiresAt: gracePeriodEnd }),
    ],
  }
}

/**
 * Handler para invoice.payment_failed — pagamento recusado.
 */
export async function handlePaymentFailed(
  invoice: Stripe.Invoice,
  tx: Prisma.TransactionClient,
): Promise<WebhookSideEffects> {
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id

  if (!customerId) {
    throw Errors.webhookFailed()
  }

  const user = await tx.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    throw Errors.webhookFailed()
  }

  // Audita a cobrança recusada (success:false = falha de pagamento, não de
  // gravação). Emitido pós-commit pelo orquestrador.
  return {
    audits: [
      {
        action: AuditAction.PAYMENT_FAILED,
        actor: user.id,
        ip: null,
        userAgent: null,
        success: false,
        metadata: {
          invoiceId: invoice.id,
          customerId,
        },
      },
    ],
    emails: [() => sendPaymentFailedEmail({ to: user.email })],
  }
}
