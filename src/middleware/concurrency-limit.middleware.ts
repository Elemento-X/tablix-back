import { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../config/env'
import { Errors } from '../errors/app-error'
import { logger } from '../lib/logger'

/**
 * Cap de concorrência POR-ROTA (Card #219) — backstop de MEMÓRIA, não de CPU.
 *
 * O `/process/sync` bufferiza até `PRO_LIMITS.maxTotalSize` (30MB) por request e,
 * durante parse+merge, mantém SIMULTANEAMENTE: os buffers brutos, todos os arquivos
 * parseados (`parsedSpreadsheets[]`), o modelo transiente do SheetJS, a cópia do
 * merge e o buffer de output. O pico REAL por request pesado fica em ~120-180MB
 * (não só "30MB de buffer" — @performance #219), e o parse é SÍNCRONO no event loop
 * (sem worker_thread no /sync; só o /async usa thread). Em 512MB de VM, um punhado
 * de requests concorrentes estoura → OOM kill, e admitir mais que ~3 não dá
 * throughput (single-thread, fractional core) — só constrói fila de event loop.
 *
 * Este gate limita quantos requests pesados ficam EM VOO ao mesmo tempo; o excedente
 * recebe 503 + `Retry-After` (fail-fast) em vez de empilhar memória até o kernel
 * matar o processo. Contagem é POR-PROCESSO (cada VM protege os seus 512MB) — não
 * distribuída. Com 2 web machines o teto agregado é 2×max, e cada máquina não
 * estoura sozinha. Correto para um backstop de memória (a memória é local à VM).
 *
 * Ciclo de vida do slot (à prova de leak — @security #219 F1):
 *   - `acquire` (ÚLTIMO preHandler, depois de auth/role) → só request PRO legítimo
 *     consome slot; rejeitado antes (rate limit/auth) nem chega aqui.
 *   - O release é registrado em `reply.raw.once('close')` DENTRO do acquire: o evento
 *     `'close'` do socket dispara em QUALQUER desfecho — finish normal, client-abort
 *     mid-upload E requestTimeout (F2). Sem isso, um abort vazaria o slot pra sempre
 *     (cap → 503 eterno até restart). O `onResponse` da rota chama o mesmo release
 *     (defesa em profundidade); ambos são idempotentes via `WeakSet`.
 */

/** Piso do Retry-After (segundos) — padrão do projeto: Retry-After em segundos. */
const RETRY_AFTER_MIN_SECONDS = 2
/** Faixa de jitter somada ao piso (→ 2..5s). Evita retry storm sincronizado. */
const RETRY_AFTER_JITTER_SECONDS = 4

interface ConcurrencyGate {
  acquire: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  release: (request: FastifyRequest) => Promise<void>
}

/**
 * Cria um gate de concorrência isolado (counter + WeakSet próprios). `max` é o
 * número de requests simultâneos permitidos; `label` identifica o gate nos logs.
 */
export function createConcurrencyLimit(
  max: number,
  label: string,
): ConcurrencyGate {
  let inFlight = 0
  const acquired = new WeakSet<FastifyRequest>()

  // Decremento idempotente e à prova de underflow: só baixa se ESTE request havia
  // adquirido (delete() devolve true uma única vez). Rejeição 503 nunca adquiriu →
  // nunca decrementa; 'close' + onResponse no mesmo request decrementam só 1×.
  const releaseSlot = (request: FastifyRequest): void => {
    if (acquired.delete(request)) {
      inFlight--
    }
  }

  return {
    acquire: async (request, reply) => {
      if (inFlight >= max) {
        // Fail-fast: 503 + Retry-After com jitter (anti retry storm). NÃO
        // incrementa (não há slot) → nada a liberar depois.
        const retryAfter =
          RETRY_AFTER_MIN_SECONDS +
          Math.floor(Math.random() * RETRY_AFTER_JITTER_SECONDS)
        reply.header('Retry-After', String(retryAfter))
        logger.warn(
          {
            metric: 'concurrency.rejected',
            gate: label,
            inFlight,
            max,
            ip: request.ip,
          },
          `[concurrency] cap de ${label} atingido (${inFlight}/${max}) — 503`,
        )
        throw Errors.serviceBusy()
      }
      inFlight++
      acquired.add(request)
      // Release GARANTIDO em qualquer desfecho (F1): 'close' do socket cobre
      // finish, client-abort e timeout. Idempotente com o onResponse via WeakSet.
      reply.raw.once('close', () => releaseSlot(request))
    },
    release: async (request) => {
      releaseSlot(request)
    },
  }
}

/**
 * Gate concreto do `/process/sync` (Card #219). `max` vem de
 * `PROCESS_SYNC_MAX_CONCURRENCY` (default 3, tunável via fly secrets sem rebuild —
 * o valor final sai da medição de RSS p95 em staging sob carga no Card 7.5).
 */
export const processSyncConcurrency = createConcurrencyLimit(
  env.PROCESS_SYNC_MAX_CONCURRENCY,
  'process/sync',
)
