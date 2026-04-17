/* eslint-disable @typescript-eslint/no-explicit-any */
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
 *   - identifier falls back to request.ip (resolvido por Fastify + trustProxy)
 *   - middleware lança IP_UNRESOLVABLE (400) quando request.ip ausente
 *     (fail-closed — Card 1.12 hardening pós-@security)
 *   - middleware NÃO lê x-forwarded-for cru (Card 1.12 — anti-spoof)
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  createRateLimitMiddleware,
  rateLimitMiddleware,
} from '../../src/middleware/rate-limit.middleware'
import { AppError, ErrorCodes } from '../../src/errors/app-error'

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
    // Default IP válido — fail-closed do middleware rejeita request sem IP.
    // Testes que validam o fail-closed passam `ip: ''` ou `ip: undefined`
    // explicitamente.
    ip: overrides.ip ?? '127.0.0.1',
    url: '/test',
    method: 'GET',
    // Pino-compatible stub — middleware chama request.log.warn() antes
    // do throw de IP_UNRESOLVABLE (observability hook).
    log: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
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
    'health', // Card 2.3 — health check rate limiter (/health/ready, /health/)
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

  it('deve setar X-RateLimit-Reset como Unix timestamp em SEGUNDOS (api-contract.md)', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const reply = makeReply()

    await mw(makeRequest(), reply)

    // @upstash/ratelimit retorna reset em ms; middleware converte para seconds
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Reset', Math.ceil((NOW + 60_000) / 1000))
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

  it('deve usar ip:request.ip quando sem usuario (Fastify resolve XFF via trustProxy)', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({ ip: '192.168.1.1' })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:192.168.1.1')
  })

  it('deve lançar IP_UNRESOLVABLE (400) quando request.ip ausente (fail-closed)', async () => {
    // Pós-@security review: fail-closed em vez de bucket compartilhado 'unknown'.
    // Bucket compartilhado permitiria todos os requests sem IP afogarem uns aos outros.
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({ ip: '' })

    await expect(mw(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.IP_UNRESOLVABLE,
      statusCode: 400,
    })
    expect((mockRateLimiters as any).checkout.limit).not.toHaveBeenCalled()
    // Observability: log.warn emitido antes do throw (BAIXO run #2).
    expect(request.log.warn).toHaveBeenCalledTimes(1)
  })

  it('userId preferido sobre request.ip quando ambos presentes', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      user: { userId: 'usr_priority' },
      ip: '192.168.1.1',
    })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('user:usr_priority')
  })

  // =========================================================================
  // Card 1.12 — regression guard anti-spoof
  // =========================================================================
  // O middleware NAO pode ler x-forwarded-for cru. Resolucao de XFF e
  // responsabilidade do Fastify via opcao `trustProxy` em app.ts, que
  // so confia em hops permitidos. Ler XFF direto permite spoof trivial:
  // qualquer cliente manda `X-Forwarded-For: 1.2.3.4` e contorna rate limit.
  // =========================================================================
  it('Card 1.12: NAO deve ler x-forwarded-for cru — com ip ausente, fail-closed', async () => {
    const mw = createRateLimitMiddleware('checkout')
    // XFF presente mas request.ip ausente — fail-closed (IP_UNRESOLVABLE),
    // NAO usa o XFF cru como fallback. Se o middleware estivesse lendo XFF,
    // chamaria limit('ip:1.2.3.4') silenciosamente.
    const request = makeRequest({
      headers: { 'x-forwarded-for': '1.2.3.4' },
      ip: '',
    })

    await expect(mw(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.IP_UNRESOLVABLE,
    })
    expect((mockRateLimiters as any).checkout.limit).not.toHaveBeenCalledWith('ip:1.2.3.4')
    expect((mockRateLimiters as any).checkout.limit).not.toHaveBeenCalled()
  })

  it('Card 1.12: ignora x-real-ip cru (qualquer proxy header bruto é spoofável)', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      headers: { 'x-real-ip': '1.2.3.4' },
      ip: '',
    })

    await expect(mw(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.IP_UNRESOLVABLE,
    })
    expect((mockRateLimiters as any).checkout.limit).not.toHaveBeenCalledWith('ip:1.2.3.4')
  })

  it('Card 1.12: ignora cf-connecting-ip cru (Cloudflare header spoofável sem trustProxy)', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      headers: { 'cf-connecting-ip': '1.2.3.4' },
      ip: '',
    })

    await expect(mw(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.IP_UNRESOLVABLE,
    })
    expect((mockRateLimiters as any).checkout.limit).not.toHaveBeenCalledWith('ip:1.2.3.4')
  })

  it('Card 1.12: ignora true-client-ip, forwarded, via — só confia em request.ip', async () => {
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      headers: {
        'true-client-ip': '1.1.1.1',
        forwarded: 'for=2.2.2.2',
        via: '1.1 proxy.example.com',
      },
      ip: '203.0.113.50',
    })

    await mw(request, makeReply())

    // Qualquer que seja o header bruto, a resposta é sempre request.ip.
    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:203.0.113.50')
  })

  it('user autenticado NÃO é afetado por ip ausente (fail-closed é só pro branch de IP)', async () => {
    // Mutation guard: se alguém refatorar e mover o check `if (!ip) throw`
    // pra antes do branch de user, usuário autenticado vindo de rede esquisita
    // (sem request.ip resolvido) seria negado indevidamente — DoS em conta real.
    // A ordem no getRateLimitIdentifier é SAGRADA: user primeiro, ip depois.
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest({
      user: { userId: 'usr_no_ip' },
      ip: '',
    })

    await expect(mw(request, makeReply())).resolves.toBeUndefined()
    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('user:usr_no_ip')
  })

  it('Card 1.12: ip=undefined também dispara fail-closed (não cai em bucket compartilhado)', async () => {
    // Mutation guard: qualquer fallback silencioso (|| 'foo', || '', etc)
    // deve quebrar — a única resposta aceitável é throw IP_UNRESOLVABLE.
    const mw = createRateLimitMiddleware('checkout')
    const request = makeRequest()
    // Força undefined (passar via overrides.ip cai no ?? default '127.0.0.1')
    request.ip = undefined

    await expect(mw(request, makeReply())).rejects.toMatchObject({
      code: ErrorCodes.IP_UNRESOLVABLE,
      statusCode: 400,
    })
    expect((mockRateLimiters as any).checkout.limit).not.toHaveBeenCalled()
  })

  it('Card 1.12: quando request.ip presente, ignora XFF mesmo com valor diferente', async () => {
    const mw = createRateLimitMiddleware('checkout')
    // Fastify+trustProxy ja resolveu request.ip corretamente.
    // Um XFF spoofado no header bruto nao deve interferir.
    const request = makeRequest({
      headers: { 'x-forwarded-for': '1.2.3.4' }, // spoof tentado
      ip: '203.0.113.99', // valor confiavel vindo do Fastify
    })

    await mw(request, makeReply())

    expect((mockRateLimiters as any).checkout.limit).toHaveBeenCalledWith('ip:203.0.113.99')
    expect((mockRateLimiters as any).checkout.limit).not.toHaveBeenCalledWith('ip:1.2.3.4')
  })
})
