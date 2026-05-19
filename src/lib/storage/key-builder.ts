/**
 * Key builder do storage (Card 5.1 — Fase 5)
 *
 * Único ponto que monta paths do storage. Garante:
 *   1. `userId` é UUID v4 estrito (anti path-traversal — `../etc/passwd`
 *      não passa no regex)
 *   2. `jobId` é cuid/cuid2 não-vazio sem caracteres perigosos
 *   3. Data em UTC (consistência com SSOT do `usage.service` Card 4.1)
 *   4. Extensão na whitelist (`csv`/`xlsx`/`xls`)
 *
 * Pattern de path: `{userId}/{yyyy-mm-dd UTC}/{jobId}.{ext}`
 *
 * Hard requirements do @security cobertos:
 *   - #2 Path structure (UUID v4 + UTC + ext whitelist + jobId server-side)
 *   - #5 Upload validation (camada do adapter rejeita antes do Supabase)
 *   - #7 Cross-user enumeration prevenido por construção (caller não
 *        monta path; só passa userId/jobId via adapter user-scoped)
 */

import {
  ALLOWED_EXTENSIONS,
  type AllowedExtension,
  type StorageError,
  type UserScopedPath,
} from './types'

/**
 * Regex UUID v4 estrita (RFC 4122). Aceita apenas:
 *   - 8-4-4-4-12 hex em lowercase
 *   - Versão `4` no 13º char
 *   - Variant `8|9|a|b` no 17º char
 *
 * NÃO aceita uppercase (canonical form), zeros nil UUID, nem outras
 * versões. Pareia com `crypto.randomUUID()` da std lib (sempre v4 lower).
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Regex cuid/cuid2 permissiva: alfanumérico minúsculo, 7+ chars.
 * Cobre cuid (`c...`), cuid2 (`...`), nanoid base alfa.
 *
 * NÃO aceita `.`, `/`, `\`, null bytes, unicode control chars — o que
 * elimina vetor de path traversal via jobId malformado.
 */
const JOB_ID_REGEX = /^[a-z0-9]{7,64}$/

/**
 * Brand factory — único ponto que produz `UserScopedPath`. Marca o
 * tipo pra impedir construção em qualquer outro lugar.
 */
function brand(path: string): UserScopedPath {
  return path as UserScopedPath
}

/**
 * Throw helper — produz `StorageError` discriminada e lança como
 * `Error` com `cause` preservada. Caller pode `try/catch + instanceof`
 * ou inspecionar `error.cause`.
 */
function throwStorageError(err: StorageError): never {
  const e = new Error(err.message)
  ;(e as Error & { storageError: StorageError }).storageError = err
  throw e
}

/**
 * Valida UUID v4 estrito. Lança `INVALID_USER_ID` se falhar.
 *
 * Mensagem genérica (sem revelar valor recebido) pra evitar log leak
 * em error tracking — o `userId` raw fica fora do error message.
 */
export function assertValidUserId(userId: string): void {
  if (typeof userId !== 'string' || !UUID_V4_REGEX.test(userId)) {
    throwStorageError({
      code: 'INVALID_USER_ID',
      message: 'userId must be a valid UUID v4 (lowercase, RFC 4122)',
    })
  }
}

/**
 * Valida jobId server-side (cuid/cuid2/nanoid alphanum). Lança
 * `INVALID_JOB_ID` se falhar. Hard req: jobId NUNCA vem do client.
 */
export function assertValidJobId(jobId: string): void {
  if (typeof jobId !== 'string' || !JOB_ID_REGEX.test(jobId)) {
    throwStorageError({
      code: 'INVALID_JOB_ID',
      message:
        'jobId must be alphanumeric lowercase (cuid/cuid2/nanoid), 7-64 chars',
    })
  }
}

/**
 * Valida ext contra whitelist server-side. Lança `INVALID_EXTENSION`
 * se falhar. Hard req: ext NUNCA derivada do filename do user.
 */
export function assertValidExtension(
  ext: string,
): asserts ext is AllowedExtension {
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throwStorageError({
      code: 'INVALID_EXTENSION',
      message: `ext must be one of: ${ALLOWED_EXTENSIONS.join(', ')}`,
    })
  }
}

/**
 * Defesa em profundidade contra path traversal via concat. Rejeita
 * qualquer string com sequências perigosas, mesmo que validações
 * anteriores tenham passado.
 *
 * Em teoria as asserts de userId/jobId/ext já cobrem isso, mas
 * defense in depth: se qualquer regex regressar/relaxar, este check
 * pega.
 *
 * Implementado via charCodeAt loop (não regex) pra escapar
 * `no-control-regex` do ESLint e tornar o intent explícito (block:
 * traversal sequences + control chars + DEL).
 */
export function assertNoPathTraversal(value: string): void {
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throwStorageError({
      code: 'PATH_TRAVERSAL_REJECTED',
      message: 'path component contains forbidden character',
    })
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    // U+0000–U+001F: control chars (NUL, BEL, BS, HT, LF, VT, FF, CR, ...)
    // U+007F: DEL
    if (code <= 0x1f || code === 0x7f) {
      throwStorageError({
        code: 'PATH_TRAVERSAL_REJECTED',
        message: 'path component contains forbidden character',
      })
    }
  }
}

/**
 * Formata data em `YYYY-MM-DD` UTC. Usa `Date.now()` por padrão (caller
 * pode injetar `now` pra teste determinístico). Sempre UTC — não usa
 * timezone local (consistência com SSOT do `usage.service` Card 4.1).
 */
export function formatUtcDate(now: Date = new Date()): string {
  const year = now.getUTCFullYear().toString().padStart(4, '0')
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = now.getUTCDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Monta path completo do storage user-scoped. Único ponto de
 * construção de `UserScopedPath` no projeto.
 *
 * Pattern: `{userId}/{yyyy-mm-dd UTC}/{jobId}.{ext}`
 *
 * @throws Error com `storageError` discriminada se algum input invalido.
 */
export function buildUserScopedPath(args: {
  userId: string
  jobId: string
  ext: AllowedExtension
  /** Injetar `Date` pra teste determinístico. Default: `new Date()`. */
  now?: Date
}): UserScopedPath {
  assertValidUserId(args.userId)
  assertValidJobId(args.jobId)
  assertValidExtension(args.ext)

  // Defesa em profundidade — paranoia justificada em key builder
  assertNoPathTraversal(args.userId)
  assertNoPathTraversal(args.jobId)
  assertNoPathTraversal(args.ext)

  const datePart = formatUtcDate(args.now)
  return brand(`${args.userId}/${datePart}/${args.jobId}.${args.ext}`)
}

/**
 * Monta o prefixo do user pra operações de listagem. Caller NUNCA
 * passa prefix raw — passa `userId` e o adapter constrói via este
 * helper.
 *
 * @throws Error com `storageError` se userId invalido.
 */
export function buildUserPrefix(userId: string): UserScopedPath {
  assertValidUserId(userId)
  assertNoPathTraversal(userId)
  // Trailing slash pra Supabase tratar como folder prefix
  return brand(`${userId}/`)
}
