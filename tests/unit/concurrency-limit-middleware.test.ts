/**
 * Unit + Fastify-lifecycle tests para src/middleware/concurrency-limit.middleware.ts
 * (Card #219 — cap de concorrência POR-ROTA, backstop de memória do /process/sync).
 *
 * Cobre os comportamentos críticos do gate, incluindo os 2 fixes do @security:
 *  - acquire incrementa; ao atingir `max`, o (max+1)-ésimo acquire lança
 *    serviceBusy (503) + seta `Retry-After` COM jitter (2..5) SEM consumir slot.
 *  - F1 (slot leak no abort): acquire registra `reply.raw.once('close')`. Quando o
 *    socket fecha sem passar pelo onResponse (client-abort mid-upload / timeout), o
 *    slot é liberado. 'close' + onResponse no mesmo request decrementam só 1×
 *    (idempotência via WeakSet — counter nunca fica negativo).
 *  - jitter do Retry-After: 2 + floor(random*4) ∈ {2,3,4,5}; extremos mocados (0→2,
 *    0.999→5) + invariante de faixa.
 *  - release decrementa só de quem adquiriu; release/close de quem NÃO adquiriu é
 *    no-op → sem underflow.
 *  - invariante 0 <= inFlight <= max sob sequência mista acquire/release/close
 *    (property-based / fast-check).
 *  - gate concreto `processSyncConcurrency` (max via env, mocado = 3).
 *  - Fastify lifecycle (fastify.inject, hermético): cap rejeita concorrência além do
 *    teto com 503+Retry-After, libera no sucesso E no caminho de ERRO.
 *
 * Determinismo: o middleware só toca Math.random no jitter — mocado/validado por
 * faixa. counter + WeakSet são puros. env e logger mocados (hermético, sem rede/
 * relógio/ordem). fast-check com seed fixo.
 *
 * @owner: @tester
 * @card: #219
 */
import { EventEmitter } from 'node:events'
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest'
import fc from 'fast-check'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  createConcurrencyLimit,
  processSyncConcurrency,
} from '../../src/middleware/concurrency-limit.middleware'
import { AppError, ErrorCodes, Errors } from '../../src/errors/app-error'

// env mocado: o middleware lê `env.PROCESS_SYNC_MAX_CONCURRENCY` no load do módulo
// (gate concreto). Fixar = 3 mantém o teste determinístico e independente do
// .env real. Logger mocado corta o resto do grafo e silencia stdout.
// (vi.mock é içado pelo Vitest acima dos imports; `testEnv` é importado DENTRO
// da factory — variável top-level não pode ser referenciada na factory hoisteada.)
vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv, PROCESS_SYNC_MAX_CONCURRENCY: 3 } }
})
vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

/** Valor de PROCESS_SYNC_MAX_CONCURRENCY fixado no mock acima. */
const CONCRETE_MAX = 3

// ---------------------------------------------------------------------------
// Helpers — fakes mínimos de FastifyRequest/Reply. O gate usa: identidade do
// request (WeakSet), reply.header (Retry-After) e reply.raw (EventEmitter, p/ o
// listener de 'close' que cobre abort/timeout — F1).
// ---------------------------------------------------------------------------

/** Cada chamada gera um request DISTINTO (identidade própria p/ o WeakSet). */
function makeRequest(ip = '127.0.0.1'): any {
  return { ip }
}

interface FakeReply {
  header: Mock
  raw: EventEmitter
}

/** reply.raw é um EventEmitter real: o teste pode `emit('close')` p/ simular abort. */
function makeReply(): FakeReply {
  return { header: vi.fn(), raw: new EventEmitter() }
}

/**
 * Tenta adquirir. Retorna true se entrou (slot consumido), false se rejeitado com
 * SERVICE_BUSY (503). Qualquer outro throw propaga.
 */
async function tryAcquire(
  gate: ReturnType<typeof createConcurrencyLimit>,
  request: any,
  reply: FakeReply = makeReply(),
): Promise<boolean> {
  try {
    await gate.acquire(request, reply as any)
    return true
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCodes.SERVICE_BUSY) {
      return false
    }
    throw err
  }
}

/** Lê o valor numérico do Retry-After setado na reply (ou undefined). */
function retryAfterOf(reply: FakeReply): number | undefined {
  const call = reply.header.mock.calls.find(([name]) => name === 'Retry-After')
  return call ? Number(call[1]) : undefined
}

// ===========================================================================
// 1. acquire — incremento e fail-fast ao atingir o teto
// ===========================================================================

describe('createConcurrencyLimit — acquire / fail-fast', () => {
  it('permite até `max` aquisições simultâneas', async () => {
    const gate = createConcurrencyLimit(3, 'test')

    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(true)
  })

  it('o (max+1)-ésimo acquire lança serviceBusy (503)', async () => {
    const gate = createConcurrencyLimit(2, 'test')
    await gate.acquire(makeRequest(), makeReply() as any)
    await gate.acquire(makeRequest(), makeReply() as any)

    await expect(
      gate.acquire(makeRequest(), makeReply() as any),
    ).rejects.toMatchObject({
      code: ErrorCodes.SERVICE_BUSY,
      statusCode: 503,
    })
  })

  it('a rejeição é instância de AppError (não Error genérico)', async () => {
    const gate = createConcurrencyLimit(1, 'test')
    await gate.acquire(makeRequest(), makeReply() as any)

    try {
      await gate.acquire(makeRequest(), makeReply() as any)
      expect.fail('deveria ter lançado serviceBusy')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
    }
  })

  it('NÃO seta Retry-After no caminho de sucesso (header só no block)', async () => {
    const gate = createConcurrencyLimit(2, 'test')
    const reply = makeReply()

    await gate.acquire(makeRequest(), reply as any)

    expect(reply.header).not.toHaveBeenCalled()
  })

  it('o request rejeitado NÃO consome slot (cap não regride por tentativa negada)', async () => {
    // max=1: A entra; B é rejeitado; sem liberar nada, um novo C também é
    // rejeitado. Guarda o invariante "rejeição é no-op no counter".
    const gate = createConcurrencyLimit(1, 'test')
    expect(await tryAcquire(gate, makeRequest())).toBe(true) // A
    expect(await tryAcquire(gate, makeRequest())).toBe(false) // B rejeitado
    expect(await tryAcquire(gate, makeRequest())).toBe(false) // C ainda rejeitado
  })

  it('NÃO registra listener de "close" para request rejeitado (sem cleanup espúrio)', async () => {
    // Mutation/leak guard: o `reply.raw.once('close')` só é registrado APÓS o
    // incremento. O request rejeitado (throw antes) não pode deixar listener —
    // senão um 'close' tardio decrementaria slot de outrem.
    const gate = createConcurrencyLimit(1, 'test')
    await gate.acquire(makeRequest(), makeReply() as any)

    const rejectedReply = makeReply()
    await expect(
      gate.acquire(makeRequest(), rejectedReply as any),
    ).rejects.toBeInstanceOf(AppError)

    expect(rejectedReply.raw.listenerCount('close')).toBe(0)
  })

  it('registra exatamente 1 listener de "close" para request que adquiriu', async () => {
    const gate = createConcurrencyLimit(1, 'test')
    const reply = makeReply()
    await gate.acquire(makeRequest(), reply as any)

    expect(reply.raw.listenerCount('close')).toBe(1)
  })
})

// ===========================================================================
// 2. Retry-After com jitter (2..5) — fix @security
// ===========================================================================

describe('createConcurrencyLimit — Retry-After jitter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Math.random=0 → Retry-After "2" (piso)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const gate = createConcurrencyLimit(1, 'test')
    await gate.acquire(makeRequest(), makeReply() as any)

    const reply = makeReply()
    await expect(
      gate.acquire(makeRequest(), reply as any),
    ).rejects.toBeInstanceOf(AppError)

    expect(reply.header).toHaveBeenCalledWith('Retry-After', '2')
  })

  it('Math.random≈0.999 → Retry-After "5" (teto)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const gate = createConcurrencyLimit(1, 'test')
    await gate.acquire(makeRequest(), makeReply() as any)

    const reply = makeReply()
    await expect(
      gate.acquire(makeRequest(), reply as any),
    ).rejects.toBeInstanceOf(AppError)

    expect(reply.header).toHaveBeenCalledWith('Retry-After', '5')
  })

  it('Math.random=0.5 → Retry-After "4" (ponto médio, floor)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const gate = createConcurrencyLimit(1, 'test')
    await gate.acquire(makeRequest(), makeReply() as any)

    const reply = makeReply()
    await expect(
      gate.acquire(makeRequest(), reply as any),
    ).rejects.toBeInstanceOf(AppError)

    // 2 + floor(0.5*4) = 2 + 2 = 4
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '4')
  })

  it('invariante: Retry-After é sempre inteiro em [2,5] (50 amostras reais)', async () => {
    // Sem mock de Math.random — asserção de FAIXA é determinística (sempre vale),
    // pega qualquer regressão que mude piso/jitter (ex: *4 → *10, ou min errado).
    const gate = createConcurrencyLimit(1, 'test')
    await gate.acquire(makeRequest(), makeReply() as any) // enche

    for (let i = 0; i < 50; i++) {
      const reply = makeReply()
      await expect(
        gate.acquire(makeRequest(), reply as any),
      ).rejects.toBeInstanceOf(AppError)

      const value = retryAfterOf(reply)
      expect(value).toBeDefined()
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(2)
      expect(value).toBeLessThanOrEqual(5)
    }
  })
})

// ===========================================================================
// 3. F1 — slot leak no abort: release via reply.raw 'close'
// ===========================================================================

describe('createConcurrencyLimit — F1 abort/close (anti slot-leak)', () => {
  it('client-abort (socket "close" sem onResponse) libera o slot', async () => {
    // O cenário do leak: upload abortado no meio NÃO passa pelo onResponse da
    // rota. Sem o listener de 'close', o slot ficaria preso → 503 eterno.
    const gate = createConcurrencyLimit(1, 'test')
    const reqA = makeRequest()
    const replyA = makeReply()

    await gate.acquire(reqA, replyA as any) // inFlight=1
    expect(await tryAcquire(gate, makeRequest())).toBe(false) // cheio

    // Socket fecha (abort/timeout) — dispara o release registrado no acquire.
    replyA.raw.emit('close')

    expect(await tryAcquire(gate, makeRequest())).toBe(true) // slot devolvido
  })

  it('"close" + onResponse no MESMO request decrementam só 1× (idempotência WeakSet)', async () => {
    // max=2: A e B dentro. A termina normal → tanto o onResponse (release) quanto
    // o 'close' do socket disparam. Devem devolver UM slot, não dois.
    const gate = createConcurrencyLimit(2, 'test')
    const reqA = makeRequest()
    const replyA = makeReply()
    const reqB = makeRequest()

    await gate.acquire(reqA, replyA as any) // 1
    await gate.acquire(reqB, makeReply() as any) // 2 (cheio)

    await gate.release(reqA) // libera A (onResponse): inFlight=1
    replyA.raw.emit('close') // mesmo request: no-op (WeakSet já removeu)

    // Só 1 slot voltou (A). B ainda dentro → 1 cabe, o seguinte não.
    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })

  it('ordem inversa ("close" antes do release) também decrementa só 1×', async () => {
    const gate = createConcurrencyLimit(2, 'test')
    const reqA = makeRequest()
    const replyA = makeReply()
    const reqB = makeRequest()

    await gate.acquire(reqA, replyA as any) // 1
    await gate.acquire(reqB, makeReply() as any) // 2

    replyA.raw.emit('close') // libera A primeiro
    await gate.release(reqA) // no-op (já removido)

    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })

  it('"close" repetido no mesmo socket não causa underflow', async () => {
    // EventEmitter.once garante 1 disparo, mas o guard do WeakSet é a barreira
    // real: mesmo forçando o handler 2×, não decrementa abaixo do real.
    const gate = createConcurrencyLimit(1, 'test')
    const reqA = makeRequest()
    const replyA = makeReply()

    await gate.acquire(reqA, replyA as any)
    replyA.raw.emit('close')
    replyA.raw.emit('close') // 2º 'close' — sem listener (once) e idempotente

    // Slot livre: exatamente 1 cabe, o próximo não (counter não foi a -1).
    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })
})

// ===========================================================================
// 4. release — só decrementa quem adquiriu (WeakSet), sem underflow
// ===========================================================================

describe('createConcurrencyLimit — release', () => {
  it('após release de quem adquiriu, um slot volta a caber', async () => {
    const gate = createConcurrencyLimit(1, 'test')
    const a = makeRequest()

    expect(await tryAcquire(gate, a)).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)

    await gate.release(a)

    expect(await tryAcquire(gate, makeRequest())).toBe(true)
  })

  it('release de request que NÃO adquiriu é no-op (sem decremento)', async () => {
    const gate = createConcurrencyLimit(1, 'test')
    const a = makeRequest()
    const neverAcquired = makeRequest()

    expect(await tryAcquire(gate, a)).toBe(true)
    await gate.release(neverAcquired) // no-op

    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })

  it('release dobrado do mesmo request é idempotente (não underflow)', async () => {
    const gate = createConcurrencyLimit(2, 'test')
    const a = makeRequest()
    const b = makeRequest()

    await gate.acquire(a, makeReply() as any)
    await gate.acquire(b, makeReply() as any)

    await gate.release(a)
    await gate.release(a) // 2ª vez: no-op

    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })

  it('release de requests fantasma não permite estourar o teto (anti-underflow)', async () => {
    const gate = createConcurrencyLimit(2, 'test')

    await gate.release(makeRequest())
    await gate.release(makeRequest())
    await gate.release(makeRequest())

    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })
})

// ===========================================================================
// 5. WeakSet — rastreia requests distintos de forma independente
// ===========================================================================

describe('createConcurrencyLimit — WeakSet (rastreio por identidade)', () => {
  it('dois requests distintos são rastreados independentemente', async () => {
    const gate = createConcurrencyLimit(2, 'test')
    const a = makeRequest()
    const b = makeRequest()

    await gate.acquire(a, makeReply() as any)
    await gate.acquire(b, makeReply() as any)

    await gate.release(a)
    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)

    await gate.release(a) // no-op (já removido)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })

  it('sequência mista (adquire 4, rejeita 5º, libera 2, readquire 2) respeita o teto', async () => {
    const gate = createConcurrencyLimit(4, 'test')
    const held = [makeRequest(), makeRequest(), makeRequest(), makeRequest()]
    for (const r of held) {
      expect(await tryAcquire(gate, r)).toBe(true)
    }
    expect(await tryAcquire(gate, makeRequest())).toBe(false)

    await gate.release(held[0])
    await gate.release(held[1])

    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(true)
    expect(await tryAcquire(gate, makeRequest())).toBe(false)
  })
})

// ===========================================================================
// 6. Property-based — invariante 0 <= inFlight <= max sob acquire/release/close
// ===========================================================================

describe('createConcurrencyLimit — invariante (property-based)', () => {
  it('mantém 0 <= inFlight <= max sob qualquer mix de acquire/release/close', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.array(
          fc.record({
            op: fc.constantFrom('acquire', 'release', 'close'),
            id: fc.integer({ min: 0, max: 9 }),
          }),
          { minLength: 0, maxLength: 80 },
        ),
        async (max, commands) => {
          const gate = createConcurrencyLimit(max, 'prop')
          const reqOf = new Map<number, any>()
          const replyOf = new Map<number, FakeReply>()
          const ensureReq = (id: number) => {
            if (!reqOf.has(id)) reqOf.set(id, makeRequest())
            return reqOf.get(id)
          }
          const held = new Set<number>()

          for (const { op, id } of commands) {
            if (op === 'acquire') {
              // Lifecycle real: cada request adquire no máx 1×. Ignora acquire de
              // quem já segura (mascararia o modelo / double-increment irreal).
              if (held.has(id)) continue
              const reply = makeReply()
              const ok = await tryAcquire(gate, ensureReq(id), reply)
              if (ok) {
                replyOf.set(id, reply) // guarda p/ poder emitir 'close' depois
                held.add(id)
                expect(held.size).toBeLessThanOrEqual(max)
              } else {
                expect(held.size).toBe(max)
              }
            } else if (op === 'release') {
              await gate.release(ensureReq(id)) // no-op se não segurava
              held.delete(id)
            } else {
              // close: emite no socket guardado (se houver); idempotente.
              replyOf.get(id)?.raw.emit('close')
              held.delete(id)
            }
          }

          // Sonda: EXATAMENTE (max - held.size) novas aquisições devem caber, e a
          // seguinte falhar. Prova inFlight == held.size (pega over-count E underflow).
          const remaining = max - held.size
          for (let i = 0; i < remaining; i++) {
            expect(await tryAcquire(gate, makeRequest())).toBe(true)
          }
          expect(await tryAcquire(gate, makeRequest())).toBe(false)
        },
      ),
      { seed: 42, numRuns: 300 },
    )
  })
})

// ===========================================================================
// 7. Gate concreto do projeto — processSyncConcurrency (max via env, mocado = 3)
// ===========================================================================

describe('processSyncConcurrency — gate concreto do /process/sync', () => {
  it('expõe acquire e release como funções', () => {
    expect(typeof processSyncConcurrency.acquire).toBe('function')
    expect(typeof processSyncConcurrency.release).toBe('function')
  })

  it(`aceita ${CONCRETE_MAX} requests simultâneos e rejeita o próximo com 503 (env mocado)`, async () => {
    // O max vem de env.PROCESS_SYNC_MAX_CONCURRENCY (mocado = 3, default real = 3).
    // Higiene: libera tudo no finally — o gate é singleton de módulo.
    const held = Array.from({ length: CONCRETE_MAX }, () => makeRequest())
    try {
      for (const r of held) {
        await processSyncConcurrency.acquire(r, makeReply() as any)
      }
      await expect(
        processSyncConcurrency.acquire(makeRequest(), makeReply() as any),
      ).rejects.toMatchObject({
        code: ErrorCodes.SERVICE_BUSY,
        statusCode: 503,
      })
    } finally {
      for (const r of held) {
        await processSyncConcurrency.release(r)
      }
    }
  })
})

// ===========================================================================
// 8. Fastify lifecycle (fastify.inject) — wiring real preHandler/onResponse +
//    listener de 'close'. Hermético: app in-memory, sem DB/rede/multipart.
// ===========================================================================

describe('concurrency gate — Fastify lifecycle (inject)', () => {
  let app: FastifyInstance
  let pendingHold: { onEnter: () => void; release: Promise<void> } | null

  function makeHold() {
    let onEnter!: () => void
    let free!: () => void
    const entered = new Promise<void>((resolve) => (onEnter = resolve))
    const release = new Promise<void>((resolve) => (free = resolve))
    return { entered, release, onEnter, free }
  }

  /** Retry-After dentro da faixa de jitter [2,5]. */
  function expectRetryAfterInRange(value: string | string[] | undefined) {
    expect(value).toBeDefined()
    const n = Number(value)
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(5)
  }

  beforeEach(async () => {
    pendingHold = null
    app = Fastify()

    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(err.toJSON())
      }
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR' } })
    })

    const gate = createConcurrencyLimit(1, 'inject-test')

    app.post(
      '/work',
      { preHandler: [gate.acquire], onResponse: [gate.release] },
      async () => {
        if (pendingHold) {
          const h = pendingHold
          h.onEnter()
          await h.release
        }
        return { ok: true }
      },
    )

    app.post(
      '/boom',
      { preHandler: [gate.acquire], onResponse: [gate.release] },
      async () => {
        throw Errors.processingFailed()
      },
    )

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejeita concorrência além do cap com 503 + Retry-After (jitter) e libera no sucesso', async () => {
    const h1 = makeHold()
    pendingHold = h1
    const p1 = app.inject({ method: 'POST', url: '/work' })
    await h1.entered

    pendingHold = null
    const r2 = await app.inject({ method: 'POST', url: '/work' })
    expect(r2.statusCode).toBe(503)
    expectRetryAfterInRange(r2.headers['retry-after'])
    expect(r2.json()).toMatchObject({
      error: { code: ErrorCodes.SERVICE_BUSY },
    })

    h1.free()
    expect((await p1).statusCode).toBe(200)

    const r3 = await app.inject({ method: 'POST', url: '/work' })
    expect(r3.statusCode).toBe(200)
  })

  it('libera o slot mesmo quando o handler LANÇA (cap não vaza no caminho de erro)', async () => {
    const rBoom = await app.inject({ method: 'POST', url: '/boom' })
    expect(rBoom.statusCode).toBe(500)

    const rOk = await app.inject({ method: 'POST', url: '/work' })
    expect(rOk.statusCode).toBe(200)
  })

  it('o onResponse do request REJEITADO (503) não faz underflow do contador', async () => {
    const h1 = makeHold()
    pendingHold = h1
    const p1 = app.inject({ method: 'POST', url: '/work' })
    await h1.entered

    pendingHold = null
    const r2 = await app.inject({ method: 'POST', url: '/work' })
    expect(r2.statusCode).toBe(503)

    h1.free()
    expect((await p1).statusCode).toBe(200)

    const h2 = makeHold()
    pendingHold = h2
    const p3 = app.inject({ method: 'POST', url: '/work' })
    await h2.entered

    pendingHold = null
    const r4 = await app.inject({ method: 'POST', url: '/work' })
    expect(r4.statusCode).toBe(503)

    h2.free()
    expect((await p3).statusCode).toBe(200)
  })
})
