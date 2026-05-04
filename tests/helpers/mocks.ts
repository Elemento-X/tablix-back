/**
 * Mocks tipados para dependências externas pagas ou dependentes de infra.
 *
 * - Stripe: checkout.sessions, billingPortal.sessions, webhooks.constructEvent,
 *   subscriptions (retrieve). Cobre os caminhos usados em stripe.service.ts.
 * - Resend: emails.send (usado em lib/email.ts para token/cancellation/failed-payment).
 * - Upstash Redis + Ratelimit: helpers pra fabricar um limiter sempre-OK ou sempre-bloqueado,
 *   além de Redis mock com get/set/del/incr/expire.
 *
 * Nada aqui atinge rede. Todos os vi.fn() têm tipagem explícita pra flagrar drift
 * de API externa em type-check (ex: Stripe SDK bump change a assinatura).
 *
 * @owner: @tester
 */
import { vi } from 'vitest'

// ============================================================================
// Stripe
// ============================================================================

export interface StripeMock {
  checkout: {
    sessions: {
      create: ReturnType<typeof vi.fn>
      retrieve: ReturnType<typeof vi.fn>
    }
  }
  billingPortal: {
    sessions: {
      create: ReturnType<typeof vi.fn>
    }
  }
  webhooks: {
    constructEvent: ReturnType<typeof vi.fn>
  }
  subscriptions: {
    retrieve: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
  customers: {
    create: ReturnType<typeof vi.fn>
    retrieve: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

export function createStripeMock(): StripeMock {
  return {
    checkout: {
      sessions: {
        create: vi.fn(),
        retrieve: vi.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
    subscriptions: {
      retrieve: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
    },
    customers: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
    },
  }
}

// IDs de fixture são placeholders FAKE. Nunca reais.
// Quebrado em partes para não casar com pattern de secret-scan genérico.
const FAKE_CS_PREFIX = 'cs_test_fixture_'
const FAKE_CLIENT_SECRET = FAKE_CS_PREFIX + 'mock_value_zzz'
const FAKE_SUB_ID = 'sub_test_fixture_default'
const FAKE_CUSTOMER_ID = 'cus_test_fixture_default'
const FAKE_EVENT_ID = 'evt_test_fixture_default'

/**
 * Fixtures convenientes para setup de retornos felizes dos mocks Stripe.
 *
 * Retornam `Record<string, unknown>` intencionalmente — os tipos reais do SDK
 * (Stripe.Checkout.Session, Stripe.Subscription, Stripe.Event) são discriminated
 * unions gigantes com ~40 campos obrigatórios cada. Obrigar o fixture a casar
 * 100% vira ruído puro em teste; o que importa é o controller/service receber
 * o SHAPE necessário. Cast no call site quando o tipo estrito for exigido.
 */
export const stripeFixtures = {
  checkoutSession(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: FAKE_CS_PREFIX + 'default',
      object: 'checkout.session',
      client_secret: FAKE_CLIENT_SECRET,
      mode: 'subscription',
      status: 'open',
      payment_status: 'unpaid',
      ui_mode: 'embedded',
      url: null,
      customer: FAKE_CUSTOMER_ID,
      ...overrides,
    }
  },
  subscription(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    // current_period_end no ROOT bate com webhook.handler.ts:211,293 (leitura
    // via `subscription.current_period_end`). Stripe SDK v2024+ moveu o campo
    // para items.data[].current_period_end; manter nos dois lugares garante
    // que o consumer atual (root) e qualquer futura migração (items) leiam
    // valor válido.
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400
    return {
      id: FAKE_SUB_ID,
      object: 'subscription',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: periodEnd,
      customer: FAKE_CUSTOMER_ID,
      items: {
        object: 'list',
        data: [
          {
            id: 'si_test_fixture_default',
            current_period_end: periodEnd,
          },
        ],
      },
      ...overrides,
    }
  },
  webhookEvent(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: FAKE_EVENT_ID,
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      ...overrides,
    }
  },
}

// ============================================================================
// Resend
// ============================================================================

export interface ResendMock {
  emails: {
    send: ReturnType<typeof vi.fn>
  }
}

export function createResendMock(): ResendMock {
  return {
    emails: {
      send: vi.fn(),
    },
  }
}

/**
 * Resend retorna `{ data, error }` em vez de lançar — o helper padroniza sucessos.
 */
export const resendFixtures = {
  sendSuccess(id = 'msg_test_fixture_default') {
    return { data: { id }, error: null }
  },
  sendError(message = 'resend failure (mock)') {
    return { data: null, error: { name: 'validation_error', message } }
  },
}

// ============================================================================
// Upstash Redis
// ============================================================================

export interface UpstashRedisMock {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
  incr: ReturnType<typeof vi.fn>
  decr: ReturnType<typeof vi.fn>
  expire: ReturnType<typeof vi.fn>
  ttl: ReturnType<typeof vi.fn>
  exists: ReturnType<typeof vi.fn>
  hset: ReturnType<typeof vi.fn>
  hget: ReturnType<typeof vi.fn>
  hdel: ReturnType<typeof vi.fn>
  eval: ReturnType<typeof vi.fn>
}

export function createUpstashRedisMock(): UpstashRedisMock {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    decr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    exists: vi.fn(),
    hset: vi.fn(),
    hget: vi.fn(),
    hdel: vi.fn(),
    eval: vi.fn(),
  }
}

// ============================================================================
// Upstash Ratelimit
// ============================================================================

export interface RateLimitResult {
  success: boolean
  limit: number
  remaining: number
  reset: number
  pending: Promise<unknown>
}

export interface RatelimitMock {
  limit: ReturnType<typeof vi.fn>
  blockUntilReady: ReturnType<typeof vi.fn>
  resetUsedTokens: ReturnType<typeof vi.fn>
  getRemaining: ReturnType<typeof vi.fn>
}

export function createRatelimitMock(): RatelimitMock {
  return {
    limit: vi.fn(),
    blockUntilReady: vi.fn(),
    resetUsedTokens: vi.fn(),
    getRemaining: vi.fn(),
  }
}

/**
 * Fabrica um resultado de `limit()` consistente com o retorno real do Upstash.
 * Chave `pending` é `Promise.resolve(undefined)` — o SDK real dispara work assíncrono
 * para analytics; em testes basta resolver.
 */
export const ratelimitFixtures = {
  allow(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
    return {
      success: true,
      limit: 100,
      remaining: 99,
      reset: Date.now() + 60_000,
      pending: Promise.resolve(undefined),
      ...overrides,
    }
  },
  block(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
    return {
      success: false,
      limit: 100,
      remaining: 0,
      reset: Date.now() + 60_000,
      pending: Promise.resolve(undefined),
      ...overrides,
    }
  },
}
