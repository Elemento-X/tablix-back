import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { generateProToken } from '../../lib/token-generator'
import { Errors } from '../../errors/app-error'
import {
  sendTokenEmail,
  sendCancellationEmail,
  sendPaymentFailedEmail,
} from '../../lib/email'

/**
 * Handler para checkout.session.completed
 * Executado quando o pagamento e confirmado.
 *
 * Atomicidade: usa upsert no User e create com unique compound
 * (userId + stripeSubscriptionId) no Token para prevenir duplicatas
 * em cenarios de retry/replay.
 *
 * Defense-in-depth: token.create envolto em try/catch P2002
 * para tratar race condition entre findFirst e create.
 */
export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
) {
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

  // Cria ou encontra User (upsert por email - atomico)
  const user = await prisma.user.upsert({
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

  // Upsert do Token usando unique compound (userId + stripeSubscriptionId).
  // Se ja existe token para este user+subscription, apenas atualiza status.
  // Se nao existe, cria novo token.
  const token = generateProToken()

  const existingToken = await prisma.token.findFirst({
    where: {
      userId: user.id,
      stripeSubscriptionId: subscriptionId,
    },
  })

  if (existingToken) {
    // Token ja existe para este user+subscription - atualiza se necessario
    if (existingToken.status !== 'ACTIVE') {
      await prisma.token.update({
        where: { id: existingToken.id },
        data: {
          status: 'ACTIVE',
          expiresAt: null,
        },
      })
    }
    return
  }

  // Cria novo token com catch P2002 para race condition.
  // Se duas requests passam o findFirst ao mesmo tempo,
  // a segunda falha no unique constraint e e tratada como duplicata.
  try {
    await prisma.token.create({
      data: {
        token,
        userId: user.id,
        stripeSubscriptionId: subscriptionId,
        plan: 'PRO',
        status: 'ACTIVE',
      },
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      // Race condition: outra request criou o token entre findFirst e create.
      // Duplicata segura — nao propagar erro.
      return
    }
    throw error
  }

  // Envia email com o token (fire-and-forget)
  try {
    await sendTokenEmail({ to: email, token })
  } catch {
    // Falha de email nao deve bloquear o webhook
  }
}

/**
 * Handler para customer.subscription.updated
 * Executado quando a assinatura e modificada
 */
export async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id

  if (!customerId) {
    throw Errors.webhookFailed()
  }

  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    throw Errors.webhookFailed()
  }

  const token = await prisma.token.findFirst({
    where: {
      userId: user.id,
      stripeSubscriptionId: subscription.id,
    },
  })

  if (!token) {
    throw Errors.webhookFailed()
  }

  // Atualiza status baseado no status da subscription
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

  // Atualiza token e role do user em transacao
  await prisma.$transaction([
    prisma.token.update({
      where: { id: token.id },
      data: {
        status,
        expiresAt,
        stripeSubscriptionId: subscription.id,
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { role: userRole },
    }),
  ])
}

/**
 * Handler para customer.subscription.deleted
 * Executado quando a assinatura e cancelada definitivamente
 */
export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id

  if (!customerId) {
    throw Errors.webhookFailed()
  }

  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    throw Errors.webhookFailed()
  }

  const token = await prisma.token.findFirst({
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

  // Marca token como cancelado com periodo de graca
  await prisma.token.update({
    where: { id: token.id },
    data: {
      status: 'CANCELLED',
      expiresAt: gracePeriodEnd,
    },
  })

  // Envia email de cancelamento (fire-and-forget)
  try {
    await sendCancellationEmail({
      to: user.email,
      expiresAt: gracePeriodEnd,
    })
  } catch {
    // Falha de email nao deve bloquear o webhook
  }
}

/**
 * Handler para invoice.payment_failed
 * Executado quando o pagamento falha
 */
export async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id

  if (!customerId) {
    throw Errors.webhookFailed()
  }

  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    throw Errors.webhookFailed()
  }

  // Envia email de falha (fire-and-forget)
  try {
    await sendPaymentFailedEmail({ to: user.email })
  } catch {
    // Falha de email nao deve bloquear o webhook
  }
}
