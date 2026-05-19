/**
 * Schemas Zod do módulo history — Card #145 (5.2a, Fase 5 Storage).
 *
 * Define o contrato cross-card v1 (CONGELADO) que será consumido por:
 *  - 5.2a (este card) — endpoints REST de opt-in/listagem/delete
 *  - 5.2b (#146) — cron purge two-phase (DTOs de candidate query)
 *  - 5.2c (#147) — cron alerta quota (DTOs de aggregate)
 *
 * Decisões fechadas (não revisitar sem nova versão):
 *  - D#1 (DELETE confirmation): { confirmation: "CONFIRM_DELETE_ALL" } literal.
 *    z.literal() rejeita coerção (boolean, etc) por construção.
 *  - D#4 (Listagem opt-out): retornar 403 FEATURE_DISABLED, não 200 vazio.
 *    Invariante cross-card: GET /history E /history/:id seguem a regra.
 *  - originalFilename: max 255 + reject control chars (alinhado com CHECK
 *    constraint do schema). Validação Zod no controller falha 400; CHECK
 *    constraint é defense em profundidade (falha 500 se Zod regredir).
 *
 * Padrão Tablix:
 *  - Envelope `{ data: ... }` em response (`api-contract.md`)
 *  - camelCase em todos os campos JSON
 *  - DTO mapeado, nunca entidade Prisma direta
 *  - Response schema explícito (whitelist, não blacklist) — evita leak de
 *    campos novos quando schema do banco evolui (lição Card 5.1)
 *  - Lição Card #32/#105-107: shapes Zod EXPLÍCITOS, NUNCA z.record(z.unknown())
 *
 * @owner: @planner + @reviewer
 * @card: #145 (5.2a)
 */
import { z } from 'zod'

// ============================================
// CONSTANTES (cross-card congeladas)
// ============================================

/**
 * Texto literal de confirmação destrutiva. NUNCA mudar — quebra contrato
 * com cliente legítimo. Defesa contra erro silencioso de cliente buggado
 * (D#1 do WV-2026-006). Padrão GitHub repo delete + AWS S3 wipe + Stripe.
 */
export const DELETE_ALL_CONFIRMATION_LITERAL = 'CONFIRM_DELETE_ALL' as const

/**
 * Limite de itens por página da listagem de histórico. Cursor pagination
 * (cursor opaco). Default razoável; client pode pedir menor.
 */
export const HISTORY_LIST_DEFAULT_LIMIT = 20
export const HISTORY_LIST_MAX_LIMIT = 100

// ============================================
// COMMON SHAPES
// ============================================

/**
 * Validação cliente do `originalFilename`. Espelha CHECK constraint do
 * schema (`file_history_original_filename_check`):
 *  - length 1-255
 *  - sem control chars 0x00-0x1F + 0x7F (DEL)
 *
 * Falha aqui retorna 400 explícito; falha no DB retorna 500 (defesa em
 * profundidade, não user-facing).
 */
/**
 * Loop charCodeAt pra escapar `no-control-regex` do ESLint e tornar o
 * intent explícito. Mesmo pattern de `assertNoPathTraversal` em
 * src/lib/storage/key-builder.ts.
 *
 * Bloqueia (defense em profundidade):
 *  - U+0000–U+001F (C0 controls: NUL, BEL, BS, HT, LF, VT, FF, CR, ...)
 *  - U+007F (DEL)
 *  - U+200E, U+200F (LRM/RLM — bidi marks)
 *  - U+2028, U+2029 (line/paragraph separators — quebram parsers JSON)
 *  - U+202A–U+202E (LRE/RLE/PDF/LRO/RLO — bidi overrides; vetor de spoofing
 *    de filename: "evil‮txt.exe" exibido como "evilexe.txt")
 *
 * F2 fix-pack @security BAIXO: ampliação além de C0+DEL pra cobrir
 * Unicode line separators + bidi controls (RFC 9839).
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
    if (code === 0x200e || code === 0x200f) return true
    if (code === 0x2028 || code === 0x2029) return true
    if (code >= 0x202a && code <= 0x202e) return true
  }
  return false
}

const originalFilenameSchema = z
  .string()
  .min(1, 'originalFilename não pode ser vazio')
  .max(255, 'originalFilename excede 255 caracteres')
  .refine(
    (val) => !hasControlChar(val),
    'originalFilename contém caracteres de controle não permitidos',
  )

/**
 * UUID v4 estrito (RFC 4122). Espelha o pattern usado em `key-builder.ts`
 * do Card 5.1.
 */
const uuidV4Schema = z
  .string()
  .uuid('id deve ser UUID v4 válido')
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'id deve ser UUID v4 lowercase (RFC 4122)',
  )

// ============================================
// POST /history/enable — opt-in
// ============================================

/**
 * Body vazio. Idempotency-Key opcional via header. Reativar opt-in já
 * ativado é no-op (não falha; apenas atualiza historyOptInAt).
 */
export const enableHistoryRequestSchema = z.object({}).strict()

export const enableHistoryResponseSchema = z.object({
  data: z.object({
    historyOptIn: z.literal(true),
    historyOptInAt: z.string().datetime({ offset: true }),
  }),
})

export type EnableHistoryRequest = z.infer<typeof enableHistoryRequestSchema>
export type EnableHistoryResponse = z.infer<typeof enableHistoryResponseSchema>

// ============================================
// POST /history/disable — opt-out (agenda purga)
// ============================================

/**
 * Disable agenda purga em `env.PRO_RETENTION_DAYS` dias (D#2 fechada).
 * Body vazio. Idempotency-Key opcional via header.
 *
 * Response inclui `purgeScheduledFor` pra UI mostrar contagem regressiva
 * ("seu histórico será apagado em N dias").
 */
export const disableHistoryRequestSchema = z.object({}).strict()

export const disableHistoryResponseSchema = z.object({
  data: z.object({
    historyOptIn: z.literal(false),
    historyOptOutAt: z.string().datetime({ offset: true }),
    /**
     * Timestamp ISO UTC da purga agendada (created_at + PRO_RETENTION_DAYS).
     * Cliente exibe "histórico apagado em N dias" via diff client-side.
     */
    purgeScheduledFor: z.string().datetime({ offset: true }),
    /**
     * Quantidade de rows tiveram TTL encurtado neste batch. Útil pra UX:
     * "X arquivos serão apagados em N dias".
     */
    affectedRowCount: z.number().int().nonnegative(),
    /**
     * `true` se o batch atingiu o cap de 10k rows (F3 fix-pack @dba MÉDIO).
     * Cliente pode repetir POST /history/disable pra processar o restante.
     * User PRO denso (>10k rows ativas) precisa de múltiplos rounds.
     */
    truncated: z.boolean(),
  }),
})

export type DisableHistoryRequest = z.infer<typeof disableHistoryRequestSchema>
export type DisableHistoryResponse = z.infer<
  typeof disableHistoryResponseSchema
>

// ============================================
// GET /history — listagem paginada
// ============================================

/**
 * Cursor pagination (preferida sobre offset — `api-contract.md`). Cursor
 * é opaco pro cliente (base64 de `{id, createdAt}`).
 */
export const listHistoryQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(HISTORY_LIST_MAX_LIMIT)
    .default(HISTORY_LIST_DEFAULT_LIMIT),
})

/**
 * DTO de item na listagem. Whitelist explícita — schema do banco pode
 * evoluir (ex: adicionar coluna `purgeAttempts` que é uso interno do cron),
 * o response NÃO vaza isso por construção.
 */
export const fileHistoryDtoSchema = z.object({
  id: uuidV4Schema,
  originalFilename: originalFilenameSchema,
  mimeType: z.string().min(1).max(127),
  fileSizeBytes: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  /**
   * ISO UTC. Cliente calcula "expira em N dias" com diff client-side.
   * Regra alinhada com CHECK constraint expires_at >= created_at.
   */
  expiresAt: z.string().datetime({ offset: true }),
})

export type FileHistoryDto = z.infer<typeof fileHistoryDtoSchema>

export const listHistoryResponseSchema = z.object({
  data: z.array(fileHistoryDtoSchema),
  meta: z.object({
    /** Cursor pra próxima página, ou null se acabou. */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
})

export type ListHistoryQuery = z.infer<typeof listHistoryQuerySchema>
export type ListHistoryResponse = z.infer<typeof listHistoryResponseSchema>

// ============================================
// GET /history/:id — detalhe + signed URL
// ============================================

export const getHistoryParamsSchema = z.object({
  id: uuidV4Schema,
})

/**
 * Detalhe inclui signedUrl efêmera (TTL 60s — D#1 residual mitigation R-9).
 * NUNCA persistir signedUrl no DB; sempre gerada on-demand.
 */
export const getHistoryResponseSchema = z.object({
  data: fileHistoryDtoSchema.extend({
    signedUrl: z.string().url(),
    /**
     * ISO UTC do momento que a signedUrl expira. Cliente sabe quando
     * pedir nova URL. Limitação conhecida: signed URL pré-gerada continua
     * válida até esse timestamp mesmo após DELETE da row (R-9, card #158).
     */
    signedUrlExpiresAt: z.string().datetime({ offset: true }),
  }),
})

export type GetHistoryParams = z.infer<typeof getHistoryParamsSchema>
export type GetHistoryResponse = z.infer<typeof getHistoryResponseSchema>

// ============================================
// DELETE /history/:id — purga individual (two-phase)
// ============================================

export const deleteOneHistoryParamsSchema = z.object({
  id: uuidV4Schema,
})

/**
 * Body vazio. Two-phase: marca deleted_at = NOW(). Cron #146 apaga objeto
 * físico depois. Resposta 200 com timestamp da operação (não 204 porque
 * cliente quer audit trail no UI: "deletado em ...").
 */
export const deleteOneHistoryRequestSchema = z.object({}).strict()

export const deleteOneHistoryResponseSchema = z.object({
  data: z.object({
    id: uuidV4Schema,
    deletedAt: z.string().datetime({ offset: true }),
  }),
})

export type DeleteOneHistoryParams = z.infer<
  typeof deleteOneHistoryParamsSchema
>
export type DeleteOneHistoryRequest = z.infer<
  typeof deleteOneHistoryRequestSchema
>
export type DeleteOneHistoryResponse = z.infer<
  typeof deleteOneHistoryResponseSchema
>

// ============================================
// DELETE /history — purga em massa (D#1)
// ============================================

/**
 * Confirmation literal `"CONFIRM_DELETE_ALL"` (D#1 fechada 2026-05-02).
 * z.literal() rejeita coerção. Mensagem de erro inclui o payload exato
 * pra dev legítimo não perder 20min debugando 400.
 */
export const deleteAllHistoryRequestSchema = z
  .object({
    confirmation: z.literal(DELETE_ALL_CONFIRMATION_LITERAL, {
      errorMap: () => ({
        message: `Confirmation required. Send body: { "confirmation": "${DELETE_ALL_CONFIRMATION_LITERAL}" } to proceed with irreversible deletion of all your file history.`,
      }),
    }),
  })
  .strict()

/**
 * Resposta 200 com count + timestamp + audit log id (pra cliente verificar
 * trail forense se precisar). Two-phase: marca deleted_at; cron apaga
 * objetos físicos depois.
 */
export const deleteAllHistoryResponseSchema = z.object({
  data: z.object({
    /** Quantidade de rows marcadas (cap LIMIT 10k — R-4 do plano). */
    affectedRowCount: z.number().int().nonnegative(),
    /** ISO UTC do batch delete. */
    deletedAt: z.string().datetime({ offset: true }),
    /**
     * Indica se atingiu o cap de 10k rows. Cliente exibe "operação parcial,
     * repita pra deletar o resto". Cap previne lock prolongado em batch
     * grande (R-4 do plano).
     */
    truncated: z.boolean(),
  }),
})

export type DeleteAllHistoryRequest = z.infer<
  typeof deleteAllHistoryRequestSchema
>
export type DeleteAllHistoryResponse = z.infer<
  typeof deleteAllHistoryResponseSchema
>

// ============================================
// CROSS-CARD DTOs (consumidos por 5.2b/5.2c)
// ============================================

/**
 * Candidate query DTO consumido pelo cron purge (#146). Subset mínimo
 * pro worker conseguir apagar Storage + atualizar status sem query nova.
 *
 * NUNCA expor isso em endpoint público — é contrato interno cron worker.
 */
export const filePurgeCandidateSchema = z.object({
  id: uuidV4Schema,
  userId: uuidV4Schema,
  storagePath: z.string().min(1).max(255),
  expiresAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
  purgeAttempts: z.number().int().nonnegative(),
})

export type FilePurgeCandidate = z.infer<typeof filePurgeCandidateSchema>

/**
 * Aggregate por usuário consumido pelo cron alerta de quota (#147).
 * Soma de bytes ativos (deleted_at IS NULL) — SSOT em cima de
 * `file_history.fileSize` (Card 5.1 getTotalSize() é fallback).
 */
export const userStorageAggregateSchema = z.object({
  userId: uuidV4Schema,
  activeRowCount: z.number().int().nonnegative(),
  activeBytes: z.number().int().nonnegative(),
})

export type UserStorageAggregate = z.infer<typeof userStorageAggregateSchema>
