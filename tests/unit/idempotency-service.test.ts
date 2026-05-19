/**
 * Unit tests — src/lib/idempotency/idempotency.service (Card #74 3.4).
 *
 * Valida o lock atômico via Redis SETNX, detecção de conflict por bodyHash,
 * in_progress para concurrent locks, hit para replay legítimo, e fail-open
 * quando Redis não está configurado ou falha.
 *
 * Strategy: vi.mock do @upstash/redis expondo um cliente in-memory com
 * semântica SET NX EX + GET + DEL + expiração manual. Preserva contrato
 * da lib sem depender de infra real.
 *
 * @owner: @tester + @security
 * @card: 3.4 (#74)
 */
/* eslint-disable import/first */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// In-memory Redis mock — simula semântica SET NX EX, GET, DEL.
// vi.hoisted() obrigatório porque vi.mock é hoisted pra cima dos imports —
// sem isso, ReferenceError: "Cannot access 'mockRedis' before initialization".
// ---------------------------------------------------------------------------

const { mockStore, mockRedis } = vi.hoisted(() => {
  interface MockEntry {
    value: string
    expiresAt: number
  }
  const store = new Map<string, MockEntry>()
  const isExpired = (entry: MockEntry) => Date.now() >= entry.expiresAt

  const redis = {
    set: vi.fn(
      async (
        key: string,
        value: string,
        opts?: { nx?: boolean; ex?: number; px?: number },
      ): Promise<'OK' | null> => {
        const entry = store.get(key)
        const expired = entry && isExpired(entry)
        if (opts?.nx && entry && !expired) return null
        // Suporta tanto EX (segundos) quanto PX (ms) — completeIdempotentOperation
        // usa PX pra preservar TTL real lido via PTTL (Card #74 @dba ALTO).
        const ms = opts?.px ?? (opts?.ex ?? 86400) * 1000
        store.set(key, { value, expiresAt: Date.now() + ms })
        return 'OK'
      },
    ),
    get: vi.fn(async (key: string): Promise<string | null> => {
      const entry = store.get(key)
      if (!entry) return null
      if (isExpired(entry)) {
        store.delete(key)
        return null
      }
      return entry.value
    }),
    del: vi.fn(async (key: string): Promise<number> => {
      return store.delete(key) ? 1 : 0
    }),
    // pttl: ms restantes até expiração; -2 não existe, -1 sem TTL.
    // Usado por completeIdempotentOperation pra herdar TTL do lock inicial.
    pttl: vi.fn(async (key: string): Promise<number> => {
      const entry = store.get(key)
      if (!entry) return -2
      const remaining = entry.expiresAt - Date.now()
      return remaining > 0 ? remaining : -2
    }),
  }

  return { mockStore: store, mockRedis: redis }
})

// Mock env primeiro (config/env é consumido por redis.ts)
vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

// Mock redis.ts pra exportar nosso mock
vi.mock('../../src/config/redis', () => ({
  redis: mockRedis,
  isRedisConfigured: () => true,
  getRedis: () => mockRedis,
}))

import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  releaseIdempotencyKey,
  hashBody,
  IDEMPOTENCY_CONSTANTS,
} from '../../src/lib/idempotency/idempotency.service'

beforeEach(() => {
  mockStore.clear()
  mockRedis.set.mockClear()
  mockRedis.get.mockClear()
  mockRedis.del.mockClear()
  mockRedis.pttl.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// hashBody
// ---------------------------------------------------------------------------
describe('hashBody', () => {
  it('produz hash determinístico para o mesmo payload', () => {
    const h1 = hashBody({ email: 'x@y.com', plan: 'monthly', currency: 'BRL' })
    const h2 = hashBody({ email: 'x@y.com', plan: 'monthly', currency: 'BRL' })
    expect(h1).toBe(h2)
  })

  it('é invariante à ordem das chaves (canonical JSON)', () => {
    const h1 = hashBody({ a: 1, b: 2, c: 3 })
    const h2 = hashBody({ c: 3, a: 1, b: 2 })
    const h3 = hashBody({ b: 2, c: 3, a: 1 })
    expect(h1).toBe(h2)
    expect(h2).toBe(h3)
  })

  it('produz hashes distintos para payloads distintos', () => {
    const h1 = hashBody({ email: 'a@b.com', plan: 'monthly' })
    const h2 = hashBody({ email: 'a@b.com', plan: 'yearly' })
    expect(h1).not.toBe(h2)
  })

  it('retorna hex SHA-256 (64 chars)', () => {
    const h = hashBody({ any: 'value' })
    expect(h).toMatch(/^[a-f0-9]{64}$/)
  })

  it('trata null e undefined corretamente', () => {
    expect(hashBody(null)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashBody(undefined)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashBody(null)).not.toBe(hashBody(undefined))
  })

  it('hasheia arrays preservando ordem (ordem em array É semântica)', () => {
    const h1 = hashBody([1, 2, 3])
    const h2 = hashBody([3, 2, 1])
    expect(h1).not.toBe(h2)
  })
})

// ---------------------------------------------------------------------------
// beginIdempotentOperation
// ---------------------------------------------------------------------------
describe('beginIdempotentOperation', () => {
  const baseParams = {
    key: 'uuid-v4-client-key',
    scope: 'checkout' as const,
    identifier: 'user@tablix.test',
    bodyHash: hashBody({ plan: 'monthly' }),
  }

  it('miss: primeira invocação adquire lock e retorna status=miss', async () => {
    const result = await beginIdempotentOperation(baseParams)
    expect(result.status).toBe('miss')
    expect(mockRedis.set).toHaveBeenCalledTimes(1)

    // Validar que o SET foi NX + EX
    const setCall = mockRedis.set.mock.calls[0]
    expect(setCall[2]).toMatchObject({ nx: true })
    expect(setCall[2]?.ex).toBe(86400) // 24h default
  })

  it('in_progress: segunda invocação com mesmo bodyHash durante processing retorna in_progress', async () => {
    await beginIdempotentOperation(baseParams) // miss → lock adquirido
    const result = await beginIdempotentOperation(baseParams)

    expect(result.status).toBe('in_progress')
    expect(result.cached).toBeUndefined()
  })

  it('hit: após complete com data, retorna status=hit + cached', async () => {
    await beginIdempotentOperation(baseParams)
    await completeIdempotentOperation({
      ...baseParams,
      data: { clientSecret: 'cs_test_abc', sessionId: 'cs_sid_abc' },
    })

    const result = await beginIdempotentOperation<{
      clientSecret: string
      sessionId: string
    }>(baseParams)

    expect(result.status).toBe('hit')
    expect(result.cached).toEqual({
      clientSecret: 'cs_test_abc',
      sessionId: 'cs_sid_abc',
    })
  })

  it('conflict: mesma key com bodyHash diferente retorna status=conflict', async () => {
    await beginIdempotentOperation(baseParams) // lock com bodyHash A

    const result = await beginIdempotentOperation({
      ...baseParams,
      bodyHash: hashBody({ plan: 'yearly' }), // bodyHash B (diferente)
    })

    expect(result.status).toBe('conflict')
  })

  it('scope diferente NÃO colide (keys independentes)', async () => {
    await beginIdempotentOperation({ ...baseParams, scope: 'checkout' })
    const result = await beginIdempotentOperation({
      ...baseParams,
      scope: 'other-mutation' as unknown as string,
    })
    expect(result.status).toBe('miss')
  })

  it('identifier diferente NÃO colide (isola clientes distintos)', async () => {
    await beginIdempotentOperation({
      ...baseParams,
      identifier: 'client-a@tablix.test',
    })
    const result = await beginIdempotentOperation({
      ...baseParams,
      identifier: 'client-b@tablix.test',
    })
    expect(result.status).toBe('miss')
  })

  it('key diferente (mesmo identifier+scope) NÃO colide', async () => {
    await beginIdempotentOperation({ ...baseParams, key: 'key-1' })
    const result = await beginIdempotentOperation({
      ...baseParams,
      key: 'key-2',
    })
    expect(result.status).toBe('miss')
  })

  it('fail-open: erro no SET retorna miss (não bloqueia operação)', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('Redis unavailable'))
    const result = await beginIdempotentOperation(baseParams)
    expect(result.status).toBe('miss')
  })

  it('fail-open: erro no GET após SET conflitante retorna miss', async () => {
    // Primeiro SET popula
    await beginIdempotentOperation(baseParams)
    // Segundo SET retorna null (já existe), então tenta GET → falha
    mockRedis.get.mockRejectedValueOnce(new Error('Redis GET timeout'))
    const result = await beginIdempotentOperation(baseParams)
    expect(result.status).toBe('miss')
  })

  it('payload corrompido no Redis trata como miss (não lança)', async () => {
    await beginIdempotentOperation(baseParams)
    // Corrompe o valor armazenado pra simular payload inválido
    mockRedis.get.mockResolvedValueOnce('not-valid-json-xyz')
    const result = await beginIdempotentOperation(baseParams)
    expect(result.status).toBe('miss')
  })

  it('TTL customizado é respeitado no SET', async () => {
    await beginIdempotentOperation({ ...baseParams, ttlSeconds: 60 })
    const setCall = mockRedis.set.mock.calls[0]
    expect(setCall[2]?.ex).toBe(60)
  })
})

// ---------------------------------------------------------------------------
// completeIdempotentOperation
// ---------------------------------------------------------------------------
describe('completeIdempotentOperation', () => {
  const baseParams = {
    key: 'complete-key',
    scope: 'checkout' as const,
    identifier: 'buyer@tablix.test',
    bodyHash: hashBody({ plan: 'monthly' }),
  }

  it('grava o resultado com status=done + data', async () => {
    await beginIdempotentOperation(baseParams)
    const data = { clientSecret: 'secret_1', sessionId: 'sid_1' }
    await completeIdempotentOperation({ ...baseParams, data })

    // Próximo begin vê hit
    const result = await beginIdempotentOperation<typeof data>(baseParams)
    expect(result.status).toBe('hit')
    expect(result.cached).toEqual(data)
  })

  it('sobrescreve lock "processing" sem SET NX, usando PX (preserva TTL)', async () => {
    await beginIdempotentOperation(baseParams) // cria lock processing
    await completeIdempotentOperation({
      ...baseParams,
      data: { x: 1 },
    })

    // Verifica que foi chamado SET sem NX (sobrescrita permitida) e usa PX
    // (não EX) — Card #74 @dba ALTO: preservar TTL real via PTTL+PX evita
    // estender janela de dedup além do contrato 24h.
    const completeSetCall = mockRedis.set.mock.calls[1]
    expect(completeSetCall[2]).not.toHaveProperty('nx')
    expect(completeSetCall[2]).not.toHaveProperty('ex')
    expect(completeSetCall[2]?.px).toBeGreaterThan(0)
    // PTTL foi consultado pra ler TTL restante do lock inicial
    expect(mockRedis.pttl).toHaveBeenCalledTimes(1)
  })

  it('preserva TTL: complete não estende janela do lock inicial (@dba ALTO)', async () => {
    // Lock inicial cria com TTL 86400s. Após gravação, o TTL restante deve
    // ser ≤ 86400s (não 86400 redondo). Garante que SET PX herdou PTTL real.
    await beginIdempotentOperation(baseParams)
    await new Promise((r) => setTimeout(r, 20)) // simula tempo entre lock e complete
    await completeIdempotentOperation({ ...baseParams, data: { x: 1 } })

    const completeSetCall = mockRedis.set.mock.calls[1]
    const pxMs = completeSetCall[2]?.px as number
    // PX deve refletir TTL restante (24h - ~20ms), nunca 24h cheios
    expect(pxMs).toBeLessThan(86400 * 1000)
    expect(pxMs).toBeGreaterThan(86400 * 1000 - 5000) // tolerância 5s
  })

  it('PTTL falhando: cai pro fallback de 24h em PX', async () => {
    await beginIdempotentOperation(baseParams)
    mockRedis.pttl.mockRejectedValueOnce(new Error('PTTL down'))

    await completeIdempotentOperation({ ...baseParams, data: { x: 1 } })

    const completeSetCall = mockRedis.set.mock.calls[1]
    expect(completeSetCall[2]?.px).toBe(86400 * 1000)
  })

  it('falha silenciosa quando Redis SET lança erro (não propaga)', async () => {
    await beginIdempotentOperation(baseParams)
    mockRedis.set.mockRejectedValueOnce(new Error('Redis down'))

    // Não deve lançar
    await expect(
      completeIdempotentOperation({ ...baseParams, data: { x: 1 } }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// releaseIdempotencyKey
// ---------------------------------------------------------------------------
describe('releaseIdempotencyKey', () => {
  const baseParams = {
    key: 'release-key',
    scope: 'checkout' as const,
    identifier: 'buyer@tablix.test',
  }

  it('remove a key permitindo retry imediato (novo miss)', async () => {
    const withHash = { ...baseParams, bodyHash: hashBody({ x: 1 }) }
    await beginIdempotentOperation(withHash) // lock

    await releaseIdempotencyKey(baseParams)

    // Retry deve resultar em novo miss (não in_progress)
    const result = await beginIdempotentOperation(withHash)
    expect(result.status).toBe('miss')
  })

  it('falha silenciosa em erro de Redis (não propaga)', async () => {
    mockRedis.del.mockRejectedValueOnce(new Error('Redis del error'))
    await expect(releaseIdempotencyKey(baseParams)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('IDEMPOTENCY_CONSTANTS', () => {
  it('TTL default de 24h (alinhado com Stripe e api-contract.md)', () => {
    expect(IDEMPOTENCY_CONSTANTS.DEFAULT_TTL_SECONDS).toBe(24 * 60 * 60)
  })

  it('MAX_KEY_LENGTH=255 (alinhado com convenções REST)', () => {
    expect(IDEMPOTENCY_CONSTANTS.MAX_KEY_LENGTH).toBe(255)
  })

  it('KEY_PREFIX é namespaced no Redis', () => {
    expect(IDEMPOTENCY_CONSTANTS.KEY_PREFIX).toBe('tablix:idempotency')
  })
})
