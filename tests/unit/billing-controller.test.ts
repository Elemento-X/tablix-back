/**
 * Unit tests for billing.controller.ts (Card 1.20 fix)
 * Covers:
 *   - createCheckout: throws 422 CURRENCY_UNAVAILABLE when getPriceId returns undefined
 *   - createCheckout: happy path forwards priceId to createCheckoutSession
 *   - createCheckout: throws 400 VALIDATION_ERROR for invalid body
 *   - portal: throws 401 UNAUTHORIZED when no request.user
 *   - portal: throws 404 NOT_FOUND when user/stripeCustomerId missing
 *   - portal: throws 400 VALIDATION_ERROR for invalid returnUrl
 *   - portal: happy path returns portal URL
 *   - prices: returns currencies array with Cache-Control header
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  createCheckout,
  portal,
  prices,
} from '../../src/http/controllers/billing.controller'
import { AppError, ErrorCodes } from '../../src/errors/app-error'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { prismaMock } = vi.hoisted(() => {
  function createModelMock() {
    return {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    }
  }

  const prismaMock = {
    user: createModelMock(),
  }

  return { prismaMock }
})

const mockGetPriceId = vi.hoisted(() =>
  vi.fn<(currency: string, plan: string) => string | undefined>(),
)
const mockGetAllPrices = vi.hoisted(() => vi.fn())
const mockCreateCheckoutSession = vi.hoisted(() => vi.fn())
const mockCreatePortalSession = vi.hoisted(() => vi.fn())

vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
    JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
    FRONTEND_URL: 'http://localhost:3000',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_brl_monthly_test',
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_brl_yearly_test',
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: 'price_usd_monthly_test',
    STRIPE_PRO_YEARLY_USD_PRICE_ID: 'price_usd_yearly_test',
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
  },
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('../../src/modules/billing/stripe.service', () => ({
  getPriceId: mockGetPriceId,
  getAllPrices: mockGetAllPrices,
  createCheckoutSession: mockCreateCheckoutSession,
  createPortalSession: mockCreatePortalSession,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReply(): any {
  const reply: any = {
    _headers: {} as Record<string, string>,
    _body: undefined as unknown,
    header: vi.fn(function (name: string, value: string) {
      reply._headers[name] = value
      return reply
    }),
    send: vi.fn(function (body: unknown) {
      reply._body = body
      return reply
    }),
  }
  return reply
}

// ---------------------------------------------------------------------------
// 1. createCheckout
// ---------------------------------------------------------------------------

describe('billing.controller.ts — createCheckout (Card 1.20)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deve lançar CURRENCY_UNAVAILABLE (422) quando getPriceId retorna undefined', async () => {
    mockGetPriceId.mockReturnValue(undefined)

    const request: any = {
      body: { email: 'user@example.com', plan: 'monthly', currency: 'EUR' },
    }

    await expect(createCheckout(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.CURRENCY_UNAVAILABLE,
      statusCode: 422,
    })
  })

  it('deve incluir currency e interval nos details do erro 422', async () => {
    mockGetPriceId.mockReturnValue(undefined)

    const request: any = {
      body: { email: 'user@example.com', plan: 'yearly', currency: 'EUR' },
    }

    try {
      await createCheckout(request, makeReply())
      expect.fail('deveria ter lançado')
    } catch (err) {
      const appErr = err as AppError
      expect(appErr.details).toMatchObject({
        currency: 'EUR',
        interval: 'yearly',
      })
    }
  })

  it('deve lançar instância de AppError (não Error genérico) no caso 422', async () => {
    mockGetPriceId.mockReturnValue(undefined)

    const request: any = {
      body: { email: 'user@example.com', plan: 'monthly', currency: 'EUR' },
    }

    try {
      await createCheckout(request, makeReply())
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
    }
  })

  it('não deve lançar CURRENCY_UNAVAILABLE quando priceId está configurado', async () => {
    mockGetPriceId.mockReturnValue('price_brl_monthly_test')
    mockCreateCheckoutSession.mockResolvedValue({
      clientSecret: 'cs_secret_abc',
      sessionId: 'cs_test_123',
    })

    const request: any = {
      body: { email: 'user@example.com', plan: 'monthly', currency: 'BRL' },
    }
    const reply = makeReply()

    await expect(createCheckout(request, reply)).resolves.not.toThrow()
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'price_brl_monthly_test' }),
    )
  })

  it('deve retornar clientSecret e sessionId no happy path', async () => {
    mockGetPriceId.mockReturnValue('price_brl_monthly_test')
    mockCreateCheckoutSession.mockResolvedValue({
      clientSecret: 'cs_secret_abc',
      sessionId: 'cs_test_123',
    })

    const request: any = {
      body: { email: 'user@example.com', plan: 'monthly', currency: 'BRL' },
    }
    const reply = makeReply()

    await createCheckout(request, reply)

    expect(reply.send).toHaveBeenCalledWith({
      clientSecret: 'cs_secret_abc',
      sessionId: 'cs_test_123',
    })
  })

  it('deve lançar VALIDATION_ERROR (400) para body inválido', async () => {
    const request: any = {
      body: { email: 'nao-e-email', plan: 'monthly', currency: 'BRL' },
    }

    await expect(createCheckout(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      statusCode: 400,
    })
  })

  it('deve lançar VALIDATION_ERROR para currency inválido', async () => {
    const request: any = {
      body: { email: 'user@example.com', plan: 'monthly', currency: 'GBP' },
    }

    await expect(createCheckout(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      statusCode: 400,
    })
  })

  it('deve lançar VALIDATION_ERROR para body sem email', async () => {
    const request: any = {
      body: { plan: 'monthly', currency: 'BRL' },
    }

    await expect(createCheckout(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
    })
  })

  it('deve usar defaults (plan=monthly, currency=BRL) quando ausentes no body', async () => {
    mockGetPriceId.mockReturnValue('price_brl_monthly_test')
    mockCreateCheckoutSession.mockResolvedValue({
      clientSecret: 'cs_secret_abc',
      sessionId: 'cs_test_123',
    })

    const request: any = {
      body: { email: 'user@example.com' },
    }

    await createCheckout(request, makeReply())

    expect(mockGetPriceId).toHaveBeenCalledWith('BRL', 'monthly')
  })
})

// ---------------------------------------------------------------------------
// 2. portal
// ---------------------------------------------------------------------------

describe('billing.controller.ts — portal (Card 1.20)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deve lançar UNAUTHORIZED (401) quando request.user ausente', async () => {
    const request: any = {
      user: undefined,
      body: {},
    }

    await expect(portal(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHORIZED,
      statusCode: 401,
    })
  })

  it('deve lançar NOT_FOUND (404) quando usuário não existe no banco', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)

    const request: any = {
      user: { userId: 'usr_abc123' },
      body: {},
    }

    await expect(portal(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
      statusCode: 404,
    })
  })

  it('deve lançar NOT_FOUND (404) quando stripeCustomerId é null', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'usr_abc123',
      stripeCustomerId: null,
    })

    const request: any = {
      user: { userId: 'usr_abc123' },
      body: {},
    }

    await expect(portal(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
      statusCode: 404,
    })
  })

  it('deve lançar VALIDATION_ERROR para returnUrl inválida', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'usr_abc123',
      stripeCustomerId: 'cus_test_123',
    })

    const request: any = {
      user: { userId: 'usr_abc123' },
      body: { returnUrl: 'nao-e-url' },
    }

    await expect(portal(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      statusCode: 400,
    })
  })

  it('deve retornar URL do portal no happy path', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'usr_abc123',
      stripeCustomerId: 'cus_test_123',
    })
    mockCreatePortalSession.mockResolvedValue(
      'https://billing.stripe.com/session/test',
    )

    const request: any = {
      user: { userId: 'usr_abc123' },
      body: { returnUrl: 'https://app.tablix.com.br/dashboard' },
    }
    const reply = makeReply()

    await portal(request, reply)

    expect(reply.send).toHaveBeenCalledWith({
      url: 'https://billing.stripe.com/session/test',
    })
  })

  it('deve usar FRONTEND_URL como returnUrl quando não fornecida', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'usr_abc123',
      stripeCustomerId: 'cus_test_123',
    })
    mockCreatePortalSession.mockResolvedValue(
      'https://billing.stripe.com/session/test',
    )

    const request: any = {
      user: { userId: 'usr_abc123' },
      body: {},
    }

    await portal(request, makeReply())

    expect(mockCreatePortalSession).toHaveBeenCalledWith(
      'cus_test_123',
      'http://localhost:3000',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. prices
// ---------------------------------------------------------------------------

describe('billing.controller.ts — prices (Card 1.20)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAllPrices.mockReturnValue([
      {
        currency: 'BRL',
        monthly: { available: true },
        yearly: { available: true },
      },
      {
        currency: 'USD',
        monthly: { available: true },
        yearly: { available: true },
      },
    ])
  })

  it('deve retornar currencies via getAllPrices', async () => {
    const request: any = {}
    const reply = makeReply()

    await prices(request, reply)

    expect(reply.send).toHaveBeenCalledWith({
      currencies: expect.arrayContaining([
        expect.objectContaining({ currency: 'BRL' }),
        expect.objectContaining({ currency: 'USD' }),
      ]),
    })
  })

  it('deve setar Cache-Control: public, max-age=300', async () => {
    const request: any = {}
    const reply = makeReply()

    await prices(request, reply)

    expect(reply.header).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=300',
    )
  })

  it('deve retornar array vazio em currencies quando nenhuma moeda configurada', async () => {
    mockGetAllPrices.mockReturnValue([])

    const request: any = {}
    const reply = makeReply()

    await prices(request, reply)

    expect(reply.send).toHaveBeenCalledWith({ currencies: [] })
  })
})
