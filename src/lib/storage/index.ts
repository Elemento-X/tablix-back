/**
 * Factory pública do storage (Card 5.1 — Fase 5)
 *
 * Singleton lazy-init do `StorageAdapter`. Caller importa daqui e
 * recebe a implementação corrente (Supabase hoje, S3/R2 amanhã).
 *
 * Em ambiente de teste sem env configurada, retorna `null` em vez
 * de lançar — caller decide se isso é blocker (integration test que
 * exige bucket real) ou se pode ser pulado (suite unit que mocka tudo).
 */

import { env } from '../../config/env'
import {
  createSupabaseStorageAdapter,
  type SupabaseStorageAdapter,
} from './supabase.adapter'
import type { StorageAdapter } from './types'

let cached: SupabaseStorageAdapter | null | undefined

/**
 * Reseta o singleton cached. **Apenas pra testes** — em runtime
 * normal o adapter é estável durante o lifecycle do processo.
 */
export function resetStorageAdapterForTests(): void {
  cached = undefined
}

/**
 * Retorna o adapter configurado. Lazy-init na primeira chamada.
 *
 * **Em production**, env var ausente lança no boot via `superRefine`
 * de `env.ts`, então quando este código roda já temos certeza que
 * tudo está presente. Aqui só cobrimos o caso dev/test sem config.
 *
 * @throws Error se em production e env ausente (não deveria
 *   acontecer — boot já teria falhado)
 */
export function getStorageAdapter(): StorageAdapter | null {
  if (cached !== undefined) return cached

  const url = env.SUPABASE_URL
  const key = env.SUPABASE_STORAGE_KEY
  const bucket = env.SUPABASE_STORAGE_BUCKET

  if (!url || !key || !bucket) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'Storage adapter requested in production but env is incomplete. ' +
          'This indicates env.ts superRefine failed to catch missing vars at boot.',
      )
    }
    cached = null
    return null
  }

  cached = createSupabaseStorageAdapter({ url, key, bucket })
  return cached
}

export type { StorageAdapter, StorageObject, UserScopedPath } from './types'
export { ALLOWED_EXTENSIONS, type AllowedExtension } from './types'
