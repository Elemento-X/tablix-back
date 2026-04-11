import Stripe from 'stripe'
import { prisma } from '../../lib/prisma'
import { generateProToken } from '../../lib/token-generator'
import {
  sendTokenEmail,
  sendCancellationEmail,
  sendPaymentFailedEmail,
} from '../../lib/email'

/**
 * Handler para checkout.session.completed
 * Executado quando o pagamento é confirmado
 * - Cria User (ou encontra existente)
 * - Cria Token Pro
 * - Envia email com token
 */
export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
) {
  const email = session.customer_email || session.customer_details?.email

  if (!email) {
    console.error('[Webhook] checkout.session.completed sem email:', session.id)
    return
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
    console.error(
      '[Webhook] checkout.session.completed sem customer/subscription:',
      session.id,
    )
    return
  }

  // Cria ou encontra User (upsert por email)
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

  // Verifica se já existe token para este user
  const existingToken = await prisma.token.findFirst({
    where: { userId: user.id },
  })

  if (existingToken) {
    // Atualiza subscription se mudou
    if (existingToken.stripeSubscriptionId !== subscriptionId) {
      await prisma.token.update({
        where: { id: existingToken.id },
        data: {
          stripeSubscriptionId: subscriptionId,
          status: 'ACTIVE',
          expiresAt: null,
        },
      })
    }
    return
  }

  // Gera novo token Pro
  const token = generateProToken()

  // Cria registro no banco vinculado ao User
  await prisma.token.create({
    data: {
      token,
      userId: user.id,
      stripeSubscriptionId: subscriptionId,
      plan: 'PRO',
      status: 'ACTIVE',
    },
  })

  // Envia email com o token
  try {
    await sendTokenEmail({ to: email, token })
  } catch {
    // Falha de email não deve bloquear o webhook
  }
}

/**
 * Handler para customer.subscription.updated
 * Executado quando a assinatura é modificada
 */
export async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id

  if (!customerId) {
    console.error(
      '[Webhook] subscription.updated sem customer:',
      subscription.id,
    )
    return
  }

  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    console.error('[Webhook] User não encontrado para customer:', customerId)
    return
  }

  const token = await prisma.token.findFirst({
    where: { userId: user.id },
  })

  if (!token) {
    console.error('[Webhook] Token não encontrado para user:', user.id)
    return
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
      userRole = 'PRO' // Mantém PRO durante período de graça
      break
    case 'past_due':
    case 'unpaid': {
      status = 'ACTIVE'
      userRole = 'PRO'
      const periodEnd = (
        subscription as unknown as { current_period_end?: number }
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

  // Atualiza token e role do user em transação
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

  console.log('[Webhook] Subscription atualizada:', {
    userId: user.id,
    status: subscription.status,
    tokenStatus: status,
    userRole,
  })
}

/**
 * Handler para customer.subscription.deleted
 * Executado quando a assinatura é cancelada definitivamente
 */
export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id

  if (!customerId) {
    console.error(
      '[Webhook] subscription.deleted sem customer:',
      subscription.id,
    )
    return
  }

  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    console.error('[Webhook] User não encontrado para customer:', customerId)
    return
  }

  const token = await prisma.token.findFirst({
    where: { userId: user.id },
  })

  if (!token) {
    console.error('[Webhook] Token não encontrado para user:', user.id)
    return
  }

  const periodEnd = (subscription as unknown as { current_period_end?: number })
    .current_period_end
  const gracePeriodEnd = periodEnd ? new Date(periodEnd * 1000) : new Date()

  // Marca token como cancelado com período de graça
  // User mantém role PRO até o período expirar
  await prisma.token.update({
    where: { id: token.id },
    data: {
      status: 'CANCELLED',
      expiresAt: gracePeriodEnd,
    },
  })

  try {
    await sendCancellationEmail({
      to: user.email,
      expiresAt: gracePeriodEnd,
    })
  } catch {
    // Falha de email não deve bloquear o webhook
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
    console.error('[Webhook] invoice.payment_failed sem customer:', invoice.id)
    return
  }

  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
  })

  if (!user) {
    console.error('[Webhook] User não encontrado para customer:', customerId)
    return
  }

  console.log('[Webhook] Pagamento falhou:', {
    userId: user.id,
    invoiceId: invoice.id,
  })

  try {
    await sendPaymentFailedEmail({ to: user.email })
  } catch {
    // Falha de email não deve bloquear o webhook
  }
}
