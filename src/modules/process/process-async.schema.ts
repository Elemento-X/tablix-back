import { z } from 'zod'
import { errorResponseSchema } from '../../schemas/common.schema'
import { processSyncInputSchema } from './process.schema'

// ============================================
// POST /process/async — INPUT (Card 6.3, LRO)
// ============================================

/**
 * Input do async = mesmo contrato do sync (selectedColumns + outputFormat).
 * Reusado deliberadamente pra não duplicar shape (api-contract.md: shape
 * repetido em 2+ rotas é finding MÉDIO). A diferença sync↔async está nos
 * LIMITES de tamanho (async aceita 30MB/arquivo vs 2MB) — validados na borda
 * do multipart no controller, não no Zod do corpo.
 */
export const processAsyncInputSchema = processSyncInputSchema
export type ProcessAsyncInput = z.infer<typeof processAsyncInputSchema>

// ============================================
// JOB STATUS — espelha enum Prisma JobStatus
// ============================================

/**
 * Estados do job. Espelha o enum `JobStatus` do Prisma (PENDING, PROCESSING,
 * COMPLETED, FAILED). Reusado pelo GET /process/status/:jobId (6.5).
 * `CANCELED` NÃO existe — cancelamento está fora do escopo do 6.3.
 */
export const jobStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
])
export type JobStatusDTO = z.infer<typeof jobStatusSchema>

// ============================================
// POST /process/async — RESPONSE 202 Accepted
// ============================================

/**
 * Corpo do 202 Accepted (LRO). Todos os campos camelCase, timestamps ISO 8601
 * UTC (`Z`). O cliente faz polling em `GET /process/status/{jobId}` (Location
 * header aponta pra lá). Whitelist explícita — NÃO vaza entidade Prisma.
 */
export const processAsyncResponseSchema = z.object({
  jobId: z
    .string()
    .uuid()
    .describe('ID do job criado — use em GET /process/status/{jobId}'),
  status: jobStatusSchema.describe('Estado do job (PENDING ao criar)'),
  createdAt: z
    .string()
    .datetime()
    .describe('Momento de criação (ISO 8601 UTC)'),
  expiresAt: z
    .string()
    .datetime()
    .describe(
      'Momento de expiração do output/inputs (ISO 8601 UTC) — após isso o cleanup purga',
    ),
})
export type ProcessAsyncResponse = z.infer<typeof processAsyncResponseSchema>

// ============================================
// IDEMPOTENCY-KEY — contrato (Card 6.3)
// ============================================

/**
 * Limites da Idempotency-Key (alinhado com Stripe/api-contract.md): string
 * não-vazia, máx 255 chars. A presença é OBRIGATÓRIA nesta rota (ausência →
 * 428 IDEMPOTENCY_KEY_REQUIRED) — validada no controller pra controlar o
 * status code, não via schema.headers (que daria 400 genérico).
 */
export const IDEMPOTENCY_KEY_MIN = 1
export const IDEMPOTENCY_KEY_MAX = 255

export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN, 'Idempotency-Key não pode ser vazia')
  .max(
    IDEMPOTENCY_KEY_MAX,
    `Idempotency-Key excede ${IDEMPOTENCY_KEY_MAX} chars`,
  )

// ============================================
// SHARED
// ============================================

export { errorResponseSchema }
