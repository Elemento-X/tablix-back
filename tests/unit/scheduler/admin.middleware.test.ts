/* eslint-disable import/first */
/**
 * Admin middleware tests — Card #145 (5.2a) F4 + WV-2026-006.
 *
 * Cobre as 9 mitigations do D#3 (com fix-pack F-ALTO-01/02/03):
 *  - Mit 3: cache 30s + invalidateAdminCache
 *  - Mit 7: timingSafeEqual allowlist (constant-time)
 *  - Mit 8: step-up reauth com nonce + body binding + ADMIN_STEPUP_SECRET
 *
 * @owner: @tester
 * @card: #145 (5.2a) F4
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks ANTES dos imports
vi.mock('../../../src/config/env', () => ({
  env: {
    JWT_SECRET: 'jwt-secret-only-for-tests-min-32-chars-AAAA',
    ADMIN_STEPUP_SECRET: 'stepup-secret-only-for-tests-min-32-chars-BBBB',
    ADMIN_USER_IDS: ['550e8400-e29b-41d4-a716-446655440000'],
    NODE_ENV: 'test',
  },
}))
vi.mock('../../../src/config/redis', () => ({
  redis: {
    set: vi.fn(),
    eval: vi.fn(),
    get: vi.fn(),
  },
}))
vi.mock('../../../src/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}))
vi.mock('../../../src/modules/audit-legal/audit-legal.service', () => ({
  recordLegalEvent: vi.fn().mockResolvedValue({}),
}))

import type { FastifyReply, FastifyRequest } from 'fastify'
import { createHash, createHmac } from 'node:crypto'

import { redis } from '../../../src/config/redis'
import { prisma } from '../../../src/lib/prisma'
import {
  adminMiddleware,
  invalidateAdminCache,
  computeStepUpHmacForTesting,
  __testing,
} from '../../../src/scheduler/admin.middleware'

const validUserId = '550e8400-e29b-41d4-a716-446655440000'
const otherUserId = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa'

function makeRequest(
  overrides: Partial<{
    user: { userId: string }
    headers: Record<string, string>
    method: string
    url: string
    body: unknown
  }> = {},
): FastifyRequest {
  return {
    user: { userId: validUserId, sub: 'sess', role: 'PRO' },
    headers: {},
    method: 'POST',
    url: '/admin/jobs/run/history-purge',
    routeOptions: { url: '/admin/jobs/run/:name' },
    body: {},
    ip: '192.0.2.1',
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as FastifyRequest
}

function makeReply(): FastifyReply {
  return {} as unknown as FastifyReply
}

function makeValidStepUpHeader(args: {
  userId?: string
  method?: string
  path?: string
  body?: string
  ts?: number
  nonce?: string
}): string {
  const ts = args.ts ?? Date.now()
  const nonce = args.nonce ?? '11111111-1111-4111-8111-111111111111'
  const userId = args.userId ?? validUserId
  const method = args.method ?? 'POST'
  const path = args.path ?? '/admin/jobs/run/:name'
  const body = args.body ?? '{}'
  const hmac = computeStepUpHmacForTesting({
    userId,
    method,
    path,
    timestamp: ts,
    nonce,
    body,
  })
  return `${ts}.${nonce}.${hmac}`
}

beforeEach(() => {
  vi.clearAllMocks()
  __testing.resetCacheForTests()
  // Default: redis SET NX returns OK (nonce claim succeeds)
  vi.mocked(redis!.set).mockResolvedValue('OK')
  vi.mocked(redis!.eval).mockResolvedValue(undefined)
  vi.mocked(redis!.get).mockResolvedValue(null) // no lockout
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: validUserId,
    historyOptIn: true,
  } as never)
})

describe('adminMiddleware — auth gate (Mit 3+4+7+8)', () => {
  it('rejeita request.user null → UNAUTHORIZED', async () => {
    const request = makeRequest({ user: undefined } as never)
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('rejeita userId fora do allowlist → FORBIDDEN', async () => {
    const request = makeRequest({ user: { userId: otherUserId } } as never)
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('rejeita user removido do DB (cache miss → null) → FORBIDDEN', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const request = makeRequest({
      headers: { 'x-admin-confirm': makeValidStepUpHeader({}) },
    })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('rejeita header X-Admin-Confirm ausente → FORBIDDEN', async () => {
    const request = makeRequest({ headers: {} })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('rejeita header com formato inválido (não 3 partes)', async () => {
    const request = makeRequest({
      headers: { 'x-admin-confirm': 'bad.format' },
    })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('rejeita timestamp fora da janela ±30s', async () => {
    const stale = Date.now() - 60_000 // 60s atrás
    const request = makeRequest({
      headers: { 'x-admin-confirm': makeValidStepUpHeader({ ts: stale }) },
    })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('rejeita nonce não-UUID v4', async () => {
    const ts = Date.now()
    const badNonce = 'not-a-uuid'
    const hmac = createHmac(
      'sha256',
      'stepup-secret-only-for-tests-min-32-chars-BBBB',
    )
      .update(
        `${validUserId}:POST:/admin/jobs/run/:name:${ts}:${badNonce}:${createHash('sha256').update('{}').digest('hex')}`,
      )
      .digest('hex')
    const request = makeRequest({
      headers: { 'x-admin-confirm': `${ts}.${badNonce}.${hmac}` },
    })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('rejeita HMAC errado (constant-time compare falha)', async () => {
    const ts = Date.now()
    const nonce = '11111111-1111-4111-8111-111111111111'
    // HMAC com secret errada
    const wrongHmac = createHmac('sha256', 'wrong-secret-for-test')
      .update(`${validUserId}:POST:/admin/jobs/run/:name:${ts}:${nonce}:hash`)
      .digest('hex')
    const request = makeRequest({
      headers: { 'x-admin-confirm': `${ts}.${nonce}.${wrongHmac}` },
    })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('rejeita header válido mas nonce já consumido (Redis SET NX retorna null)', async () => {
    // Redis SET NX retorna null em segunda chamada com mesmo nonce
    vi.mocked(redis!.set).mockResolvedValue(null)
    const request = makeRequest({
      headers: { 'x-admin-confirm': makeValidStepUpHeader({}) },
    })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('aceita request com header válido (allowlist + cache + step-up OK)', async () => {
    const request = makeRequest({
      headers: { 'x-admin-confirm': makeValidStepUpHeader({}) },
    })
    await expect(adminMiddleware(request, makeReply())).resolves.toBeUndefined()
  })
})

describe('adminMiddleware — lockout (F-BAIXO-02 fix)', () => {
  it('rejeita user em lockout (Redis lockout key existe)', async () => {
    vi.mocked(redis!.get).mockResolvedValue('1') // lockout key set
    const request = makeRequest({
      headers: { 'x-admin-confirm': makeValidStepUpHeader({}) },
    })
    await expect(adminMiddleware(request, makeReply())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('adminMiddleware — cache (Mit 3 + F-MED-01)', () => {
  it('cache 30s: 2 requests dentro do TTL fazem 1 query DB', async () => {
    const request1 = makeRequest({
      headers: { 'x-admin-confirm': makeValidStepUpHeader({}) },
    })
    const request2 = makeRequest({
      headers: {
        'x-admin-confirm': makeValidStepUpHeader({
          nonce: '22222222-2222-4222-8222-222222222222',
        }),
      },
    })
    await adminMiddleware(request1, makeReply())
    await adminMiddleware(request2, makeReply())
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)
  })

  it('invalidateAdminCache(userId) força nova query', async () => {
    const request1 = makeRequest({
      headers: { 'x-admin-confirm': makeValidStepUpHeader({}) },
    })
    await adminMiddleware(request1, makeReply())
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)

    invalidateAdminCache(validUserId)

    const request2 = makeRequest({
      headers: {
        'x-admin-confirm': makeValidStepUpHeader({
          nonce: '33333333-3333-4333-8333-333333333333',
        }),
      },
    })
    await adminMiddleware(request2, makeReply())
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
  })
})

describe('isUserIdInAllowlistTimingSafe (Mit 7)', () => {
  it('retorna true se userId está no allowlist', () => {
    expect(
      __testing.isUserIdInAllowlistTimingSafe(validUserId, [validUserId]),
    ).toBe(true)
  })

  it('retorna false se userId NÃO está no allowlist', () => {
    expect(
      __testing.isUserIdInAllowlistTimingSafe(otherUserId, [validUserId]),
    ).toBe(false)
  })

  it('retorna false pra userId com length != 36', () => {
    expect(
      __testing.isUserIdInAllowlistTimingSafe('short', [validUserId]),
    ).toBe(false)
  })

  it('retorna false pra allowlist vazia', () => {
    expect(__testing.isUserIdInAllowlistTimingSafe(validUserId, [])).toBe(false)
  })

  it('NÃO usa short-circuit em early match (constant-time)', () => {
    // Validação semântica: loop sempre completa, OR acumulado
    // (ver source). Difícil testar timing diretamente sem benchmark.
    const allowlist = [validUserId, otherUserId, 'extra-id']
    expect(
      __testing.isUserIdInAllowlistTimingSafe(validUserId, allowlist),
    ).toBe(true)
  })
})

describe('computeStepUpHmacForTesting — helper de teste', () => {
  it('produz HMAC determinístico pra mesmo input', () => {
    const args = {
      userId: validUserId,
      method: 'POST',
      path: '/admin/jobs/run/:name',
      timestamp: 1234567890,
      nonce: '11111111-1111-4111-8111-111111111111',
      body: '{}',
    }
    const h1 = computeStepUpHmacForTesting(args)
    const h2 = computeStepUpHmacForTesting(args)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produz HMACs diferentes pra body diferentes (F-ALTO-03 binding)', () => {
    const base = {
      userId: validUserId,
      method: 'POST',
      path: '/admin/jobs/run/:name',
      timestamp: 1234567890,
      nonce: '11111111-1111-4111-8111-111111111111',
    }
    const h1 = computeStepUpHmacForTesting({ ...base, body: '{}' })
    const h2 = computeStepUpHmacForTesting({ ...base, body: '{"x":1}' })
    expect(h1).not.toBe(h2)
  })

  it('produz HMACs diferentes pra paths diferentes (F-ALTO-03 binding)', () => {
    const base = {
      userId: validUserId,
      method: 'POST',
      timestamp: 1234567890,
      nonce: '11111111-1111-4111-8111-111111111111',
      body: '{}',
    }
    const h1 = computeStepUpHmacForTesting({
      ...base,
      path: '/admin/jobs/run/:name',
    })
    const h2 = computeStepUpHmacForTesting({
      ...base,
      path: '/admin/jobs/list',
    })
    expect(h1).not.toBe(h2)
  })
})
