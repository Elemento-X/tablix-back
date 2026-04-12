/**
 * Unit tests for rate-limit.middleware.ts (Card 1.20 fix)
 * Covers:
 *   - rateLimitMiddleware export object contains all expected keys (regression guard)
 *   - checkout key exists and is a function (direct regression test for the fix)
 *   - createRateLimitMiddleware returns a function
 *   - middleware skips when rate limiting disabled (isRateLimitEnabled returns false)
 *   - middleware skips when limiter is null for given type
 *   - middleware sets X-RateLimit-* headers and passes when success
 *   - middleware throws AppError RATE_LIMITED (429) when limit exceeded
 *   - identifier uses userId when request.user is present
 *   - identifier falls back to x-forwarded-for IP
 *   - identifier falls back to request.ip
 *   - identifier falls back to 'unknown' when all sources are absent
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mocks (hoisted) ---
const { mockIsRateLimitEnabled, mockRateLimiters } = vi.hoisted(() => {
  const mockLimiter = {
    limit: vi.fn(),
  }

  const mockRateLimiters = {
    global: mockLimiter,
    validateToken: mockLimiter,
    authRefresh: mockLimiter,
    authMe: mockLimiter,
    checkout: mockLimiter,
    billing: mockLimiter,
    process: mockLimiter,
  } as const

  const mockIsRateLimitEnabled = vi.fn<() => boolean>()

  return { mockIsRateLimitEnabled, mockRateLimiters, mockLimiter }
})

vi.mock('../../src/config/rate-limit', () => ({
  rateLimiters: mockRateLimiters,
  isRateLimitEnabled: mockIsRateLimitEnabled,
}))

import {
  createRateLimitMiddleware,
  rateLimitMiddleware,
} from '../../src/middleware/rate-limit.middleware'
import { AppError, ErrorCodes } from '../../src/errors/app-error'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T

function makeRequest(
  overrides: DeepPartial<{
    user: { userId: string }
    headers: Record<string, string | string[]>
    ip: string
  }> = {},
): any {
  return {
    user: overrides.user,
    headers: overrides.headers ?? {},
    ip: overrides.ip ?? '',
  }
}

function makeReply(): any {
  return {
    header: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// 1. Export shape — regression guard for the Card 1.20 fix
// ---------------------------------------------------------------------------

describe('rateLimitMiddleware — export shape', () => {
  const EXPECTED_KEYS = [
    'global',
    'validateToken',
    'authRefresh',
    'authMe',
    'checkout',
    'billing',
    'process',
  ] as const

  it('deve exportar todas as chaves esperadas', () => {
    for (const key of EXPECTED_KEYS) {
      expect(rateLimitMiddleware).toHaveProperty(key)
    }
  })

  it('deve exportar checkout como função (fix Card 1.20)', () => {
    expect(typeof rateLimitMiddleware.checkout).toBe('function')
  })

  it.each(EXPECTED_KEYS)('deve exportar %s como função', (key) => {
    expect(typeof rateLimitMiddleware[key]).toBe('function')
  })

  it('não deve ter chaves extras não documentadas', () => {
    const actualKeys = Object.keys(rateLimitMiddleware).sort()
    const expectedKeys = [...EXPECTED_KEYS].sort()
    expect(actualKeys).toEqual(expectedKeys)
  })
})

// ---------------------------------------------------------------------------
// 2. createRateLimitMiddleware — factory
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware — factory', () => {
  it('deve retornar uma função async', () => {
    const mw = createRateLimitMiddleware('checkout')
    expect(typeof mw).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 3. Middleware behaviour — rate limit disabled
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware — rate limit desabilitado', () => {
  beforeEach(() => {
    mockIsRateLimitEnabled.mockReturnValue(false)
  })

  it('deve retornar sem chamar limiter quando desabilitado', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest()
    const reply = makeReply()

    await expect(mw(request, reply)).resolves.toBeUndefined()
    expect(mockRateLimiters.checkout.limit).not.toHaveBeenCalled()
  })

  it('não deve setar headers quando desabilitado', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    await mw(makeRequest(), reply)

    expect(reply.header).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. Middleware behaviour — limiter is null for the type
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware — limiter null para o tipo', () => {
  beforeEach(() => {
    mockIsRateLimitEnabled.mockReturnValue(true)
    // Override rateLimiters to return null for 'checkout'
    ;(mockRateLimiters as any).checkout = null
  })

  afterEach(() => {
    // Restore to mock limiter
    ;(mockRateLimiters as any).checkout = { limit: vi.fn() }
  })

  it('deve retornar sem lançar quando limiter é null', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    await expect(mw(makeRequest(), reply)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. Middleware behaviour — success path
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware — success (rate limit não atingido)', () => {
  const NOW = 1_700_000_000_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockIsRateLimitEnabled.mockReturnValue(true)
    ;(mockRateLimiters as any).checkout = {
      limit: vi.fn().mockResolvedValue({
        success: true,
        limit: 5,
        remaining: 4,
        reset: NOW + 60_000,
      }),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('deve setar X-RateLimit-Limit no header', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    await mw(makeRequest(), reply)

    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', 5)
  })

  it('deve setar X-RateLimit-Remaining no header', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    await mw(makeRequest(), reply)

    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', 4)
  })

  it('deve setar X-RateLimit-Reset no header', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    await mw(makeRequest(), reply)

    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Reset', NOW + 60_000)
  })

  it('deve resolver sem erro quando success=true', async () => {
    const mw = createRateLimitMiddleware('checkout')
    await expect(mw(makeRequest(), makeReply())).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. Middleware behaviour — limit exceeded (429)
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware — limite atingido (429)', () => {
  const NOW = 1_700_000_000_000
  const RESET = NOW + 45_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockIsRateLimitEnabled.mockReturnValue(true)
    ;(mockRateLimiters as any).checkout = {
      limit: vi.fn().mockResolvedValue({
        success: false,
        limit: 5,
        remaining: 0,
        reset: RESET,
      }),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('deve lançar AppError com código RATE_LIMITED quando limite excedido', async () => {
    const mw = createRateLimitMiddleware('checkout')

    await expect(mw(makeRequest(), makeReply())).rejects.toMatchObject({
      code: ErrorCodes.RATE_LIMITED,
    })
  })

  it('deve lançar AppError com statusCode 429', async () => {
    const mw = createRateLimitMiddleware('checkout')

    await expect(mw(makeRequest(), makeReply())).rejects.toMatchObject({
      statusCode: 429,
    })
  })

  it('deve lançar instância de AppError (não Error genérico)', async () => {
    const mw = createRateLimitMiddleware('checkout')

    try {
      await mw(makeRequest(), makeReply())
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
    }
  })

  it('deve setar Retry-After como segundos inteiros positivos', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    try {
      await mw(makeRequest(), reply)
    } catch {
      // expected
    }

    const retryAfterCall = reply.header.mock.calls.find(
      ([name]: [string]) => name === 'Retry-After',
    )
    expect(retryAfterCall).toBeDefined()
    const retryAfterValue = retryAfterCall![1] as number
    expect(retryAfterValue).toBeGreaterThan(0)
    expect(Number.isInteger(retryAfterValue)).toBe(true)
  })

  it('deve setar headers X-RateLimit-* mesmo quando limite excedido', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    try {
      await mw(makeRequest(), reply)
    } catch {
      // expected
    }

    const headerNames = reply.header.mock.calls.map(([name]: [string]) => name)
    expect(headerNames).toContain('X-RateLimit-Limit')
    expect(headerNames).toContain('X-RateLimit-Remaining')
    expect(headerNames).toContain('X-RateLimit-Reset')
  })
})

// ---------------------------------------------------------------------------
// 7. Identifier resolution
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware — resolução de identifier', () => {
  const NOW = 1_700_000_000_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockIsRateLimitEnabled.mockReturnValue(true)
    ;(mockRateLimiters as any).checkout = {
      limit: vi.fn().mockResolvedValue({
        success: true,
        limit: 5,
        remaining: 4,
        reset: NOW + 60_000,
      }),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('deve usar user:userId quando request.user.userId está presente', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({ user: { userId: 'usr_abc123' } })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('user:usr_abc123')
  })

  it('deve usar ip:x-forwarded-for (string simples) quando sem usuário', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      headers: { 'x-forwarded-for': '203.0.113.5' },
    })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:203.0.113.5')
  })

  it('deve usar o primeiro IP do x-forwarded-for quando for lista separada por vírgula', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 172.16.0.1' },
    })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:203.0.113.5')
  })

  it('deve usar o primeiro IP do x-forwarded-for quando for array', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      headers: { 'x-forwarded-for': ['203.0.113.7', '10.0.0.1'] },
    })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:203.0.113.7')
  })

  it('deve usar ip:request.ip quando x-forwarded-for ausente', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({ ip: '192.168.1.1' })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:192.168.1.1')
  })

  it('deve usar ip:unknown quando nenhuma fonte de IP disponível', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = { headers: {}, ip: '', user: undefined } as any

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:unknown')
  })

  it('userId preferido sobre x-forwarded-for quando ambos presentes', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      user: { userId: 'usr_priority' },
      headers: { 'x-forwarded-for': '203.0.113.5' },
    })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('user:usr_priority')
  })
})
