/**
 * Card 2.3 — Orquestrador de health checks com cache stale-while-revalidate.
 *
 * Por que stale-while-revalidate em vez de cache simples:
 *
 *   Cache simples (TTL fixo) faz com que o probe que chega logo após
 *   o TTL pague a latência completa de DB + Redis. Em série de probes,
 *   isto vira flapping de latência (rápido, rápido, lento, rápido, ...).
 *   Orquestrador interpreta como degradação, dispara restart desnecessário.
 *
 *   Stale-while-revalidate (padrão SWR / RFC 5861):
 *     - Fresh   → retorna do cache, sem trabalho.
 *     - Stale   → retorna do cache imediatamente, dispara revalidação
 *                 em background para o PRÓXIMO probe.
 *     - Empty   → primeiro probe paga latência cheia (boot do container).
 *
 *   Janela de stale aceitável: `CACHE_TTL_MS` (2s). Após esse período,
 *   o snapshot ainda é servido enquanto a revalidação roda — no pior caso
 *   o orquestrador vê info defasada de até 1 ciclo (10s padrão Fly.io).
 *
 * **Concorrência:**
 *   `revalidating` é uma flag in-process simples. Mesmo container, mesmo
 *   event loop — não há race condition real (Node é single-threaded para
 *   userspace JS). Múltiplos requests simultâneos durante stale só
 *   disparam UMA revalidação; os demais leem o stale atual.
 *
 * **Bypass em desenvolvimento:**
 *   `NODE_ENV === 'development'` ignora cache e sempre reexecuta os checks.
 *   Crítico para debug local — quero ver mudança de estado imediato ao
 *   parar/iniciar Postgres ou Redis na minha máquina.
 *
 * **Graceful shutdown:**
 *   Quando `setShutdownRequested(true)` é chamado (SIGTERM handler em
 *   server.ts), `getReadinessSnapshot()` retorna snapshot degraded
 *   imediatamente — o proxy para de rotear tráfego novo para esta
 *   instância antes do `app.close()` drenar conexões existentes.
 *
 * @owner: @devops + @reviewer
 */
import pino from 'pino'
import { checkDb } from './check-db'
import { checkRedis } from './check-redis'
import { env } from '../../config/env'
import { CACHE_TTL_MS, type HealthSnapshot } from './types'

/**
 * Logger standalone para eventos de módulo (fora do contexto de request).
 * Silent em test para não poluir saída do vitest.
 */
const logger = pino({
  name: 'health',
  level: env.NODE_ENV === 'test' ? 'silent' : 'warn',
})

interface CacheEntry {
  snapshot: HealthSnapshot
  expiresAt: number
}

let cache: CacheEntry | null = null
let revalidating = false
let shutdownRequested = false

/** Throttle: logar erro de revalidação no máximo 1× a cada 30s. */
let lastRevalidateErrorAt = 0
const REVALIDATE_ERROR_THROTTLE_MS = 30_000

/**
 * Sinaliza que o processo está em shutdown. Chamado pelo SIGTERM handler
 * em server.ts. Após isto, `getReadinessSnapshot()` retorna degraded
 * para que o proxy/orquestrador pare de enviar tráfego novo.
 */
export function setShutdownRequested(value: boolean): void {
  shutdownRequested = value
}

function buildSnapshot(
  db: Awaited<ReturnType<typeof checkDb>>,
  redis: Awaited<ReturnType<typeof checkRedis>>,
): HealthSnapshot {
  // Regra de agregação: qualquer dependência crítica `down` → `degraded`.
  // `skipped` (Redis em dev/test) NÃO conta como down.
  const dbDown = db.status === 'down'
  const redisDown = redis.status === 'down'
  const status = dbDown || redisDown ? 'degraded' : 'ok'

  return {
    status,
    checks: { db, redis },
    generatedAt: new Date().toISOString(),
    cached: false,
  }
}

async function revalidate(): Promise<HealthSnapshot> {
  // `Promise.all` em vez de `allSettled`: cada checker já encapsula seu
  // próprio try/catch e retorna `CheckResult` em vez de throw. Não há
  // promise rejeitada para tratar — `all` é mais simples e suficiente.
  const [db, redis] = await Promise.all([checkDb(), checkRedis()])
  const snapshot = buildSnapshot(db, redis)
  cache = { snapshot, expiresAt: Date.now() + CACHE_TTL_MS }
  return snapshot
}

/** Snapshot degraded para shutdown — usa último cache se disponível. */
function shutdownSnapshot(): HealthSnapshot {
  return {
    status: 'degraded',
    checks: cache?.snapshot.checks ?? {
      db: { status: 'down', latencyMs: 0 },
      redis: { status: 'down', latencyMs: 0 },
    },
    generatedAt: new Date().toISOString(),
    cached: false,
  }
}

/**
 * Retorna snapshot agregado das dependências críticas.
 * Usado por `/health/ready` e `/health` (verbose).
 *
 * Nunca lança — qualquer falha vira snapshot `degraded` com código.
 */
export async function getReadinessSnapshot(): Promise<HealthSnapshot> {
  // Shutdown: retorna degraded imediatamente para drain de tráfego.
  if (shutdownRequested) {
    return shutdownSnapshot()
  }

  // Dev: sempre fresh, bypass de cache.
  if (env.NODE_ENV === 'development') {
    return revalidate()
  }

  const now = Date.now()

  // Empty cache → primeiro probe absorve latência cheia.
  if (!cache) {
    return revalidate()
  }

  // Fresh → serve direto do cache.
  if (now < cache.expiresAt) {
    return { ...cache.snapshot, cached: true }
  }

  // Stale → serve cached imediato + dispara revalidação em background.
  if (!revalidating) {
    revalidating = true
    revalidate()
      .catch((err: unknown) => {
        // Log throttled: no máximo 1× a cada 30s para não poluir em
        // falha persistente, mas dar visibilidade ao oncall.
        const now = Date.now()
        if (now - lastRevalidateErrorAt > REVALIDATE_ERROR_THROTTLE_MS) {
          lastRevalidateErrorAt = now
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[health] SWR background revalidation failed',
          )
        }
      })
      .finally(() => {
        revalidating = false
      })
  }
  return { ...cache.snapshot, cached: true }
}

/**
 * Test helper: limpa cache entre testes.
 * Não exportado pelo `index.ts` — uso interno de teste apenas.
 */
export function _resetHealthCache(): void {
  cache = null
  revalidating = false
  shutdownRequested = false
  lastRevalidateErrorAt = 0
}
