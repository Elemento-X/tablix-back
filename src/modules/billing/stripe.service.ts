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
  /**
   * Card #74 — Idempotency-Key encaminhada ao Stripe SDK (`idempotencyKey`
   * option). Stripe dedupa chamadas idênticas por 24h mesmo sem nosso
   * cache Redis — defesa em profundidade.
   */
  idempotencyKey?: string
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
    const session = await stripeClient.checkout.sessions.create(
      {
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
      },
      // 2º argumento — RequestOptions do Stripe SDK. `idempotencyKey` ali
      // garante que Stripe dedupe a chamada no lado deles (além do nosso
      // cache Redis).
      params.idempotencyKey
        ? { idempotencyKey: params.idempotencyKey }
        : undefined,
    )

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

export type Currency = 'BRL' | 'USD' | 'EUR'
export type Interval = 'monthly' | 'yearly'

/**
 * Mapa de preços por moeda e intervalo.
 * Resolução server-side — cliente nunca envia priceId.
 */
const PRICE_MAP: Record<Currency, Record<Interval, string | undefined>> = {
  BRL: {
    monthly: env.STRIPE_PRO_MONTHLY_BRL_PRICE_ID,
    yearly: env.STRIPE_PRO_YEARLY_BRL_PRICE_ID,
  },
  USD: {
    monthly: env.STRIPE_PRO_MONTHLY_USD_PRICE_ID,
    yearly: env.STRIPE_PRO_YEARLY_USD_PRICE_ID,
  },
  EUR: {
    monthly: env.STRIPE_PRO_MONTHLY_EUR_PRICE_ID,
    yearly: env.STRIPE_PRO_YEARLY_EUR_PRICE_ID,
  },
}

/**
 * Retorna o priceId para uma moeda e intervalo específicos.
 * Retorna undefined se não configurado.
 */
export function getPriceId(
  currency: Currency,
  interval: Interval,
): string | undefined {
  return PRICE_MAP[currency]?.[interval]
}

/**
 * Retorna preços disponíveis por moeda.
 * Filtra currencies sem nenhum price configurado (evita expor config operacional).
 */
export function getAllPrices() {
  return Object.entries(PRICE_MAP)
    .filter(([, intervals]) => intervals.monthly || intervals.yearly)
    .map(([currency, intervals]) => ({
      currency,
      monthly: {
        available: !!intervals.monthly,
      },
      yearly: {
        available: !!intervals.yearly,
      },
    }))
}
