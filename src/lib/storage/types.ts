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
 * Mapa determinístico extensão → MIME (Card 6.2). Usado no download pra
 * derivar o `Content-Type` da extensão validada do path, em vez de confiar
 * no metadata do Storage (que pode driftar / vir vazio). `Record` completo
 * sobre `AllowedExtension` — adicionar uma extensão ao enum sem mapear aqui
 * vira erro de compilação.
 */
export const EXTENSION_TO_MIME: Record<AllowedExtension, AllowedMimeType> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
}

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
   * Upload de um INPUT de job assíncrono (Card 6.3). Monta o path por-input
   * via `buildJobInputPath` (`{userId}/{date}/{jobKey}/input-NN.{ext}`) — um
   * job tem N inputs agrupados numa subpasta própria (G-3). Mesmo contrato de
   * segurança do `uploadForUser`: valida MIME, `upsert: false` (rejeita
   * overwrite), path montado internamente a partir de `userId`+`jobId`+`index`.
   *
   * @throws {StorageError} INVALID_USER_ID, INVALID_JOB_ID, INVALID_EXTENSION,
   *   INVALID_CONTENT_TYPE, OBJECT_ALREADY_EXISTS, UPLOAD_FAILED
   */
  uploadJobInput(args: {
    userId: string
    /** `Job.id` UUID — derivado pra jobKey internamente (D-5). */
    jobId: string
    /** Índice 0-based do input dentro do job. */
    index: number
    ext: AllowedExtension
    buffer: Buffer
    contentType: string
    /**
     * Âncora temporal do path (`Job.createdAt`). OBRIGATÓRIO — o path embute a
     * data UTC; derivá-la de `new Date()` a cada chamada torna o caminho
     * NÃO-determinístico (worker 6.4 / cleanup 6.7 reconstroem em outro dia UTC
     * → input não encontrado + órfão de PII). Ancorar em `Job.createdAt` é o
     * SSOT que garante reconstrução determinística por qualquer consumidor
     * (@security/@reviewer F-2).
     */
    createdAt: Date
  }): Promise<{ path: UserScopedPath }>

  /**
   * Upload do OUTPUT (resultado da unificação) de um job assíncrono (Card 6.4).
   * Monta o path via `buildJobOutputPath` (`{userId}/{date}/{jobKey}/output.{ext}`),
   * ancorado em `Job.createdAt` (invariante F-2 — path determinístico, mesmo do
   * worker e do download/cleanup).
   *
   * **Idempotente (`upsert: true`) — diferente de `uploadJobInput`:** o worker
   * pode reprocessar o MESMO job num retry transiente (BullMQ attempts). Como o
   * path é determinístico e exclusivo do job, sobrescrever a própria saída é
   * seguro e desejável (evita OBJECT_ALREADY_EXISTS travando o retry).
   *
   * @throws {StorageError} INVALID_USER_ID, INVALID_JOB_ID, INVALID_EXTENSION,
   *   INVALID_CONTENT_TYPE, UPLOAD_FAILED
   */
  uploadJobOutput(args: {
    userId: string
    /** `Job.id` UUID — derivado pra jobKey internamente (D-5). */
    jobId: string
    ext: AllowedExtension
    buffer: Buffer
    contentType: string
    /** Âncora temporal do path — `Job.createdAt` (SSOT, invariante F-2). */
    createdAt: Date
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
   * Deleta objeto a partir de um path raw (caller já tem o path como
   * string — caso de uso: cron de purge LGPD que lê `file_history.storagePath`
   * do DB). USO RESTRITO — preferir `deleteForUser` quando caller já
   * tem `userId/jobId/ext` separados.
   *
   * **Hard rule (Card #146 R-10):** este método VALIDA o path internamente
   * via `assertValidStoragePath` (regex completa + path traversal check)
   * ANTES de chamar Supabase. Brand `UserScopedPath` em compile-time
   * NÃO prova validez quando path vem do DB; validação runtime é defesa
   * em profundidade contra DB corrompido ou migration futura malfeita.
   *
   * Idempotente: 404 do Supabase é tratado como `{deleted: false, notFound: true}`
   * (não throw). Demais erros throw `DELETE_FAILED`.
   *
   * @throws {StorageError} PATH_TRAVERSAL_REJECTED, INVALID_EXTENSION,
   *   DELETE_FAILED
   */
  removeByPath(
    path: UserScopedPath | string,
  ): Promise<{ deleted: boolean; notFound: boolean }>

  /**
   * Baixa o conteúdo de um objeto a partir de um path (Card 6.2 — G-2).
   * Retorna o buffer completo (não stream): arquivos async vão até 30MB e
   * o worker (Card 6.4) roda `concurrency=1`, então o pico de memória é
   * limitado e previsível. O parser de planilha não é streaming de qualquer
   * forma — bufferizar é o hot path real.
   *
   * **Casos de uso:** worker (6.4) baixando inputs, endpoint de download
   * (6.6) baixando o output. Simétrico ao `removeByPath`: USO RESTRITO a
   * paths construídos via `key-builder` ou lidos do DB.
   *
   * **Hard rule (mesma do `removeByPath`):** VALIDA o path internamente via
   * `assertValidStoragePath` ANTES de tocar o Storage. O brand
   * `UserScopedPath` em compile-time não prova validez quando o path vem do
   * DB; validação runtime é defesa em profundidade.
   *
   * `contentType` é derivado da extensão do path (`EXTENSION_TO_MIME`), não
   * do metadata do Storage.
   *
   * @throws {StorageError} PATH_TRAVERSAL_REJECTED, INVALID_EXTENSION,
   *   OBJECT_NOT_FOUND, DOWNLOAD_FAILED
   */
  downloadByPath(path: UserScopedPath | string): Promise<{
    buffer: Buffer
    contentType: AllowedMimeType
  }>

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
