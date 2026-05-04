/**
 * Card 2.3 — Health check do Redis (Upstash REST).
 *
 * Upstash REST API expõe `PING` via SDK `@upstash/redis`. É request HTTPS
 * idempotente sem efeito colateral, custo ~zero contra quota mensal.
 *
 * **Comportamento por ambiente:**
 *   - `production` + `redis` null → `down` com `REDIS_NOT_CONFIGURED`.
 *     Em prod, isso é bug de boot (env.ts já bloqueia), mas defense in
 *     depth: probe falha visivelmente em vez de mascarar.
 *   - `development`/`test` + `redis` null → `skipped`. Permite rodar
 *     local sem Upstash configurado (rate limit também degrada para no-op).
 *
 * @owner: @devops
 */
import { redis } from '../../config/redis'
import { env } from '../../config/env'
import type { CheckResult } from './types'
import { TIMEOUTS } from './types'

const TIMEOUT_SENTINEL = Symbol('REDIS_TIMEOUT')

export async function checkRedis(): Promise<CheckResult> {
  if (!redis) {
    if (env.NODE_ENV === 'production') {
      return {
        status: 'down',
        latencyMs: 0,
        code: 'REDIS_NOT_CONFIGURED',
      }
    }
    return {
      status: 'skipped',
      latencyMs: 0,
      code: 'REDIS_NOT_CONFIGURED',
    }
  }

  const start = Date.now()

  let timeoutHandle: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), TIMEOUTS.redis)
  })

  try {
    const pingPromise = redis.ping()
    const result = await Promise.race([pingPromise, timeoutPromise])

    if (result === TIMEOUT_SENTINEL) {
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        code: 'REDIS_TIMEOUT',
      }
    }

    return { status: 'up', latencyMs: Date.now() - start }
  } catch {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      code: 'REDIS_ERROR',
    }
  } finally {
    /* c8 ignore next -- timeoutHandle is always assigned before any path reaches finally */
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
