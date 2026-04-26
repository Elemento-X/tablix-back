/**
 * Schemas Zod do módulo usage — Card 4.1.
 *
 * Define o contrato público de GET /usage e GET /limits, alinhado com
 * `.claude/rules/api-contract.md`:
 *  - Envelope `{ data: ... }` obrigatório (nunca objeto solto no top)
 *  - camelCase em todos os campos JSON
 *  - DTO mapeado, nunca entidade Prisma direta
 *  - Response schema explícito (whitelist, não blacklist)
 *  - Field-level permissions: ambas as rotas são auth-only (JWT obrigatório),
 *    sem campos condicionais por role
 *
 * Reusa `usageSchema`, `limitsSchema` e `planSchema` do common.schema (SSOT
 * já existente) e estende com `resetAt` (timestamp ISO do início do próximo
 * período mensal — útil pra UI mostrar contagem regressiva).
 *
 * @owner: @planner + @reviewer
 * @card: 4.1 (#33)
 */
import { z } from 'zod'
import {
  usageSchema as baseUsageSchema,
  limitsSchema,
  planSchema,
} from '../../schemas/common.schema'

// ============================================
// GET /usage
// ============================================

/**
 * Estende o `usageSchema` base do common.schema com `resetAt` (ISO 8601 UTC).
 * Permite UI calcular dias restantes até o reset mensal sem refazer cálculo
 * client-side.
 */
const usageWithResetSchema = baseUsageSchema.extend({
  resetAt: z
    .string()
    .datetime()
    .describe(
      'Timestamp ISO 8601 UTC do início do próximo período mensal (quando o contador zera)',
    ),
})

export const getUsageResponseSchema = z.object({
  data: usageWithResetSchema,
})

export type GetUsageResponse = z.infer<typeof getUsageResponseSchema>
export type UsageWithReset = z.infer<typeof usageWithResetSchema>

// ============================================
// GET /limits
// ============================================

/**
 * Resposta inclui o `plan` resolvido pelo backend (a partir do JWT) +
 * objeto `limits` correspondente. Cliente nunca decide o plano — é decisão
 * server-side baseada em `request.user.role`.
 */
const limitsWithPlanSchema = z.object({
  plan: planSchema.describe('Plano resolvido server-side a partir do JWT'),
  limits: limitsSchema.describe('Limites do plano (DTO público)'),
})

export const getLimitsResponseSchema = z.object({
  data: limitsWithPlanSchema,
})

export type GetLimitsResponse = z.infer<typeof getLimitsResponseSchema>
export type LimitsWithPlan = z.infer<typeof limitsWithPlanSchema>
