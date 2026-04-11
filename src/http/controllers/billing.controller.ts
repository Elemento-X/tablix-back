import { FastifyRequest, FastifyReply } from 'fastify'
import {
  createCheckoutSchema,
  createPortalSchema,
} from '../../modules/billing/billing.schema'
import {
  createCheckoutSession,
  createPortalSession,
  getPriceIds,
} from '../../modules/billing/stripe.service'
import { env } from '../../config/env'
import { Errors } from '../../errors/app-error'
import { prisma } from '../../lib/prisma'

/**
 * POST /billing/create-checkout
 * Cria uma sessão de checkout embedded do Stripe
 */
export async function createCheckout(
  request: FastifyRequest<{
    Body: { email: string; plan?: 'monthly' | 'yearly' }
  }>,
  reply: FastifyReply,
) {
  const validation = createCheckoutSchema.safeParse(request.body)

  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  const { email, plan } = validation.data
  const priceIds = getPriceIds()

  const priceId = plan === 'yearly' ? priceIds.yearly : priceIds.monthly

  if (!priceId) {
    throw Errors.internal(`Price ID para plano ${plan} não configurado`)
  }

  const result = await createCheckoutSession({
    email,
    priceId,
    successUrl: `${env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${env.FRONTEND_URL}/checkout/cancel`,
  })

  return reply.send({
    clientSecret: result.clientSecret,
    sessionId: result.sessionId,
  })
}

/**
 * POST /billing/portal
 * Gera URL para o Customer Portal do Stripe
 */
export async function portal(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { returnUrl?: string } | undefined

  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  // Busca o User para pegar o stripeCustomerId
  const user = await prisma.user.findUnique({
    where: { id: request.user.userId },
  })

  if (!user || !user.stripeCustomerId) {
    throw Errors.notFound('Usuário ou assinatura')
  }

  const validation = createPortalSchema.safeParse(body)

  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  const { returnUrl } = validation.data
  const portalUrl = await createPortalSession(
    user.stripeCustomerId,
    returnUrl || env.FRONTEND_URL,
  )

  return reply.send({ url: portalUrl })
}

/**
 * GET /billing/prices
 * Retorna os preços disponíveis (para exibição no frontend)
 */
export async function prices(request: FastifyRequest, reply: FastifyReply) {
  const priceIds = getPriceIds()

  return reply.send({
    monthly: {
      priceId: priceIds.monthly,
      available: !!priceIds.monthly,
    },
    yearly: {
      priceId: priceIds.yearly,
      available: !!priceIds.yearly,
    },
  })
}
