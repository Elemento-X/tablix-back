/**
 * Conexão Redis TCP dedicada ao BullMQ (Card 6.2 — Fase 6 Fila Assíncrona).
 *
 * **Por que separado de `config/redis.ts`:**
 *  - `redis.ts` usa `@upstash/redis` (REST/HTTP) — perfeito pra rate-limit e
 *    concurrency guard (comandos curtos, stateless), mas NÃO suporta blocking
 *    commands (BLPOP/BRPOPLPUSH) que o BullMQ exige pra consumir a fila.
 *  - BullMQ precisa de TCP real (ioredis) + DB com `maxmemory-policy=noeviction`
 *    (evicção apagaria jobs em voo). O DB do rate-limit quer TTL/evicção — daí
 *    o DB DEDICADO (decisão D-1, validada no spike S-1 em 2026-06-21).
 *
 * **Config obrigatória do BullMQ:**
 *  - `maxRetriesPerRequest: null` — BullMQ gerencia o próprio retry; o default
 *    do ioredis (20) faria comandos blocking falharem com erro espúrio.
 *  - `enableReadyCheck: false` — recomendado pelo BullMQ pra evitar erro
 *    transitório em provedores gerenciados (Upstash) durante failover.
 *  - TLS: `REDIS_URL` é validada como `rediss://` no `env.ts`; o ioredis ativa
 *    TLS automaticamente a partir do scheme.
 *
 * **Degradação graciosa:** sem `REDIS_URL` (dev local sem fila), retorna `null`
 * — mesmo contrato do `redis.ts`. A `Queue` (process-queue.ts) e o futuro
 * worker (6.4) tratam `null` como "fila indisponível" sem derrubar o processo.
 *
 * **Lazy:** `lazyConnect: true` — não abre socket no import. A conexão sobe na
 * primeira operação real (enqueue), mantendo o boot rápido e permitindo que
 * suítes unit importem o módulo sem tocar a rede.
 */

import { Redis, type RedisOptions } from 'ioredis'
import { env } from './env'
import { logger } from '../lib/logger'

/**
 * Opções BullMQ-safe da conexão. Exportadas pra reuso pelo worker (Card 6.4),
 * que cria uma conexão TCP SEPARADA (comandos blocking não podem compartilhar
 * socket com comandos normais).
 */
export const QUEUE_CONNECTION_OPTIONS: RedisOptions = {
  // Hard requirement do BullMQ — sem isso, comandos blocking estouram o
  // limite de retry do ioredis e a fila fica instável.
  maxRetriesPerRequest: null,
  // Recomendado pelo BullMQ em Redis gerenciado (Upstash) — evita erro
  // transitório de readiness durante failover/manutenção do provedor.
  enableReadyCheck: false,
  // Não abre socket no import; conecta na primeira operação.
  lazyConnect: true,
}

let connection: Redis | null | undefined

/**
 * Cria uma conexão ioredis BullMQ-safe a partir da `REDIS_URL`. Anexa um
 * handler de `error` que apenas LOGA — sem isso, um erro de socket emitido
 * fora de um comando ativo derruba o processo (unhandled 'error' event no
 * EventEmitter do ioredis).
 *
 * Não use direto em runtime — prefira `getQueueConnection()` (singleton).
 * Exportada pra criar conexões adicionais (worker) e pra teste.
 */
export function createQueueConnection(url: string): Redis {
  const client = new Redis(url, QUEUE_CONNECTION_OPTIONS)

  client.on('error', (err: Error) => {
    // NÃO logar a URL (contém credencial). `err.message` do ioredis é
    // genérico (ex: "connect ETIMEDOUT") e seguro.
    logger.error(
      { module: 'redis-tcp', err: err.message },
      '[redis-tcp] erro na conexão Redis TCP do BullMQ',
    )
  })

  return client
}

/**
 * Retorna a conexão TCP singleton do BullMQ, ou `null` se `REDIS_URL` não
 * estiver configurada (dev local sem fila async). Lazy-init na primeira
 * chamada.
 */
export function getQueueConnection(): Redis | null {
  if (connection !== undefined) return connection

  if (!env.REDIS_URL) {
    connection = null
    return null
  }

  connection = createQueueConnection(env.REDIS_URL)
  return connection
}

/**
 * Indica se a fila assíncrona tem Redis TCP configurado.
 */
export function isQueueConnectionConfigured(): boolean {
  return Boolean(env.REDIS_URL)
}

/**
 * Fecha a conexão singleton e zera o cache. Usado no graceful shutdown
 * (Card 6.4) e entre testes pra evitar handles abertos.
 */
export async function closeQueueConnection(): Promise<void> {
  if (connection) {
    try {
      await connection.quit()
    } catch {
      // `quit()` pode rejeitar se a conexão já foi encerrada — ex: o
      // `Queue.close()` (closeProcessQueue) fechou a conexão compartilhada
      // antes, dependendo da versão do BullMQ. Fallback pra `disconnect()`
      // (síncrono, idempotente) garante o socket fechado sem abortar o
      // graceful shutdown no meio (fix-pack @devops BAIXO). Ordem recomendada
      // no Card 6.4: closeProcessQueue() → closeQueueConnection().
      connection.disconnect()
    }
  }
  connection = undefined
}
