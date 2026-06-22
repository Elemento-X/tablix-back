/**
 * Fila BullMQ do processamento assíncrono (Card 6.2 — Fase 6).
 *
 * Define a `Queue` (produtor) do caminho LRO: o `/process/async` (Card 6.3)
 * enfileira aqui; o worker em processo separado (Card 6.4) consome. Este
 * módulo NÃO instancia Worker — produtor e consumidor vivem em processos
 * distintos (decisão D-2, isolamento de OOM do parse).
 *
 * **Payload mínimo:** só o `jobId` (o `Job.id` do Postgres). O worker carrega
 * o registro completo do DB — evita duplicar estado no Redis e mantém o DB
 * como fonte da verdade (status, inputs, ownership). O Redis guarda só o
 * ponteiro.
 *
 * **Degradação graciosa:** sem `REDIS_URL` (dev local), `getProcessQueue()`
 * retorna `null`. O Card 6.3 gateia o enqueue pela flag
 * `ASYNC_PROCESSING_ENABLED` + disponibilidade da fila.
 */

import { Queue, type JobsOptions } from 'bullmq'
import { getQueueConnection } from '../../config/redis-tcp'

/**
 * Nome da fila. Namespaced pra não colidir com outras chaves no DB do Redis
 * (mesmo sendo DB dedicado, o prefixo deixa o intent explícito no Redis CLI).
 *
 * **NÃO usar `:`** — o BullMQ v5 reserva `:` como separador interno de chaves
 * (`bull:<queue>:<id>`) e lança "Queue name cannot contain :" no construtor da
 * Queue/Worker. Usamos `-` como separador (bug latente do 6.2 revelado pelo
 * teste de integração do 6.4 — a fila nunca era construída nos unit tests).
 */
export const PROCESS_QUEUE_NAME = 'tablix-process-async'

/**
 * Payload do job. Estável e mínimo — apenas o ponteiro pro registro no DB.
 * Ampliar este shape é breaking change pro worker (Card 6.4): versionar com
 * cuidado.
 */
export interface ProcessJobPayload {
  /** `Job.id` (UUID v4) do Postgres. Worker faz `WHERE id = jobId`. */
  jobId: string
}

/**
 * Opções default de job. Resiliência sem reprocessamento infinito:
 *  - `attempts: 3` + backoff exponencial (5s, 10s, 20s) — cobre falha
 *    transitória de rede/Storage sem martelar input venenoso.
 *  - `removeOnComplete`: mantém poucos por pouco tempo (a verdade do
 *    resultado vive no DB/Storage; o registro BullMQ é efêmero).
 *  - `removeOnFail`: retém mais tempo pra post-mortem antes da DLQ lógica.
 */
export const DEFAULT_PROCESS_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 100 },
  // Cap DUPLO (age + count) também no fail (fix-pack @dba+@devops MÉDIO): o DB
  // do BullMQ é noeviction (não pode perder job em voo), então sob burst de
  // falhas (input venenoso recorrente, Storage degradado) os registros de
  // falha acumulam. Sem teto de quantidade, no Upstash free a memória estoura
  // e o noeviction faz o próprio enqueue falhar (fila travada). `count` limita
  // o blast radius mantendo janela de post-mortem.
  removeOnFail: { age: 24 * 3_600, count: 1_000 },
}

let queue: Queue<ProcessJobPayload> | null | undefined

/**
 * Retorna a `Queue` singleton, ou `null` se o Redis TCP não estiver
 * configurado (dev local sem fila). Lazy-init na primeira chamada.
 */
export function getProcessQueue(): Queue<ProcessJobPayload> | null {
  if (queue !== undefined) return queue

  const connection = getQueueConnection()
  if (!connection) {
    queue = null
    return null
  }

  queue = new Queue<ProcessJobPayload>(PROCESS_QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_PROCESS_JOB_OPTIONS,
  })
  return queue
}

/**
 * Erro lançado quando se tenta enfileirar sem fila configurada. Code estável
 * pro caller (Card 6.3) mapear pra 503 Service Unavailable.
 */
export class QueueUnavailableError extends Error {
  readonly code = 'QUEUE_UNAVAILABLE'
  constructor() {
    super('async processing queue is not configured (REDIS_URL ausente)')
    this.name = 'QueueUnavailableError'
  }
}

/**
 * Enfileira um job de processamento.
 *
 * Usa `Job.id` como `jobId` do BullMQ → idempotência: reenfileirar o mesmo
 * Job não cria duplicata (BullMQ ignora id já presente). O `Job.id` é UUID
 * (com hífens) — aceito pelo BullMQ como custom job id.
 *
 * **Idempotência inquebrável (fix-pack @tester BAIXO):** `opts` é
 * `Omit<JobsOptions, 'jobId'>` — o caller NÃO pode passar `jobId` e
 * sobrescrever a garantia de dedup. Além do tipo, o `jobId` é aplicado DEPOIS
 * do spread de `opts` em runtime (defesa dupla).
 *
 * @throws {QueueUnavailableError} se a fila não estiver configurada.
 */
export async function enqueueProcessJob(
  payload: ProcessJobPayload,
  opts?: Omit<JobsOptions, 'jobId'>,
): Promise<{ enqueuedJobId: string }> {
  const q = getProcessQueue()
  if (!q) {
    throw new QueueUnavailableError()
  }

  const job = await q.add(PROCESS_QUEUE_NAME, payload, {
    ...opts,
    jobId: payload.jobId,
  })

  return { enqueuedJobId: job.id ?? payload.jobId }
}

/**
 * Indica se a fila tem Redis configurado (sem instanciar a Queue).
 */
export function isProcessQueueConfigured(): boolean {
  return getQueueConnection() !== null
}

/**
 * Fecha a Queue e zera o singleton. Graceful shutdown + isolamento de testes.
 */
export async function closeProcessQueue(): Promise<void> {
  if (queue) {
    await queue.close()
  }
  queue = undefined
}
