/**
 * Card 2.3 — Schemas Zod das rotas /health/*.
 *
 * Schemas são SSOT do contrato (alimentam Swagger via fastify-type-provider-zod).
 * Mudar shape sem deprecação = breaking change (api-contract.md).
 *
 * Convenções aplicadas:
 *   - camelCase em todos os fields (api-contract.md)
 *   - Envelope `{ data: ... }` no top-level (nunca objeto solto)
 *   - `code` enum estável; `message` é texto livre, NÃO contrato
 *   - Discriminator-friendly: `status` é enum fechado em todos os níveis
 *
 * @owner: @reviewer (api-contract gate)
 */
import { z } from 'zod'

const checkStatusSchema = z.enum(['up', 'down', 'skipped'])

const checkCodeSchema = z.enum([
  'DB_TIMEOUT',
  'DB_ERROR',
  'REDIS_TIMEOUT',
  'REDIS_ERROR',
  'REDIS_NOT_CONFIGURED',
])

const checkResultSchema = z.object({
  status: checkStatusSchema,
  latencyMs: z.number().int().nonnegative(),
  code: checkCodeSchema.optional(),
})

const overallStatusSchema = z.enum(['ok', 'degraded'])

const snapshotSchema = z.object({
  status: overallStatusSchema,
  checks: z.object({
    db: checkResultSchema,
    redis: checkResultSchema,
  }),
  generatedAt: z.string().datetime(),
  cached: z.boolean(),
})

/**
 * `/health/live` — liveness probe.
 * Retorna SEMPRE `{data:{status:'ok'}}` se o processo conseguiu responder.
 * Sem checks externos, sem cache. Status code é único contrato relevante.
 */
export const liveResponseSchema = z.object({
  data: z.object({
    status: z.literal('ok'),
  }),
})

/**
 * `/health/ready` — readiness probe.
 * `200` = pronto pra tráfego; `503` = degraded.
 * Body shape é IDÊNTICO em ambos os status codes (orquestrador olha
 * primariamente o status code; humanos/dashboards olham o body).
 */
export const readyResponseSchema = z.object({
  data: snapshotSchema,
})

/**
 * `GET /health` — verbose para debug humano e dashboard.
 * Estende readiness com metadata: uptime do processo.
 * `version` removido por segurança (reconnaissance — @security finding a7f3c2e1b9d4).
 * NÃO é probe — não usar em Fly.io health check config.
 */
export const healthVerboseResponseSchema = z.object({
  data: snapshotSchema.extend({
    uptimeSeconds: z.number().int().nonnegative(),
  }),
})

/**
 * Erro genérico (rate limited 429). Reusa contrato padrão `{error:{code,message}}`.
 * Não importamos do auth.schema pra evitar acoplamento entre módulos.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})
