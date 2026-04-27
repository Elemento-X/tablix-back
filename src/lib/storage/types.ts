/**
 * Storage abstraction (Card 5.1 — Fase 5)
 *
 * Interface user-scoped por design (hard req #2 do @security): adapter
 * NUNCA aceita path raw do caller — todos os métodos recebem `userId`
 * explícito + recurso, e o adapter monta o path internamente via
 * `key-builder.ts`. Isso elimina a classe inteira de IDOR/BOLA via
 * caller esquecendo de filtrar por userId.
 *
 * Implementação concreta: `supabase.adapter.ts`. Migração futura para
 * S3/R2 = trocar a injeção da factory `getStorageAdapter()`, zero
 * mudança nos callers.
 */

/**
 * Path interno do storage, marcado por brand pra impedir construção
 * fora do `key-builder`. Garante que toda key é UTC-stamped, validada
 * (UUID v4) e ext-whitelisted antes de chegar no adapter.
 */
export type UserScopedPath = string & { readonly __brand: 'UserScoped' }

/**
 * Extensões de arquivo permitidas no upload — espelha o `allowed_mime_types`
 * do bucket Supabase. Adapter rejeita ext fora dessa lista no build da key.
 *
 * MIME mapping:
 *   'csv'  → text/csv
 *   'xlsx' → application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *   'xls'  → application/vnd.ms-excel
 */
export const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'xls'] as const
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number]

/**
 * MIME types permitidos no upload — defesa em camadas com bucket Supabase
 * (3a camada: bucket + adapter + parser). Adapter valida `contentType` no
 * `uploadForUser` ANTES de mandar pro Supabase. Defesa contra config drift
 * do bucket (alguém marca accept-all no dashboard) + erro upstream caller.
 *
 * Espelha `allowed_mime_types` da migration do bucket. Mudança aqui exige
 * mudança correspondente na migration (`supabase/migrations/<ts>_*.sql`).
 */
export const ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
] as const
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

/**
 * Metadados de objeto retornados em `listForUser`. Subset estável dos
 * campos do Supabase Storage — não vazamos shape do SDK.
 */
export interface StorageObject {
  /** Path completo (com prefixo do user). */
  path: UserScopedPath
  /** Tamanho em bytes. */
  sizeBytes: number
  /** Content-Type declarado no upload. */
  contentType: string
  /** ISO-8601 da criação. */
  createdAt: string
}

/**
 * Erro tipado do adapter — discriminated union pra error handling
 * exaustivo no caller (sem `instanceof` frágil). Mapeia erros do
 * Supabase SDK pra códigos estáveis.
 */
export type StorageError =
  | { code: 'INVALID_USER_ID'; message: string }
  | { code: 'INVALID_JOB_ID'; message: string }
  | { code: 'INVALID_EXTENSION'; message: string }
  | { code: 'INVALID_CONTENT_TYPE'; message: string }
  | { code: 'PATH_TRAVERSAL_REJECTED'; message: string }
  | { code: 'OBJECT_NOT_FOUND'; message: string }
  | { code: 'OBJECT_ALREADY_EXISTS'; message: string }
  | { code: 'UPLOAD_FAILED'; message: string; cause?: unknown }
  | { code: 'DOWNLOAD_FAILED'; message: string; cause?: unknown }
  | { code: 'DELETE_FAILED'; message: string; cause?: unknown }
  | { code: 'LIST_FAILED'; message: string; cause?: unknown }
  | { code: 'SIGNED_URL_FAILED'; message: string; cause?: unknown }

/**
 * Adapter de storage user-scoped.
 *
 * **Não expõe** métodos com path raw. Toda operação recebe `userId`
 * explícito, e o adapter monta o path internamente. Isso garante
 * isolamento por user no nível de tipos — caller não consegue
 * acidentalmente acessar prefixo de outro usuário.
 *
 * Paths internos seguem `{userId}/{yyyy-mm-dd UTC}/{jobId}.{ext}`.
 *
 * Implementações: `SupabaseStorageAdapter` (atual). Futuras: S3, R2.
 */
export interface StorageAdapter {
  /**
   * Upload de buffer pro storage. Path montado internamente a partir
   * do `userId` + `jobId` + `ext`. Rejeita se objeto já existir
   * (`upsert: false` — política deliberada pra evitar overwrite
   * silencioso em caso de jobId colidente).
   *
   * @throws {StorageError} INVALID_USER_ID, INVALID_JOB_ID,
   *   INVALID_EXTENSION, OBJECT_ALREADY_EXISTS, UPLOAD_FAILED
   */
  uploadForUser(args: {
    userId: string
    jobId: string
    ext: AllowedExtension
    buffer: Buffer
    contentType: string
  }): Promise<{ path: UserScopedPath }>

  /**
   * Gera signed URL com TTL curto (default 5 min, max 7 dias enforced
   * por Supabase) pro download. Não autentica o caller — caller TEM
   * que ter validado ownership antes.
   *
   * @throws {StorageError} INVALID_USER_ID, INVALID_JOB_ID,
   *   OBJECT_NOT_FOUND, SIGNED_URL_FAILED
   */
  getSignedUrlForUser(args: {
    userId: string
    jobId: string
    ext: AllowedExtension
    expiresInSeconds?: number
  }): Promise<{ url: string; expiresAt: Date }>

  /**
   * Deleta objeto. Idempotente — não falha se objeto já não existe
   * (mas reporta `OBJECT_NOT_FOUND` no result, opcional do caller
   * tratar).
   *
   * @throws {StorageError} INVALID_USER_ID, INVALID_JOB_ID,
   *   DELETE_FAILED
   */
  deleteForUser(args: {
    userId: string
    jobId: string
    ext: AllowedExtension
  }): Promise<{ deleted: boolean }>

  /**
   * Lista objetos do prefixo do user. Adapter monta o prefixo
   * internamente — caller NÃO passa path raw.
   *
   * @throws {StorageError} INVALID_USER_ID, LIST_FAILED
   */
  listForUser(args: {
    userId: string
    /** Limite de resultados (default 100, max 1000 — limite do Supabase). */
    limit?: number
  }): Promise<StorageObject[]>

  /**
   * Soma de bytes de TODO o bucket — usado pra alerta de quota global
   * (Card 5.2 cron de alerta 70%/90%). NÃO é per-user; é o consumo
   * total do bucket no plano Supabase.
   *
   * **Performance:** O(n) sobre a lista paginada. Em buckets grandes
   * isso vira hot path lento — Card 5.2 introduz `FileHistory.fileSize`
   * como SSOT de quota e este método vira fallback.
   *
   * @throws {StorageError} LIST_FAILED
   */
  getTotalSize(): Promise<{ bytes: number }>
}
