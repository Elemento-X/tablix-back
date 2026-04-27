/**
 * Supabase Storage adapter (Card 5.1 — Fase 5)
 *
 * Implementação concreta do `StorageAdapter` user-scoped sobre o SDK
 * `@supabase/supabase-js`. Ponto único de fala com o Supabase Storage
 * — todo módulo upstream chama `getStorageAdapter()` e recebe esta
 * implementação injetada via factory.
 *
 * Hard requirements cobertos:
 *   - #1 bucket privado (config no Supabase, validado em integration)
 *   - #2 user-scoped por construção (paths via key-builder)
 *   - #3 RLS no bucket (aplicada via SQL — bypass por service role
 *        é decisão arquitetural, RLS é defense in depth)
 *   - #4 signed URL TTL curto (5 min default)
 *   - #5 validação de tamanho/MIME no adapter (3a camada após
 *        bucket config + parser)
 *   - #7 SUPABASE_STORAGE_KEY scrubada em logs (Sentry beforeSend)
 *
 * Pattern de erro: SDK do Supabase retorna `{ data, error }`. Adapter
 * mapeia `error` pra `StorageError` discriminada e lança via helper.
 * Caller não precisa lidar com shape do SDK.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  ALLOWED_MIME_TYPES,
  type AllowedExtension,
  type StorageAdapter,
  type StorageError,
  type StorageObject,
  type UserScopedPath,
} from './types'
import {
  assertValidUserId,
  buildUserPrefix,
  buildUserScopedPath,
} from './key-builder'

/**
 * Default signed URL TTL (5 minutos). Hard req #4 do @security:
 * janela curta o suficiente pra leak ser limitado, longa o
 * suficiente pra usuário clicar no link.
 */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300

/**
 * Cap máximo de TTL pra signed URL (1 hora). Caller pode pedir até
 * isso; acima rejeita. Supabase suporta até 7 dias mas TTL longo
 * em URL única amplifica risco de leak.
 */
const MAX_SIGNED_URL_TTL_SECONDS = 3600

/**
 * Limite de objetos por chamada de `list`. Supabase aceita até 1000;
 * cap nosso default pra reduzir payload.
 */
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 1000

/**
 * Patterns de error matching do SDK Supabase. **Exportados pra teste de
 * regressão** — bump do SDK pode mudar mensagens de erro silenciosamente
 * (CWE-697). Tests fixture-based em `storage-supabase-adapter.test.ts`
 * detectam regressão antes de chegar em prod.
 */
export const SUPABASE_ERROR_PATTERNS = {
  alreadyExists: /already exists|duplicate/i,
  notFound: /not found|does not exist/i,
} as const

/**
 * Helper de erro discriminado. Espelha pattern do `key-builder`.
 *
 * **Hardening em prod (@reviewer F-MED `3a8d2f6b4e17`):** zera `cause`
 * em produção pra evitar information disclosure se caller acidentalmente
 * serializar `storageError.cause` em response HTTP. Em dev/test o `cause`
 * fica preservado pra debugging.
 */
function throwStorageError(err: StorageError): never {
  const inProd = process.env.NODE_ENV === 'production'
  const sanitized: StorageError =
    inProd && 'cause' in err ? { ...err, cause: undefined } : err
  const e = new Error(err.message)
  ;(e as Error & { storageError: StorageError }).storageError = sanitized
  throw e
}

/**
 * Adapter Supabase Storage. Construtor recebe `client` injetado pra
 * facilitar mock em testes unit. Use `getStorageAdapter()` da factory
 * (`./index.ts`) pro singleton inicializado com env real.
 */
export class SupabaseStorageAdapter implements StorageAdapter {
  constructor(
    private readonly client: SupabaseClient,
    private readonly bucket: string,
  ) {}

  async uploadForUser(args: {
    userId: string
    jobId: string
    ext: AllowedExtension
    buffer: Buffer
    contentType: string
  }): Promise<{ path: UserScopedPath }> {
    // Hard req #5 do @security: validação de MIME no adapter (3a camada
    // após bucket config + parser). Defesa contra config drift do bucket
    // (alguém marca accept-all no dashboard) + erro upstream caller.
    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(args.contentType)) {
      throwStorageError({
        code: 'INVALID_CONTENT_TYPE',
        message: `contentType must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`,
      })
    }

    const path = buildUserScopedPath({
      userId: args.userId,
      jobId: args.jobId,
      ext: args.ext,
    })

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, args.buffer, {
        contentType: args.contentType,
        upsert: false, // hard req: rejeita overwrite (jobId colidente vira erro explícito)
      })

    if (error) {
      // Supabase reporta "Duplicate" / "already exists" em mensagem string
      // — não tem código estável. Pattern em const exportada permite teste
      // de regressão se SDK mudar mensagem em minor bump (@reviewer ALTO
      // `7c2e8b4d1f95`).
      const isDuplicate = SUPABASE_ERROR_PATTERNS.alreadyExists.test(
        error.message,
      )
      if (isDuplicate) {
        throwStorageError({
          code: 'OBJECT_ALREADY_EXISTS',
          message: 'object already exists at the constructed path',
        })
      }
      throwStorageError({
        code: 'UPLOAD_FAILED',
        message: 'upload to storage failed',
        cause: error.message,
      })
    }

    return { path }
  }

  async getSignedUrlForUser(args: {
    userId: string
    jobId: string
    ext: AllowedExtension
    expiresInSeconds?: number
  }): Promise<{ url: string; expiresAt: Date }> {
    const path = buildUserScopedPath({
      userId: args.userId,
      jobId: args.jobId,
      ext: args.ext,
    })

    const ttl = args.expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS
    if (ttl <= 0 || ttl > MAX_SIGNED_URL_TTL_SECONDS) {
      throwStorageError({
        code: 'SIGNED_URL_FAILED',
        message: `expiresInSeconds must be in (0, ${MAX_SIGNED_URL_TTL_SECONDS}]`,
      })
    }

    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, ttl)

    if (error || !data?.signedUrl) {
      const isNotFound = error
        ? SUPABASE_ERROR_PATTERNS.notFound.test(error.message)
        : false
      if (isNotFound) {
        throwStorageError({
          code: 'OBJECT_NOT_FOUND',
          message: 'object not found at the constructed path',
        })
      }
      throwStorageError({
        code: 'SIGNED_URL_FAILED',
        message: 'failed to generate signed URL',
        cause: error?.message,
      })
    }

    return {
      url: data.signedUrl,
      expiresAt: new Date(Date.now() + ttl * 1000),
    }
  }

  async deleteForUser(args: {
    userId: string
    jobId: string
    ext: AllowedExtension
  }): Promise<{ deleted: boolean }> {
    const path = buildUserScopedPath({
      userId: args.userId,
      jobId: args.jobId,
      ext: args.ext,
    })

    const { data, error } = await this.client.storage
      .from(this.bucket)
      .remove([path])

    if (error) {
      throwStorageError({
        code: 'DELETE_FAILED',
        message: 'failed to delete object',
        cause: error.message,
      })
    }

    // Supabase retorna array de objetos deletados (vazio se não existia).
    // Idempotente: não falha se objeto não existia, mas reporta.
    return { deleted: Array.isArray(data) && data.length > 0 }
  }

  async listForUser(args: {
    userId: string
    limit?: number
  }): Promise<StorageObject[]> {
    assertValidUserId(args.userId)
    const prefix = buildUserPrefix(args.userId)

    const limit = Math.min(args.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    if (limit <= 0) {
      throwStorageError({
        code: 'LIST_FAILED',
        message: 'limit must be positive',
      })
    }

    const { data, error } = await this.client.storage
      .from(this.bucket)
      .list(prefix, { limit })

    if (error || !data) {
      throwStorageError({
        code: 'LIST_FAILED',
        message: 'failed to list user objects',
        cause: error?.message,
      })
    }

    // Supabase list retorna objetos diretos (sem recursão por default).
    // Por enquanto isso atende — usage real do bucket cabe em folders
    // diários e o caller pagina no nível do user.
    return data.map((obj): StorageObject => {
      const metadata = (obj.metadata ?? {}) as {
        size?: number
        mimetype?: string
      }
      return {
        path: `${prefix}${obj.name}` as UserScopedPath,
        sizeBytes: metadata.size ?? 0,
        contentType: metadata.mimetype ?? 'application/octet-stream',
        createdAt: obj.created_at ?? new Date(0).toISOString(),
      }
    })
  }

  async getTotalSize(): Promise<{ bytes: number }> {
    // Supabase Storage não tem agregação nativa. Implementação
    // fallback (O(n) sobre a lista paginada) — Card 5.2 introduz
    // `FileHistory.fileSize` como SSOT e este método vira backup.
    //
    // Por agora pagina no root do bucket com limit max e soma
    // top-level. Buckets grandes (>1000 entradas no root) vão
    // sub-contar — daí a urgência de Card 5.2.
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .list('', { limit: MAX_LIST_LIMIT })

    if (error || !data) {
      throwStorageError({
        code: 'LIST_FAILED',
        message: 'failed to compute total size',
        cause: error?.message,
      })
    }

    const bytes = data.reduce((sum, obj) => {
      const metadata = (obj.metadata ?? {}) as { size?: number }
      return sum + (metadata.size ?? 0)
    }, 0)

    return { bytes }
  }
}

/**
 * Helper de criação injetável. Não use direto — use a factory
 * `getStorageAdapter()` em `./index.ts` (singleton lazy-init).
 */
export function createSupabaseStorageAdapter(args: {
  url: string
  key: string
  bucket: string
}): SupabaseStorageAdapter {
  const client = createClient(args.url, args.key, {
    auth: {
      // Adapter é server-side e usa secret key — não precisa session
      // management nem refresh automático do client. Desliga pra evitar
      // overhead e garantir comportamento determinístico.
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  return new SupabaseStorageAdapter(client, args.bucket)
}
