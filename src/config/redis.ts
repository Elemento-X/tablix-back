import { Redis } from '@upstash/redis'
import { env } from './env'

// Cliente Redis do Upstash (singleton)
// Retorna null se não configurado (permite rodar localmente sem Redis)
export const redis =
  env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null

/**
 * Verifica se o Redis está configurado
 */
export function isRedisConfigured(): boolean {
  return redis !== null
}

/**
 * Retorna o cliente Redis ou lança erro se não configurado
 */
export function getRedis(): Redis {
  if (!redis) {
    throw new Error(
      'Redis não configurado. Verifique UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.',
    )
  }
  return redis
}
