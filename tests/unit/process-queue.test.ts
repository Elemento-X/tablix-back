/**
 * Unit tests da fila BullMQ de processamento async (Card 6.2 — Fase 6).
 *
 * Mocka `bullmq` (classe Queue fake) e `../../src/config/redis-tcp`
 * (getQueueConnection). NÃO toca Redis. Cobre:
 *   - PROCESS_QUEUE_NAME / DEFAULT_PROCESS_JOB_OPTIONS (contrato estável)
 *   - getProcessQueue: null sem connection, singleton lazy quando presente
 *   - enqueueProcessJob: idempotência via jobId = payload.jobId, fallback
 *     do enqueuedJobId, merge de opts, throw QueueUnavailableError sem fila
 *   - QueueUnavailableError: code/name/message estáveis (Card 6.3 → 503)
 *   - isProcessQueueConfigured / closeProcessQueue
 *
 * @owner: @tester
 * @card: 6.2 — Setup BullMQ + conexão Redis TCP (Fase 6)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeQueueInstance {
  name: string
  opts: Record<string, unknown>
  add: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const {
  QueueMock,
  queueInstances,
  addMock,
  getJobMock,
  getQueueConnectionMock,
} = vi.hoisted(() => {
  const queueInstances: FakeQueueInstance[] = []
  const addMock = vi.fn()
  const getJobMock = vi.fn()
  class QueueMock {
    name: string
    opts: Record<string, unknown>
    add = addMock
    getJob = getJobMock
    close = vi.fn().mockResolvedValue(undefined)
    constructor(name: string, opts: Record<string, unknown>) {
      this.name = name
      this.opts = opts
      queueInstances.push(this as unknown as FakeQueueInstance)
    }
  }
  return {
    QueueMock,
    queueInstances,
    addMock,
    getJobMock,
    getQueueConnectionMock: vi.fn(),
  }
})

vi.mock('bullmq', () => ({ Queue: QueueMock }))
vi.mock('../../src/config/redis-tcp', () => ({
  getQueueConnection: getQueueConnectionMock,
}))

/* eslint-disable import/first */
import {
  DEFAULT_PROCESS_JOB_OPTIONS,
  PROCESS_QUEUE_NAME,
  QueueUnavailableError,
  closeProcessQueue,
  enqueueProcessJob,
  getProcessQueue,
  getProcessJobState,
  isProcessQueueConfigured,
} from '../../src/lib/queue/process-queue'
/* eslint-enable import/first */

const FAKE_CONNECTION = { fake: 'ioredis-conn' }
const JOB_ID = '8c7e1234-5678-4abc-89de-f01234567890'

beforeEach(() => {
  vi.clearAllMocks()
  queueInstances.length = 0
  getQueueConnectionMock.mockReturnValue(null)
})

afterEach(async () => {
  // Reseta o singleton de módulo entre testes.
  await closeProcessQueue()
})

describe('PROCESS_QUEUE_NAME', () => {
  it('é namespaced com hífen (BullMQ rejeita ":" no nome da fila)', () => {
    expect(PROCESS_QUEUE_NAME).toBe('tablix-process-async')
  })
})

describe('DEFAULT_PROCESS_JOB_OPTIONS — resiliência sem reprocessamento infinito', () => {
  it('attempts = 3', () => {
    expect(DEFAULT_PROCESS_JOB_OPTIONS.attempts).toBe(3)
  })

  it('backoff exponencial com delay base 5000ms', () => {
    expect(DEFAULT_PROCESS_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: 5_000,
    })
  })

  it('removeOnComplete limita retenção (age 1h, count 100)', () => {
    expect(DEFAULT_PROCESS_JOB_OPTIONS.removeOnComplete).toEqual({
      age: 3_600,
      count: 100,
    })
  })

  it('removeOnFail retém mais tempo pra post-mortem (24h) com cap de count', () => {
    // Cap DUPLO (age + count) — fix-pack @dba+@devops MÉDIO: sem count, um
    // burst de falhas acumula registros sem teto e estoura a memória do Redis
    // noeviction (fila trava). count bound o blast radius mantendo janela de
    // post-mortem.
    expect(DEFAULT_PROCESS_JOB_OPTIONS.removeOnFail).toEqual({
      age: 24 * 3_600,
      count: 1_000,
    })
  })
})

describe('getProcessQueue — singleton lazy', () => {
  it('retorna null quando não há connection (REDIS_URL ausente)', () => {
    getQueueConnectionMock.mockReturnValue(null)
    expect(getProcessQueue()).toBeNull()
    expect(queueInstances).toHaveLength(0)
  })

  it('instancia Queue quando há connection', () => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
    const q = getProcessQueue()
    expect(q).not.toBeNull()
    expect(queueInstances).toHaveLength(1)
    expect(queueInstances[0].name).toBe(PROCESS_QUEUE_NAME)
  })

  it('passa connection + defaultJobOptions na construção', () => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
    getProcessQueue()
    expect(queueInstances[0].opts).toMatchObject({
      connection: FAKE_CONNECTION,
      defaultJobOptions: DEFAULT_PROCESS_JOB_OPTIONS,
    })
  })

  it('é singleton: não recria a Queue em chamadas repetidas', () => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
    const a = getProcessQueue()
    const b = getProcessQueue()
    expect(a).toBe(b)
    expect(queueInstances).toHaveLength(1)
  })
})

describe('QueueUnavailableError', () => {
  it('tem code estável QUEUE_UNAVAILABLE (Card 6.3 mapeia 503)', () => {
    const err = new QueueUnavailableError()
    expect(err.code).toBe('QUEUE_UNAVAILABLE')
  })

  it('name e message corretos, é instanceof Error', () => {
    const err = new QueueUnavailableError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('QueueUnavailableError')
    expect(err.message).toMatch(/not configured/i)
  })
})

describe('enqueueProcessJob — fila indisponível', () => {
  it('lança QueueUnavailableError quando não há fila', async () => {
    getQueueConnectionMock.mockReturnValue(null)
    await expect(enqueueProcessJob({ jobId: JOB_ID })).rejects.toBeInstanceOf(
      QueueUnavailableError,
    )
    expect(addMock).not.toHaveBeenCalled()
  })
})

describe('enqueueProcessJob — enfileiramento idempotente', () => {
  beforeEach(() => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
  })

  it('usa jobId = payload.jobId como custom job id (idempotência BullMQ)', async () => {
    addMock.mockResolvedValue({ id: JOB_ID })
    await enqueueProcessJob({ jobId: JOB_ID })

    expect(addMock).toHaveBeenCalledWith(
      PROCESS_QUEUE_NAME,
      { jobId: JOB_ID },
      expect.objectContaining({ jobId: JOB_ID }),
    )
  })

  it('retorna enqueuedJobId do job criado', async () => {
    addMock.mockResolvedValue({ id: JOB_ID })
    const result = await enqueueProcessJob({ jobId: JOB_ID })
    expect(result).toEqual({ enqueuedJobId: JOB_ID })
  })

  it('fallback: usa payload.jobId quando job.id vem undefined', async () => {
    addMock.mockResolvedValue({ id: undefined })
    const result = await enqueueProcessJob({ jobId: JOB_ID })
    expect(result.enqueuedJobId).toBe(JOB_ID)
  })

  it('mass-enqueue do mesmo jobId: cada chamada passa SEMPRE o mesmo jobId', async () => {
    addMock.mockResolvedValue({ id: JOB_ID })
    await enqueueProcessJob({ jobId: JOB_ID })
    await enqueueProcessJob({ jobId: JOB_ID })
    await enqueueProcessJob({ jobId: JOB_ID })

    // BullMQ deduplica server-side por jobId; o contrato unit é: o jobId
    // passado é estável e igual ao Job.id em todas as chamadas.
    expect(addMock).toHaveBeenCalledTimes(3)
    for (const call of addMock.mock.calls) {
      expect(call[2]).toMatchObject({ jobId: JOB_ID })
    }
  })

  it('faz merge de opts extras (ex: delay) preservando o payload', async () => {
    addMock.mockResolvedValue({ id: JOB_ID })
    await enqueueProcessJob({ jobId: JOB_ID }, { delay: 1_000 })

    expect(addMock).toHaveBeenCalledWith(
      PROCESS_QUEUE_NAME,
      { jobId: JOB_ID },
      expect.objectContaining({ jobId: JOB_ID, delay: 1_000 }),
    )
  })
})

describe('getProcessJobState — inspeção pro sweeper #197 (Card 6.7)', () => {
  it('null quando a fila não está configurada (sem Redis)', async () => {
    getQueueConnectionMock.mockReturnValue(null)
    await expect(getProcessJobState(JOB_ID)).resolves.toBeNull()
  })

  it('{present:false} quando o job NÃO está na fila (órfão/drenado)', async () => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
    getJobMock.mockResolvedValue(undefined)
    await expect(getProcessJobState(JOB_ID)).resolves.toEqual({
      present: false,
    })
  })

  it('{present:true,state} quando o job está na fila', async () => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
    getJobMock.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('active'),
    })
    await expect(getProcessJobState(JOB_ID)).resolves.toEqual({
      present: true,
      state: 'active',
    })
  })
})

describe('isProcessQueueConfigured', () => {
  it('true quando getQueueConnection retorna conexão', () => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
    expect(isProcessQueueConfigured()).toBe(true)
  })

  it('false quando getQueueConnection retorna null', () => {
    getQueueConnectionMock.mockReturnValue(null)
    expect(isProcessQueueConfigured()).toBe(false)
  })
})

describe('closeProcessQueue', () => {
  it('fecha a Queue ativa e zera o singleton', async () => {
    getQueueConnectionMock.mockReturnValue(FAKE_CONNECTION)
    getProcessQueue()
    const instance = queueInstances[0]

    await closeProcessQueue()
    expect(instance.close).toHaveBeenCalledTimes(1)

    // Pós-close recria.
    getProcessQueue()
    expect(queueInstances).toHaveLength(2)
  })

  it('é no-op seguro quando a fila é null (sem connection)', async () => {
    getQueueConnectionMock.mockReturnValue(null)
    getProcessQueue() // cacheia null
    await expect(closeProcessQueue()).resolves.toBeUndefined()
  })

  it('é no-op seguro quando nunca foi inicializada', async () => {
    await expect(closeProcessQueue()).resolves.toBeUndefined()
  })
})
