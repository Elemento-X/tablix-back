/**
 * Unit tests da conexão Redis TCP dedicada ao BullMQ (Card 6.2 — Fase 6).
 *
 * Mocka `ioredis` (classe Redis fake), `../../src/config/env` (REDIS_URL
 * mutável) e o logger. NÃO toca rede. Cobre:
 *   - QUEUE_CONNECTION_OPTIONS (hard requirements do BullMQ)
 *   - createQueueConnection: constrói com url + options, anexa error handler
 *     que só LOGA (não derruba processo) e NÃO vaza a URL/credencial
 *   - getQueueConnection: null sem REDIS_URL, singleton lazy quando presente
 *   - isQueueConnectionConfigured: booleano derivado de env
 *   - closeQueueConnection: quit + reset do cache (idempotente sem conexão)
 *   - D-1: TLS preservado (url rediss:// repassada ao ioredis)
 *
 * @owner: @tester
 * @card: 6.2 — Setup BullMQ + conexão Redis TCP (Fase 6)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeRedisInstance {
  url: string
  options: Record<string, unknown>
  handlers: Record<string, (...args: unknown[]) => void>
  on: (event: string, cb: (...args: unknown[]) => void) => FakeRedisInstance
  quit: ReturnType<typeof vi.fn>
}

const { RedisMock, redisInstances, envMock, loggerMock } = vi.hoisted(() => {
  const redisInstances: FakeRedisInstance[] = []
  class RedisMock {
    url: string
    options: Record<string, unknown>
    handlers: Record<string, (...args: unknown[]) => void> = {}
    quit = vi.fn().mockResolvedValue('OK')
    constructor(url: string, options: Record<string, unknown>) {
      this.url = url
      this.options = options
      redisInstances.push(this as unknown as FakeRedisInstance)
    }

    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers[event] = cb
      return this
    }
  }
  return {
    RedisMock,
    redisInstances,
    envMock: { REDIS_URL: undefined as string | undefined },
    loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }
})

vi.mock('ioredis', () => ({ Redis: RedisMock }))
vi.mock('../../src/config/env', () => ({ env: envMock }))
vi.mock('../../src/lib/logger', () => ({ logger: loggerMock }))

/* eslint-disable import/first */
import {
  QUEUE_CONNECTION_OPTIONS,
  closeQueueConnection,
  createQueueConnection,
  getQueueConnection,
  isQueueConnectionConfigured,
} from '../../src/config/redis-tcp'
/* eslint-enable import/first */

const TLS_URL = 'rediss://default:secret-token@fake-host.upstash.io:6379'

beforeEach(() => {
  vi.clearAllMocks()
  redisInstances.length = 0
  envMock.REDIS_URL = undefined
})

afterEach(async () => {
  // Reseta o singleton de módulo entre testes (evita vazamento de estado).
  await closeQueueConnection()
})

describe('QUEUE_CONNECTION_OPTIONS — hard requirements do BullMQ', () => {
  it('maxRetriesPerRequest é null (comandos blocking não estouram retry)', () => {
    expect(QUEUE_CONNECTION_OPTIONS.maxRetriesPerRequest).toBeNull()
  })

  it('enableReadyCheck é false (Upstash failover-safe)', () => {
    expect(QUEUE_CONNECTION_OPTIONS.enableReadyCheck).toBe(false)
  })

  it('lazyConnect é true (não abre socket no import)', () => {
    expect(QUEUE_CONNECTION_OPTIONS.lazyConnect).toBe(true)
  })
})

describe('createQueueConnection', () => {
  it('constrói Redis com a url e as QUEUE_CONNECTION_OPTIONS', () => {
    const client = createQueueConnection(
      TLS_URL,
    ) as unknown as FakeRedisInstance

    expect(redisInstances).toHaveLength(1)
    expect(client.url).toBe(TLS_URL)
    expect(client.options).toMatchObject({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    })
  })

  it('D-1: preserva o scheme rediss:// (TLS) repassado ao ioredis', () => {
    const client = createQueueConnection(
      TLS_URL,
    ) as unknown as FakeRedisInstance
    expect(client.url.startsWith('rediss://')).toBe(true)
  })

  it('anexa handler de error (evita unhandled "error" event que derruba o processo)', () => {
    const client = createQueueConnection(
      TLS_URL,
    ) as unknown as FakeRedisInstance
    expect(typeof client.handlers.error).toBe('function')
  })

  it('handler de error LOGA via logger.error e NÃO lança', () => {
    const client = createQueueConnection(
      TLS_URL,
    ) as unknown as FakeRedisInstance
    expect(() =>
      client.handlers.error(new Error('connect ETIMEDOUT')),
    ).not.toThrow()
    expect(loggerMock.error).toHaveBeenCalledTimes(1)
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'redis-tcp',
        err: 'connect ETIMEDOUT',
      }),
      expect.any(String),
    )
  })

  it('handler de error NÃO vaza a URL/credencial nos argumentos logados', () => {
    const client = createQueueConnection(
      TLS_URL,
    ) as unknown as FakeRedisInstance
    client.handlers.error(new Error('connection refused'))

    const logged = JSON.stringify(loggerMock.error.mock.calls[0])
    expect(logged).not.toContain('secret-token')
    expect(logged).not.toContain('rediss://')
  })
})

describe('getQueueConnection — singleton lazy', () => {
  it('retorna null quando REDIS_URL ausente (dev local sem fila)', () => {
    envMock.REDIS_URL = undefined
    expect(getQueueConnection()).toBeNull()
    expect(redisInstances).toHaveLength(0)
  })

  it('retorna conexão quando REDIS_URL presente', () => {
    envMock.REDIS_URL = TLS_URL
    const conn = getQueueConnection()
    expect(conn).not.toBeNull()
    expect(redisInstances).toHaveLength(1)
  })

  it('é singleton: chamadas repetidas não criam nova conexão', () => {
    envMock.REDIS_URL = TLS_URL
    const a = getQueueConnection()
    const b = getQueueConnection()
    expect(a).toBe(b)
    expect(redisInstances).toHaveLength(1)
  })

  it('cacheia o null: sem REDIS_URL não reavalia criando conexão depois', () => {
    envMock.REDIS_URL = undefined
    expect(getQueueConnection()).toBeNull()
    // Mesmo se a env "mudasse" depois, o null já está cacheado até close.
    envMock.REDIS_URL = TLS_URL
    expect(getQueueConnection()).toBeNull()
    expect(redisInstances).toHaveLength(0)
  })
})

describe('isQueueConnectionConfigured', () => {
  it('true quando REDIS_URL presente', () => {
    envMock.REDIS_URL = TLS_URL
    expect(isQueueConnectionConfigured()).toBe(true)
  })

  it('false quando REDIS_URL ausente', () => {
    envMock.REDIS_URL = undefined
    expect(isQueueConnectionConfigured()).toBe(false)
  })

  it('não instancia conexão (sem efeito colateral)', () => {
    envMock.REDIS_URL = TLS_URL
    isQueueConnectionConfigured()
    expect(redisInstances).toHaveLength(0)
  })
})

describe('closeQueueConnection', () => {
  it('chama quit() na conexão ativa e zera o cache', async () => {
    envMock.REDIS_URL = TLS_URL
    const conn = getQueueConnection() as unknown as FakeRedisInstance
    expect(conn).not.toBeNull()

    await closeQueueConnection()
    expect(conn.quit).toHaveBeenCalledTimes(1)

    // Pós-close: nova chamada recria (singleton resetado).
    const conn2 = getQueueConnection()
    expect(conn2).not.toBe(conn as unknown)
    expect(redisInstances).toHaveLength(2)
  })

  it('é no-op seguro quando não há conexão (singleton null/undefined)', async () => {
    envMock.REDIS_URL = undefined
    getQueueConnection() // cacheia null
    await expect(closeQueueConnection()).resolves.toBeUndefined()
  })

  it('é no-op seguro quando nunca foi inicializada', async () => {
    await expect(closeQueueConnection()).resolves.toBeUndefined()
  })
})
