/**
 * Distributed lock — Card #145 (5.2a) F4.
 *
 * Lock distribuído via Redis SET NX PX + UUID v4 fencing token. Garante
 * exclusividade de execução de cron jobs entre múltiplas instâncias
 * (Fly.io single-machine hoje, mas defesa pra horizontal scaling futuro).
 *
 * Padrão (Redlock single-node simplificado):
 *  - **acquireLock**: `SET key value NX PX ttlMs`. Atomic, retorna `true`
 *    se criou, `null` se key já existia. Token UUID v4 evita "release de
 *    lock alheio" (bug clássico de lock distribuído).
 *  - **release**: Lua CAS — `if GET == ARGV[1] then DEL`. Atomic. Idempotente.
 *  - **heartbeat**: Lua CAS — `if GET == ARGV[1] then PEXPIRE`. Atomic.
 *    Renova TTL apenas se ainda detém o lock (token bate).
 *
 * **Por que NÃO usamos node-redlock**: dependência extra (>20 transitivas),
 * complexidade pra single-node (Redlock multi-node tem trade-offs descritos
 * em https://redis.com/blog/redlock-real-real/). Nosso pattern é o que o
 * próprio autor do Redis recomenda pra single-instance.
 *
 * **Fail-open quando Redis offline:** `acquireLock` retorna `null` (caller
 * trata como "skip job — Redis indisponível"). Em prod sem Redis, isso
 * vira gap (rate-limit + lock ambos no-op) — card discovery #167 endereça.
 *
 * @owner: @security + @devops
 * @card: #145 (5.2a) F4
 */
import { randomUUID } from 'node:crypto'

import { redis } from '../config/redis'
import { logger } from '../lib/logger'
import type { LockHandle } from './types'

// ============================================
// CONSTANTES
// ============================================

/**
 * TTL default do lock. 15min cobre cron #146 (5.2b) purge típico (~5min)
 * com folga 3x. Heartbeat (60s) renova durante execução longa.
 */
const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000

/**
 * Prefix Redis pra namespacing dos locks. Não colide com outros usos
 * (idempotency `tablix:idempotency:`, rate-limit `tablix:ratelimit:`).
 */
const LOCK_KEY_PREFIX = 'tablix:cron:lock:'

// ============================================
// LUA SCRIPTS (atomic CAS)
// ============================================

/**
 * Release CAS: deleta a key APENAS se o valor bate com o token (fencing).
 * Retorna 1 se deletou, 0 se token diferente / key já expirou.
 *
 * Sem isso (DEL direto), worker B que acabou de adquirir o lock perde
 * pra DEL atrasado do worker A (race clássica de lock distribuído).
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

/**
 * Heartbeat CAS: renova TTL APENAS se o valor bate com o token.
 * Retorna 1 se renovou, 0 se perdeu o lock (token diferente / expirou).
 *
 * PEXPIRE em ms (mais preciso que EXPIRE em segundos pra TTLs curtos).
 */
const HEARTBEAT_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`

// ============================================
// HELPERS
// ============================================

function lockKey(jobName: string): string {
  return `${LOCK_KEY_PREFIX}${jobName}`
}

// ============================================
// ACQUIRE LOCK
// ============================================

/**
 * Tenta adquirir lock exclusivo pro job. Retorna `LockHandle` se vencer
 * (SET NX OK), `null` se outro worker detém OU Redis offline.
 *
 * **Caller pattern:**
 * ```ts
 * const lock = await acquireLock('history-purge')
 * if (!lock) {
 *   return { skipReason: 'lock_not_acquired' }
 * }
 * try {
 *   await lock.heartbeat()  // opcional, runner faz periodicamente
 *   await doWork()
 * } finally {
 *   await lock.release()
 * }
 * ```
 *
 * `release()` é idempotente — safe chamar em finally mesmo se handler
 * já chamou no caminho feliz.
 */
export async function acquireLock(
  jobName: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): Promise<LockHandle | null> {
  if (!redis) {
    // Fail-open quando Redis offline. Caller trata como skip.
    // Em prod isso é gap (card discovery #167 endereça health gate).
    logger.warn({ jobName }, 'cron.lock.redis_unavailable.fail_open')
    return null
  }

  const token = randomUUID()
  const key = lockKey(jobName)

  // SET NX PX é atomic no Redis — single statement.
  // Upstash retorna 'OK' se criou, null se já existia.
  const result = await redis.set(key, token, { nx: true, px: ttlMs })

  if (result !== 'OK') {
    // Outro worker detém o lock. Não loga warn — caso esperado em
    // multi-instance (single-machine só vê isso se cron disparar
    // duas vezes seguidas antes da primeira terminar).
    logger.debug({ jobName, key }, 'cron.lock.not_acquired')
    return null
  }

  const acquiredAt = new Date()

  logger.info(
    {
      jobName,
      token,
      ttlMs,
      acquiredAt: acquiredAt.toISOString(),
    },
    'cron.lock.acquired',
  )

  return {
    token,
    jobName,
    acquiredAt,
    heartbeat: () => heartbeatLock(jobName, token, ttlMs),
    release: () => releaseLock(jobName, token),
  }
}

// ============================================
// RELEASE LOCK (CAS via Lua)
// ============================================

/**
 * Libera o lock atomicamente. Retorna sem erro mesmo se token não bate
 * (idempotente). Loga `cron.lock.expired_without_release` (R-8) quando
 * o lock já tinha expirado quando o release rodou — sinal de handler
 * lento + heartbeat falhou.
 */
export async function releaseLock(
  jobName: string,
  token: string,
): Promise<void> {
  if (!redis) return

  const key = lockKey(jobName)

  try {
    const result = await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token])

    if (result === 1) {
      logger.info({ jobName, token }, 'cron.lock.released')
    } else {
      // R-8 do plano: GC longo > TTL lock. Sentry alerta dispara
      // no observability layer; aqui só loga.
      logger.warn({ jobName, token }, 'cron.lock.expired_without_release')
    }
  } catch (err) {
    // Falha de Redis durante release. Lock vai expirar naturalmente
    // pelo TTL — sem ação do caller. Log pra observability.
    logger.error({ jobName, token, err }, 'cron.lock.release_failed')
  }
}

// ============================================
// HEARTBEAT (CAS via Lua)
// ============================================

/**
 * Renova o TTL atomicamente. Retorna `true` se renovou, `false` se perdeu
 * (token diferente OU Redis offline OU script error).
 *
 * Caller deve abortar imediatamente em `false` — outro worker ganhou
 * o lock e está executando em paralelo (split-brain). Continuar pode
 * causar duplicação de write.
 */
async function heartbeatLock(
  jobName: string,
  token: string,
  ttlMs: number,
): Promise<boolean> {
  if (!redis) return false

  const key = lockKey(jobName)

  try {
    const result = await redis.eval(
      HEARTBEAT_LOCK_SCRIPT,
      [key],
      [token, String(ttlMs)],
    )

    const renewed = result === 1

    if (!renewed) {
      logger.warn({ jobName, token }, 'cron.lock.heartbeat_lost')
    } else {
      logger.debug({ jobName, token, ttlMs }, 'cron.lock.heartbeat_ok')
    }

    return renewed
  } catch (err) {
    logger.error({ jobName, token, err }, 'cron.lock.heartbeat_failed')
    return false
  }
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  RELEASE_LOCK_SCRIPT,
  HEARTBEAT_LOCK_SCRIPT,
  DEFAULT_LOCK_TTL_MS,
  LOCK_KEY_PREFIX,
  lockKey,
  heartbeatLock,
}
