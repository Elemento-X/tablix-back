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
 * - Cria registro no banco
 * - Gera token Pro
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

  // Verifica se já existe token para este customer
  const existingToken = await prisma.token.findFirst({
    where: { stripeCustomerId: customerId },
  })

  if (existingToken) {
    console.log('[Webhook] Token já existe para customer:', customerId)
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

  // Cria registro no banco
  await prisma.token.create({
    data: {
      token,
      email,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      plan: 'PRO',
      status: 'ACTIVE',
    },
  })

  console.log('[Webhook] Token Pro criado para:', email)

  // Envia email com o token
  try {
    await sendTokenEmail({ to: email, token })
    console.log('[Webhook] Email com token enviado para:', email)
  } catch (error) {
    // Log do erro mas não falha o webhook
    // O token foi criado, email pode ser reenviado manualmente se necessário
    console.error('[Webhook] Falha ao enviar email com token:', error)
  }
}

/**
 * Handler para customer.subscription.updated
 * Executado quando a assinatura é modificada (upgrade, downgrade, etc)
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

  const token = await prisma.token.findFirst({
    where: { stripeCustomerId: customerId },
  })

  if (!token) {
    console.error('[Webhook] Token não encontrado para customer:', customerId)
    return
  }

  // Atualiza status baseado no status da subscription
  let status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED' = 'ACTIVE'
  let expiresAt: Date | null = null

  switch (subscription.status) {
    case 'active':
    case 'trialing':
      status = 'ACTIVE'
      break
    case 'canceled':
      status = 'CANCELLED'
      break
    case 'past_due':
    case 'unpaid': {
      // Mantém ativo mas marca data de expiração
      status = 'ACTIVE'
      // current_period_end pode estar em items.data[0] nas versões mais recentes do Stripe
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
      break
  }

  await prisma.token.update({
    where: { id: token.id },
    data: {
      status,
      expiresAt,
      stripeSubscriptionId: subscription.id,
    },
  })

  console.log('[Webhook] Subscription atualizada:', {
    customer: customerId,
    status: subscription.status,
    tokenStatus: status,
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

  const token = await prisma.token.findFirst({
    where: { stripeCustomerId: customerId },
  })

  if (!token) {
    console.error('[Webhook] Token não encontrado para customer:', customerId)
    return
  }

  // Marca como cancelado com data de expiração no fim do período pago
  const periodEnd = (subscription as unknown as { current_period_end?: number })
    .current_period_end
  const expiresAt = periodEnd ? new Date(periodEnd * 1000) : new Date()

  await prisma.token.update({
    where: { id: token.id },
    data: {
      status: 'CANCELLED',
      expiresAt,
    },
  })

  console.log('[Webhook] Subscription cancelada:', customerId)

  // Envia email notificando cancelamento
  try {
    await sendCancellationEmail({ to: token.email, expiresAt })
    console.log('[Webhook] Email de cancelamento enviado para:', token.email)
  } catch (error) {
    console.error('[Webhook] Falha ao enviar email de cancelamento:', error)
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

  const token = await prisma.token.findFirst({
    where: { stripeCustomerId: customerId },
  })

  if (!token) {
    console.error('[Webhook] Token não encontrado para customer:', customerId)
    return
  }

  console.log('[Webhook] Pagamento falhou:', {
    customer: customerId,
    email: token.email,
    invoiceId: invoice.id,
  })

  // Envia email notificando falha de pagamento
  try {
    await sendPaymentFailedEmail({ to: token.email })
    console.log(
      '[Webhook] Email de falha de pagamento enviado para:',
      token.email,
    )
  } catch (error) {
    console.error(
      '[Webhook] Falha ao enviar email de falha de pagamento:',
      error,
    )
  }
}
