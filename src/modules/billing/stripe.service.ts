import Stripe from 'stripe'
import { env } from '../../config/env'
import { Errors } from '../../errors/app-error'

// Inicializa Stripe apenas se a chave estiver configurada
const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
      typescript: true,
    })
  : null

function getStripe(): Stripe {
  if (!stripe) {
    throw Errors.internal()
  }
  return stripe
}

export interface CreateCheckoutParams {
  email: string
  priceId: string
  successUrl: string
  cancelUrl: string
}

export interface CreateCheckoutResult {
  clientSecret: string
  sessionId: string
}

/**
 * Cria uma sessão de checkout embedded do Stripe
 */
export async function createCheckoutSession(
  params: CreateCheckoutParams,
): Promise<CreateCheckoutResult> {
  const stripeClient = getStripe()

  try {
    const session = await stripeClient.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: params.email,
      line_items: [
        {
          price: params.priceId,
          quantity: 1,
        },
      ],
      ui_mode: 'embedded',
      return_url: params.successUrl,
      metadata: {
        email: params.email,
      },
    })

    if (!session.client_secret) {
      throw Errors.checkoutFailed('Stripe não retornou client_secret')
    }

    return {
      clientSecret: session.client_secret,
      sessionId: session.id,
    }
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      throw Errors.checkoutFailed()
    }
    throw error
  }
}

/**
 * Cria URL para o Customer Portal do Stripe
 */
export async function createPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const stripeClient = getStripe()

  try {
    const session = await stripeClient.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    })

    return session.url
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      throw Errors.portalFailed()
    }
    throw error
  }
}

/**
 * Valida a assinatura do webhook do Stripe
 */
export function constructWebhookEvent(
  payload: Buffer,
  signature: string,
): Stripe.Event {
  const stripeClient = getStripe()

  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw Errors.webhookFailed()
  }

  try {
    return stripeClient.webhooks.constructEvent(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    )
  } catch (error) {
    if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
      throw Errors.webhookFailed('Assinatura do webhook inválida')
    }
    throw error
  }
}

/**
 * Busca detalhes de uma sessão de checkout
 */
export async function getCheckoutSession(
  sessionId: string,
): Promise<Stripe.Checkout.Session> {
  const stripeClient = getStripe()

  try {
    return await stripeClient.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'customer'],
    })
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      throw Errors.internal('Erro ao buscar sessão de checkout')
    }
    throw error
  }
}

/**
 * Busca detalhes de uma assinatura
 */
export async function getSubscription(
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  const stripeClient = getStripe()

  try {
    return await stripeClient.subscriptions.retrieve(subscriptionId)
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      throw Errors.internal('Erro ao buscar assinatura')
    }
    throw error
  }
}

/**
 * Retorna os IDs de preço configurados
 */
export function getPriceIds() {
  return {
    monthly: env.STRIPE_PRO_MONTHLY_PRICE_ID,
    yearly: env.STRIPE_PRO_YEARLY_PRICE_ID,
  }
}
