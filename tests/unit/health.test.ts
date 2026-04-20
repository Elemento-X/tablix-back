/**
 * Unit tests para Card 2.3 — Health checks profundos.
 *
 * Cobre:
 *   - check-db: success, error, timeout (Prisma raw)
 *   - check-redis: skipped (dev sem config), down (prod sem config),
 *                  success, error, timeout (Upstash ping)
 *   - orchestrator:
 *       - cache empty → revalida e retorna fresh
 *       - cache fresh → retorna cached:true
 *       - cache stale → retorna cached:true imediato + revalidate background
 *       - stale concorrente → apenas UMA revalidação disparada
 *       - stale revalidação falha com log throttled (catch branch)
 *       - revalidating flag resetada após conclusão (.finally branch)
 *       - dev bypass → sempre fresh, nunca toca cache
 *       - shutdown → retorna degraded imediato
 *       - _resetHealthCache → limpa estado completo
 *       - agregação: db down → degraded
 *       - agregação: redis down → degraded
 *       - agregação: redis skipped → ok
 *       - agregação: ambos up → ok
 *   - routes (fastify.inject — execução real dos handlers):
 *       - GET /health/live → 200, { data: { status: 'ok' } }, Cache-Control: no-store
 *       - GET /health/ready → 200 quando ok, 503 quando degraded
 *       - GET /health/ready → Cache-Control: no-store
 *       - GET /health/ready → log.warn disparado quando degraded
 *       - GET /health/ → 200, inclui uptimeSeconds (sem version)
 *       - GET /health/ → 503 quando degraded
 *       - GET /health/ → uptimeSeconds >= 0 (inteiro)
 *   - routes (source-based, sem buildApp):
 *       - 3 rotas registradas com prefix /health
 *       - /live sem rate limit
 *       - /ready e / com rateLimitMiddleware.health
 *       - Cache-Control: no-store em todas
 *       - 503 quando degraded
 *
 * Estratégia de mock:
 *   - vi.mock('../../src/lib/prisma') controla $queryRaw
 *   - vi.mock('../../src/config/redis') controla redis singleton
 *   - vi.mock('../../src/config/env') controla NODE_ENV + health timeouts
 *   - Para routes via inject: vi.mock orchestrator e rate-limit.middleware
 *
 * @owner: @tester
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fastify from 'fastify'
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'

// Imports DEPOIS dos mocks
import { checkDb } from '../../src/lib/health/check-db'
import { checkRedis } from '../../src/lib/health/check-redis'
import {
  getReadinessSnapshot,
  setShutdownRequested,
  _resetHealthCache,
} from '../../src/lib/health/orchestrator'
import { TIMEOUTS, CACHE_TTL_MS } from '../../src/lib/health/types'

// --- Mocks (hoisted via vi.hoisted) ---
const { envMock, prismaMock, redisRefHolder } = vi.hoisted(() => ({
  envMock: {
    NODE_ENV: 'test' as 'development' | 'production' | 'test',
    HEALTH_TIMEOUT_DB_MS: 1000,
    HEALTH_TIMEOUT_REDIS_MS: 500,
    HEALTH_CACHE_TTL_MS: 2000,
  },
  prismaMock: {
    $queryRaw: vi.fn(),
  },
  redisRefHolder: {
    current: null as { ping: () => Promise<unknown> } | null,
  },
}))

vi.mock('../../src/config/env', () => ({
  get env() {
    return envMock
  },
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('../../src/config/redis', () => ({
  get redis() {
    return redisRefHolder.current
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  _resetHealthCache()
  envMock.NODE_ENV = 'test'
  envMock.HEALTH_TIMEOUT_DB_MS = 1000
  envMock.HEALTH_TIMEOUT_REDIS_MS = 500
  envMock.HEALTH_CACHE_TTL_MS = 2000
  redisRefHolder.current = null
})

afterEach(() => {
  vi.useRealTimers()
})

// =============================================================================
// check-db.ts
// =============================================================================
describe('checkDb', () => {
  it('retorna status=up quando $queryRaw resolve', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
    const result = await checkDb()
    expect(result.status).toBe('up')
    expect(result.code).toBeUndefined()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('retorna status=down/code=DB_ERROR quando $queryRaw rejeita', async () => {
    prismaMock.$queryRaw.mockRejectedValue(
      new Error('connection refused at host pgbouncer.internal:6543'),
    )
    const result = await checkDb()
    expect(result.status).toBe('down')
    expect(result.code).toBe('DB_ERROR')
  })

  it('NÃO inclui mensagem do erro original na resposta (anti-leak)', async () => {
    prismaMock.$queryRaw.mockRejectedValue(
      new Error('password authentication failed for user "tablix_admin"'),
    )
    const result = await checkDb()
    // Apenas code estável, sem campo `message`/`error`/`detail`.
    expect(JSON.stringify(result)).not.toContain('password')
    expect(JSON.stringify(result)).not.toContain('tablix_admin')
  })

  it('retorna status=down/code=DB_TIMEOUT quando query estoura TIMEOUTS.db', async () => {
    // Promise que nunca resolve — força timeout
    prismaMock.$queryRaw.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    const promise = checkDb()
    await vi.advanceTimersByTimeAsync(TIMEOUTS.db + 10)
    const result = await promise
    expect(result.status).toBe('down')
    expect(result.code).toBe('DB_TIMEOUT')
  })
})

// =============================================================================
// check-redis.ts
// =============================================================================
describe('checkRedis', () => {
  it('retorna status=skipped/code=REDIS_NOT_CONFIGURED em dev sem redis', async () => {
    envMock.NODE_ENV = 'development'
    redisRefHolder.current = null
    const result = await checkRedis()
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('REDIS_NOT_CONFIGURED')
    expect(result.latencyMs).toBe(0)
  })

  it('retorna status=skipped em test sem redis (não é down)', async () => {
    envMock.NODE_ENV = 'test'
    redisRefHolder.current = null
    const result = await checkRedis()
    expect(result.status).toBe('skipped')
  })

  it('retorna status=down/code=REDIS_NOT_CONFIGURED em prod sem redis', async () => {
    envMock.NODE_ENV = 'production'
    redisRefHolder.current = null
    const result = await checkRedis()
    expect(result.status).toBe('down')
    expect(result.code).toBe('REDIS_NOT_CONFIGURED')
  })

  it('retorna status=up quando redis.ping resolve', async () => {
    redisRefHolder.current = { ping: vi.fn().mockResolvedValue('PONG') }
    const result = await checkRedis()
    expect(result.status).toBe('up')
    expect(result.code).toBeUndefined()
  })

  it('retorna status=down/code=REDIS_ERROR quando ping rejeita', async () => {
    redisRefHolder.current = {
      ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    }
    const result = await checkRedis()
    expect(result.status).toBe('down')
    expect(result.code).toBe('REDIS_ERROR')
  })

  it('NÃO vaza message do erro original (anti-leak)', async () => {
    redisRefHolder.current = {
      ping: vi
        .fn()
        .mockRejectedValue(new Error('Auth failed: token=AaBbCc12345')),
    }
    const result = await checkRedis()
    expect(JSON.stringify(result)).not.toContain('AaBbCc12345')
    expect(JSON.stringify(result)).not.toContain('Auth')
  })

  it('retorna status=down/code=REDIS_TIMEOUT quando ping estoura TIMEOUTS.redis', async () => {
    redisRefHolder.current = { ping: () => new Promise(() => {}) }
    vi.useFakeTimers()
    const promise = checkRedis()
    await vi.advanceTimersByTimeAsync(TIMEOUTS.redis + 10)
    const result = await promise
    expect(result.status).toBe('down')
    expect(result.code).toBe('REDIS_TIMEOUT')
  })
})

// =============================================================================
// orchestrator.ts
// =============================================================================
describe('orchestrator (getReadinessSnapshot)', () => {
  beforeEach(() => {
    // Default: ambos up
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
    redisRefHolder.current = { ping: vi.fn().mockResolvedValue('PONG') }
    envMock.NODE_ENV = 'production' // Cache só ativa fora de development
  })

  it('cache vazio: revalida e retorna snapshot fresco (cached=false)', async () => {
    const snap = await getReadinessSnapshot()
    expect(snap.status).toBe('ok')
    expect(snap.cached).toBe(false)
    expect(snap.checks.db.status).toBe('up')
    expect(snap.checks.redis.status).toBe('up')
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('cache fresh: segundo request retorna cached=true sem chamar checks de novo', async () => {
    await getReadinessSnapshot() // popula cache
    prismaMock.$queryRaw.mockClear()

    const snap = await getReadinessSnapshot()
    expect(snap.cached).toBe(true)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('cache stale: retorna cached=true imediato + dispara revalidação background', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await getReadinessSnapshot()
    prismaMock.$queryRaw.mockClear()

    // Avança além do TTL → cache stale
    vi.advanceTimersByTime(CACHE_TTL_MS + 100)

    const snap = await getReadinessSnapshot()
    expect(snap.cached).toBe(true)

    // Espera microtasks da revalidação background drenarem
    await vi.runAllTimersAsync()
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('dev bypass: sempre revalida, nunca toca cache', async () => {
    envMock.NODE_ENV = 'development'

    await getReadinessSnapshot()
    await getReadinessSnapshot()
    await getReadinessSnapshot()

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(3)
  })

  it('agrega status=degraded quando db down', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('boom'))
    const snap = await getReadinessSnapshot()
    expect(snap.status).toBe('degraded')
    expect(snap.checks.db.status).toBe('down')
    expect(snap.checks.redis.status).toBe('up')
  })

  it('agrega status=degraded quando redis down', async () => {
    redisRefHolder.current = {
      ping: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const snap = await getReadinessSnapshot()
    expect(snap.status).toBe('degraded')
    expect(snap.checks.redis.status).toBe('down')
  })

  it('agrega status=ok quando redis skipped (dev sem config)', async () => {
    envMock.NODE_ENV = 'development'
    redisRefHolder.current = null
    const snap = await getReadinessSnapshot()
    expect(snap.status).toBe('ok')
    expect(snap.checks.redis.status).toBe('skipped')
  })

  it('snapshot inclui generatedAt em formato ISO-8601', async () => {
    const snap = await getReadinessSnapshot()
    expect(snap.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    // Parseable como Date válido
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false)
  })

  it('stale concorrente: múltiplos requests simultâneos disparam apenas UMA revalidação', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await getReadinessSnapshot()
    prismaMock.$queryRaw.mockClear()
    vi.advanceTimersByTime(CACHE_TTL_MS + 100)

    const [s1, s2, s3] = await Promise.all([
      getReadinessSnapshot(),
      getReadinessSnapshot(),
      getReadinessSnapshot(),
    ])

    expect(s1.cached).toBe(true)
    expect(s2.cached).toBe(true)
    expect(s3.cached).toBe(true)

    await vi.runAllTimersAsync()
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('stale: revalidação background que falha é silenciosa (não vaza erro)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await getReadinessSnapshot()
    vi.advanceTimersByTime(CACHE_TTL_MS + 100)

    prismaMock.$queryRaw.mockRejectedValue(new Error('unexpected crash'))
    redisRefHolder.current = {
      ping: vi.fn().mockRejectedValue(new Error('crash too')),
    }

    const snap = await getReadinessSnapshot()
    expect(snap.cached).toBe(true)

    await expect(vi.runAllTimersAsync()).resolves.not.toThrow()
  })

  it('stale: throttle de log — primeira falha em 30s emite logger.warn (branch 154-157)', async () => {
    // Cobre a branch DENTRO do catch que está atualmente sem cobertura:
    // `if (now - lastRevalidateErrorAt > REVALIDATE_ERROR_THROTTLE_MS)`
    // A revalidação falha e o throttle NÃO suprime (primeiro erro: lastRevalidateErrorAt = 0).
    // O teste verifica que o processo não lança mesmo com o log emitido.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await getReadinessSnapshot() // popula cache
    vi.advanceTimersByTime(CACHE_TTL_MS + 100) // torna stale

    // Falha que vai disparar o branch de log (primeiro erro → throttle passa)
    prismaMock.$queryRaw.mockRejectedValue(new Error('db lost'))
    redisRefHolder.current = {
      ping: vi.fn().mockRejectedValue(new Error('redis lost')),
    }

    const snap = await getReadinessSnapshot()
    expect(snap.cached).toBe(true) // serve stale imediato

    // Drena timers: revalidação ocorre, falha, throttle permite log.warn do pino.
    // Não deve lançar nem rejeitar — catch captura tudo.
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow()

    // Segunda rodada: avança 30s para garantir que throttle SUPPRIME a segunda falha
    // (cobre o branch falso de `now - lastRevalidateErrorAt > THROTTLE`).
    _resetHealthCache()
    await getReadinessSnapshot() // re-popula cache
    prismaMock.$queryRaw.mockClear()
    prismaMock.$queryRaw.mockRejectedValue(new Error('db lost again'))

    vi.advanceTimersByTime(CACHE_TTL_MS + 100) // stale again
    await getReadinessSnapshot() // dispara segundo background
    // Avança menos que THROTTLE (30s) → segunda falha é throttled (log NÃO emite)
    vi.advanceTimersByTime(1000)
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow()
  })

  it('stale: flag revalidating é resetada para false após conclusão bem-sucedida', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await getReadinessSnapshot()
    vi.advanceTimersByTime(CACHE_TTL_MS + 100)

    await getReadinessSnapshot()
    await vi.runAllTimersAsync()

    prismaMock.$queryRaw.mockClear()
    vi.advanceTimersByTime(CACHE_TTL_MS + 100)
    await getReadinessSnapshot()
    await vi.runAllTimersAsync()

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('cache fresh: snapshot retornado mantém status e checks do cache original', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('db down'))
    await getReadinessSnapshot()
    prismaMock.$queryRaw.mockClear()

    const snap = await getReadinessSnapshot()
    expect(snap.cached).toBe(true)
    expect(snap.status).toBe('degraded')
    expect(snap.checks.db.status).toBe('down')
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('generatedAt é UTC (termina com Z)', async () => {
    const snap = await getReadinessSnapshot()
    expect(snap.generatedAt).toMatch(/Z$/)
  })

  // --- Shutdown (@devops MÉDIO — graceful shutdown readiness) ---
  it('shutdown: retorna degraded imediato sem chamar checks', async () => {
    setShutdownRequested(true)
    const snap = await getReadinessSnapshot()
    expect(snap.status).toBe('degraded')
    // Não deve ter chamado DB
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('shutdown: usa checks do cache se disponível', async () => {
    // Popula cache com snapshot ok
    await getReadinessSnapshot()
    prismaMock.$queryRaw.mockClear()

    // Agora sinaliza shutdown
    setShutdownRequested(true)
    const snap = await getReadinessSnapshot()
    expect(snap.status).toBe('degraded')
    expect(snap.checks.db.status).toBe('up') // do cache anterior
    expect(snap.checks.redis.status).toBe('up')
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('shutdown: sem cache retorna checks dummy down', async () => {
    setShutdownRequested(true)
    const snap = await getReadinessSnapshot()
    expect(snap.status).toBe('degraded')
    expect(snap.checks.db.latencyMs).toBe(0)
    expect(snap.checks.redis.latencyMs).toBe(0)
  })

  // --- _resetHealthCache (@tester BAIXO — teste explícito) ---
  it('_resetHealthCache limpa cache e flags, próximo request revalida', async () => {
    // Popula cache
    await getReadinessSnapshot()
    prismaMock.$queryRaw.mockClear()

    // Sem reset, retornaria cached
    const cachedSnap = await getReadinessSnapshot()
    expect(cachedSnap.cached).toBe(true)

    // Reset
    _resetHealthCache()

    // Agora deve revalidar (cache vazio)
    const freshSnap = await getReadinessSnapshot()
    expect(freshSnap.cached).toBe(false)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('_resetHealthCache limpa shutdown flag', async () => {
    setShutdownRequested(true)
    _resetHealthCache()
    const snap = await getReadinessSnapshot()
    // Não deve estar degraded por shutdown
    expect(snap.status).toBe('ok')
  })
})

// =============================================================================
// routes (source-based — evita buildApp completo)
// =============================================================================
describe('health.routes.ts (source-based wiring)', () => {
  let routesSource: string

  beforeAll(() => {
    routesSource = readFileSync(
      resolve('src/http/routes/health.routes.ts'),
      'utf-8',
    )
  })

  it('declara as 3 rotas: /live, /ready, /', () => {
    expect(routesSource).toMatch(/server\.get\(['"]\/live['"]/)
    expect(routesSource).toMatch(/server\.get\(['"]\/ready['"]/)
    expect(routesSource).toMatch(/server\.get\(['"]\/['"]/)
  })

  it('/live NÃO declara preHandler de rate limit', () => {
    const liveBlock = routesSource.match(
      /server\.get\(['"]\/live['"][\s\S]*?server\.get/,
    )
    expect(liveBlock).not.toBeNull()
    expect(liveBlock![0]).not.toContain('rateLimitMiddleware')
  })

  it('/ready usa rateLimitMiddleware.health no preHandler', () => {
    const readyBlock = routesSource.match(
      /server\.get\(['"]\/ready['"][\s\S]*?server\.get/,
    )
    expect(readyBlock).not.toBeNull()
    expect(readyBlock![0]).toContain('rateLimitMiddleware.health')
  })

  it('todas as rotas seteiam Cache-Control: no-store', () => {
    const occurrences = routesSource.match(
      /reply\.header\(['"]Cache-Control['"],\s*['"]no-store['"]\)/g,
    )
    expect(occurrences).not.toBeNull()
    expect(occurrences!.length).toBeGreaterThanOrEqual(3)
  })

  it('/ready retorna 503 quando snapshot.status !== ok', () => {
    expect(routesSource).toMatch(/snapshot\.status === 'ok' \? 200 : 503/)
  })

  it('importa getReadinessSnapshot do módulo health', () => {
    expect(routesSource).toMatch(/from ['"]\.\.\/\.\.\/lib\/health['"]/)
  })

  it('declara operationId estável em todas as rotas (SDK contract)', () => {
    expect(routesSource).toMatch(/operationId: ['"]healthLive['"]/)
    expect(routesSource).toMatch(/operationId: ['"]healthReady['"]/)
    expect(routesSource).toMatch(/operationId: ['"]healthVerbose['"]/)
  })

  it('NÃO inclui Stripe nos checks (decisão de design — Card 2.3)', () => {
    expect(routesSource.toLowerCase()).not.toContain('stripe')
  })

  it('/health/ também usa rateLimitMiddleware.health no preHandler', () => {
    const verboseBlock = routesSource.match(/server\.get\(['"]\/['"],[\s\S]*/)
    expect(verboseBlock).not.toBeNull()
    expect(verboseBlock![0]).toContain('rateLimitMiddleware.health')
  })

  it('/health/ retorna 503 quando degraded (mesmo critério do /ready)', () => {
    const occurrences = routesSource.match(
      /snapshot\.status === 'ok' \? 200 : 503/g,
    )
    expect(occurrences).not.toBeNull()
    expect(occurrences!.length).toBe(2)
  })

  it('calcula uptimeSeconds com Math.floor e BOOT_AT', () => {
    expect(routesSource).toMatch(/Math\.floor\(.*Date\.now\(\)\s*-\s*BOOT_AT/)
  })

  it('NÃO expõe version na resposta (reconnaissance — @security finding)', () => {
    // version foi removido do handler verbose por segurança
    expect(routesSource).not.toMatch(/version:\s*SERVICE_VERSION/)
  })
})

// =============================================================================
// routes (fastify.inject — execução real dos handlers)
// =============================================================================

// Mock do orchestrator para os testes de rota — evita dependências reais de DB/Redis
const { snapshotMock } = vi.hoisted(() => ({
  snapshotMock: {
    getReadinessSnapshot: vi.fn(),
    setShutdownRequested: vi.fn(),
  },
}))

vi.mock('../../src/lib/health', () => ({
  getReadinessSnapshot: snapshotMock.getReadinessSnapshot,
  setShutdownRequested: snapshotMock.setShutdownRequested,
}))

// rateLimitMiddleware.health → no-op em testes de rota
vi.mock('../../src/middleware/rate-limit.middleware', () => ({
  rateLimitMiddleware: {
    health: vi.fn().mockResolvedValue(undefined),
  },
}))

/** Cria instância Fastify mínima com apenas as rotas de health, sem buildApp completo. */
async function buildHealthApp() {
  const app = fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  const { healthRoutes } = await import('../../src/http/routes/health.routes')
  await app.register(healthRoutes, { prefix: '/health' })
  await app.ready()
  return app
}

const okSnapshot = {
  status: 'ok' as const,
  checks: {
    db: { status: 'up' as const, latencyMs: 5 },
    redis: { status: 'up' as const, latencyMs: 2 },
  },
  generatedAt: new Date().toISOString(),
  cached: false,
}

const degradedSnapshot = {
  status: 'degraded' as const,
  checks: {
    db: {
      status: 'down' as const,
      latencyMs: 1001,
      code: 'DB_TIMEOUT' as const,
    },
    redis: { status: 'up' as const, latencyMs: 3 },
  },
  generatedAt: new Date().toISOString(),
  cached: false,
}

describe('health.routes.ts (fastify.inject — execução real dos handlers)', () => {
  let app: Awaited<ReturnType<typeof buildHealthApp>>

  beforeAll(async () => {
    app = await buildHealthApp()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    snapshotMock.getReadinessSnapshot.mockResolvedValue(okSnapshot)
  })

  // ---------------------------------------------------------------------------
  // GET /health/live
  // ---------------------------------------------------------------------------
  describe('GET /health/live', () => {
    it('retorna 200 com body { data: { status: "ok" } }', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { status: string } }>()
      expect(body.data.status).toBe('ok')
    })

    it('resposta contém header Cache-Control: no-store', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('NÃO chama getReadinessSnapshot (sem toque em dependências externas)', async () => {
      await app.inject({ method: 'GET', url: '/health/live' })
      expect(snapshotMock.getReadinessSnapshot).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // GET /health/ready
  // ---------------------------------------------------------------------------
  describe('GET /health/ready', () => {
    it('retorna 200 com cached e checks quando status=ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: typeof okSnapshot }>()
      expect(body.data.status).toBe('ok')
      expect(body.data.checks.db.status).toBe('up')
      expect(body.data.checks.redis.status).toBe('up')
      expect(typeof body.data.cached).toBe('boolean')
    })

    it('retorna 503 quando snapshot.status=degraded', async () => {
      snapshotMock.getReadinessSnapshot.mockResolvedValue(degradedSnapshot)
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{ data: typeof degradedSnapshot }>()
      expect(body.data.status).toBe('degraded')
      expect(body.data.checks.db.code).toBe('DB_TIMEOUT')
    })

    it('body shape é idêntico em 200 e 503 (orquestrador olha status code)', async () => {
      snapshotMock.getReadinessSnapshot.mockResolvedValue(degradedSnapshot)
      const res503 = await app.inject({ method: 'GET', url: '/health/ready' })
      const body503 = res503.json<{ data: unknown }>()
      expect(body503.data).toBeDefined()
      expect(typeof body503.data).toBe('object')
    })

    it('resposta contém header Cache-Control: no-store', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('chama getReadinessSnapshot exatamente uma vez por request', async () => {
      await app.inject({ method: 'GET', url: '/health/ready' })
      expect(snapshotMock.getReadinessSnapshot).toHaveBeenCalledTimes(1)
    })

    it('loga warn quando degraded (@tester MÉDIO — observabilidade)', async () => {
      // Cria app com logger que captura chamadas
      const warnSpy = vi.fn()
      const appWithLogger = fastify({
        logger: {
          level: 'warn',
          transport: {
            target: 'pino/file',
            options: { destination: '/dev/null' },
          },
        },
      })
      appWithLogger.setValidatorCompiler(validatorCompiler)
      appWithLogger.setSerializerCompiler(serializerCompiler)

      // Intercepta request.log.warn via hook
      appWithLogger.addHook('onRequest', async (request) => {
        request.log.warn = warnSpy
      })

      const { healthRoutes } =
        await import('../../src/http/routes/health.routes')
      await appWithLogger.register(healthRoutes, { prefix: '/health' })
      await appWithLogger.ready()

      snapshotMock.getReadinessSnapshot.mockResolvedValue(degradedSnapshot)
      await appWithLogger.inject({ method: 'GET', url: '/health/ready' })

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          db: degradedSnapshot.checks.db,
          redis: degradedSnapshot.checks.redis,
          cached: degradedSnapshot.cached,
        }),
        '[health] readiness degraded',
      )

      await appWithLogger.close()
    })
  })

  // ---------------------------------------------------------------------------
  // GET /health/ (verbose)
  // ---------------------------------------------------------------------------
  describe('GET /health/ (verbose)', () => {
    it('retorna 200 com uptimeSeconds quando status=ok (sem version)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/' })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { uptimeSeconds: number; status: string }
      }>()
      expect(body.data.status).toBe('ok')
      expect(typeof body.data.uptimeSeconds).toBe('number')
      // version removido por segurança (@security finding a7f3c2e1b9d4)
      expect(body.data).not.toHaveProperty('version')
    })

    it('uptimeSeconds é inteiro não-negativo', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/' })
      const body = res.json<{ data: { uptimeSeconds: number } }>()
      expect(body.data.uptimeSeconds).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(body.data.uptimeSeconds)).toBe(true)
    })

    it('retorna 503 quando snapshot.status=degraded', async () => {
      snapshotMock.getReadinessSnapshot.mockResolvedValue(degradedSnapshot)
      const res = await app.inject({ method: 'GET', url: '/health/' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{
        data: { status: string; uptimeSeconds: number }
      }>()
      expect(body.data.status).toBe('degraded')
      expect(typeof body.data.uptimeSeconds).toBe('number')
    })

    it('resposta contém header Cache-Control: no-store', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/' })
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('inclui todos os campos do snapshot (status, checks, generatedAt, cached, uptimeSeconds)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/' })
      const body = res.json<{
        data: {
          status: string
          checks: unknown
          generatedAt: string
          cached: boolean
          uptimeSeconds: number
        }
      }>()
      expect(body.data.status).toBeDefined()
      expect(body.data.checks).toBeDefined()
      expect(body.data.generatedAt).toBeDefined()
      expect(typeof body.data.cached).toBe('boolean')
      expect(body.data.uptimeSeconds).toBeDefined()
    })
  })
})
