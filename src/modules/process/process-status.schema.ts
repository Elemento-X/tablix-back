import { z } from 'zod'
import { errorResponseSchema } from '../../schemas/common.schema'
import { jobStatusSchema } from './process-async.schema'

// ============================================
// GET /process/status/:jobId — INPUT (Card 6.5, polling do LRO)
// ============================================

/** Params: o `jobId` é o `Job.id` (UUID v4) retornado pelo 202 do /process/async. */
export const processStatusParamsSchema = z.object({
  jobId: z.string().uuid('jobId inválido (esperado UUID v4)'),
})
export type ProcessStatusParams = z.infer<typeof processStatusParamsSchema>

// ============================================
// GET /process/status/:jobId — RESPONSE 200
// ============================================

/**
 * DTO de status do job (LRO). Shape ESTÁVEL — campos condicionais são
 * `nullable` (sempre presentes, `null` quando não-aplicáveis) pra o front ter
 * uma forma previsível no polling, sem misturar "ausente" vs "null"
 * (api-contract.md empty-state).
 *
 * Whitelist explícita — NÃO vaza entidade Prisma. Timestamps ISO 8601 UTC.
 *
 * Decisões materializadas:
 *  - `downloadUrl` (só COMPLETED): PATH da rota de download (6.6,
 *    `/process/download/{jobId}`), NÃO signed-URL — a entrega é stream via
 *    backend pra entrega única + audit (decisão D-4).
 *  - `outputSize` (só COMPLETED): STRING decimal (a coluna é BIGINT; number
 *    perderia precisão / BigInt não serializa em JSON — api-contract.md numeric
 *    precision, binding B-6.5.1).
 *  - `errorMessage` (só FAILED): mensagem genérica do catálogo do worker (já
 *    sanitizada na origem — nunca path/stack).
 */
export const processStatusResponseSchema = z.object({
  jobId: z.string().uuid().describe('ID do job (UUID v4)'),
  status: jobStatusSchema.describe('Estado atual do job'),
  createdAt: z.string().datetime().describe('Criação (ISO 8601 UTC)'),
  completedAt: z
    .string()
    .datetime()
    .nullable()
    .describe('Finalização (sucesso OU falha); null se ainda em andamento'),
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .describe('Expiração do output/inputs pro cleanup; null se não definido'),
  errorMessage: z
    .string()
    .nullable()
    .describe('Mensagem genérica de falha — preenchida só quando FAILED'),
  downloadUrl: z
    .string()
    .nullable()
    .describe(
      'Path do download (GET /process/download/{jobId}) — preenchido só quando COMPLETED',
    ),
  outputSize: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .describe(
      'Tamanho do output em bytes (string decimal) — só quando COMPLETED',
    ),
})
export type ProcessStatusResponse = z.infer<typeof processStatusResponseSchema>

export { errorResponseSchema }
