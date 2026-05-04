import { FastifyRequest, FastifyReply } from 'fastify'
import {
  createCheckoutSchema,
  createPortalSchema,
} from '../../modules/billing/billing.schema'
import {
  createCheckoutSession,
  createPortalSession,
  getPriceId,
  getAllPrices,
} from '../../modules/billing/stripe.service'
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  releaseIdempotencyKey,
  hashBody,
  IDEMPOTENCY_CONSTANTS,
} from '../../lib/idempotency/idempotency.service'
import { env } from '../../config/env'
import { Errors } from '../../errors/app-error'
import { prisma } from '../../lib/prisma'

interface CheckoutResponsePayload {
  clientSecret: string
  sessionId: string
}

/**
 * POST /billing/create-checkout
 * Cria uma sessão de checkout embedded do Stripe.
 *
 * Card #74 (3.4) — Idempotency-Key:
 * Cliente pode enviar header `Idempotency-Key: <uuid>`. Semântica:
 *   - hit: mesma key + mesmo body → retorna resposta cached (sem chamar Stripe)
 *   - miss: primeira execução; resultado é cacheado por 24h
 *   - conflict: mesma key + body diferente → 422 IDEMPOTENCY_CONFLICT
 *   - in_progress: outra request com mesma key em execução → 409 IDEMPOTENCY_IN_PROGRESS
 *
 * Identifier do scope: `email` do body (normalizado lowercase). Evita colisão
 * entre clientes — atacante com acesso a key de outro email não consegue
 * sobrescrever/ler resposta alheia.
 */
export async function createCheckout(
  request: FastifyRequest<{
    Headers: { 'idempotency-key'?: string }
    Body: {
      email: string
      plan?: 'monthly' | 'yearly'
      currency?: 'BRL' | 'USD' | 'EUR'
    }
  }>,
  reply: FastifyReply,
) {
  const validation = createCheckoutSchema.safeParse(request.body)

  if (!validation.success) {
    throw Errors.validationError('Dados inválidos', {
      errors: validation.error.flatten().fieldErrors,
    })
  }

  const { email, plan, currency } = validation.data
  const priceId = getPriceId(currency, plan)

  if (!priceId) {
    throw Errors.currencyUnavailable(currency, plan)
  }

  const idempotencyKey = request.headers['idempotency-key']
  const hasIdempotency =
    typeof idempotencyKey === 'string' && idempotencyKey.length > 0

  // Sem Idempotency-Key: caminho original, sem proteção (comportamento legado
  // preservado para clientes que ainda não adotaram o header).
  if (!hasIdempotency) {
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

  // Com Idempotency-Key: fluxo protegido via Redis SETNX.
  // identifier='public' segue padrão Stripe — key de idempotência é global
  // dentro do scope, não escopada por email. Garante que mesma key com
  // emails diferentes = conflict (detectado), não 2 locks paralelos. Email
  // entra no bodyHash pra detecção de body drift.
  const identifier = 'public'
  const bodyHash = hashBody({ email: email.toLowerCase(), plan, currency })
  const scope = 'checkout'

  const begin = await beginIdempotentOperation<CheckoutResponsePayload>({
    key: idempotencyKey,
    scope,
    identifier,
    bodyHash,
  })

  if (begin.status === 'hit' && begin.cached) {
    // Retry legítimo do cliente — devolve o mesmo resultado sem chamar Stripe
    reply.header('Idempotency-Replay', 'true')
    return reply.send(begin.cached)
  }

  if (begin.status === 'conflict') {
    throw Errors.idempotencyConflict()
  }

  if (begin.status === 'in_progress') {
    reply.header('Retry-After', '2')
    throw Errors.idempotencyInProgress()
  }

  // Fail-open observability (@dba Card #74 MÉDIO): Redis falhou, operação
  // prossegue sem proteção. Cliente recebe header pra ciência; ops tem log
  // estruturado (metric: idempotency.degraded) pra alarmar.
  if (begin.degraded) {
    reply.header('Idempotency-Degraded', 'true')
  }

  // miss: adquiriu o lock, pode executar. Forwarda a key pro Stripe SDK pra
  // defesa em profundidade (Stripe também dedupa por 24h quando recebe a
  // mesma idempotencyKey). Falha entre Stripe OK e Redis store = próximo
  // retry re-executa (release explícito em catch).
  try {
    const result = await createCheckoutSession({
      email,
      priceId,
      successUrl: `${env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${env.FRONTEND_URL}/checkout/cancel`,
      idempotencyKey,
    })

    await completeIdempotentOperation<CheckoutResponsePayload>({
      key: idempotencyKey,
      scope,
      identifier,
      bodyHash,
      data: {
        clientSecret: result.clientSecret,
        sessionId: result.sessionId,
      },
    })

    return reply.send({
      clientSecret: result.clientSecret,
      sessionId: result.sessionId,
    })
  } catch (err) {
    // Libera a key em falha pra permitir retry imediato do cliente (sem
    // esperar 24h). Fail-and-forget no release — se Redis estiver fora,
    // a key expira naturalmente pelo TTL original.
    await releaseIdempotencyKey({ key: idempotencyKey, scope, identifier })
    throw err
  }
}

/**
 * POST /billing/portal
 * Gera URL para o Customer Portal do Stripe
 */
export async function portal(
  request: FastifyRequest<{ Body: { returnUrl?: string } }>,
  reply: FastifyReply,
) {
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

  const validation = createPortalSchema.safeParse(request.body)

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
  return reply.header('Cache-Control', 'public, max-age=300').send({
    currencies: getAllPrices(),
  })
}

// Re-export helpers usados em testes de integração (ex: para limpar keys
// idempotency entre testes).
export { IDEMPOTENCY_CONSTANTS }
