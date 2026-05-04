/**
 * Usage routes — Card 4.1 (#33).
 *
 * Registra GET /usage e GET /limits. Ambas com auth obrigatório (JWT) e
 * rate limit dedicado (60/min e 100/min, respectivamente).
 *
 * Schemas Zod completos (request + response[2xx, 4xx]) alimentam Swagger.
 *
 * @owner: @planner + @reviewer
 * @card: 4.1 (#33)
 */
import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { authMiddleware } from '../../middleware/auth.middleware'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import * as usageController from '../controllers/usage.controller'
import {
  getUsageResponseSchema,
  getLimitsResponseSchema,
} from '../../modules/usage/usage.schema'
import { errorResponseSchema } from '../../schemas/common.schema'

export async function usageRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // GET /usage — uso do mês corrente
  server.get('/usage', {
    preHandler: [rateLimitMiddleware.usage, authMiddleware],
    schema: {
      tags: ['Usage'],
      summary: 'Uso atual do mês',
      description: `Retorna o uso de unificações do mês corrente para o usuário autenticado.

Inclui contador atual, limite do plano, restantes e timestamp de reset
(início do próximo mês UTC). Cliente pode usar \`resetAt\` para countdown na UI.

**Cache:** \`private, no-cache\` — sempre revalida (uso muda a cada unificação).`,
      security: [{ bearerAuth: [] }],
      response: {
        200: getUsageResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: usageController.getUsage,
  })

  // GET /limits — limites do plano
  server.get('/limits', {
    preHandler: [rateLimitMiddleware.limits, authMiddleware],
    schema: {
      tags: ['Usage'],
      summary: 'Limites do plano',
      description: `Retorna os limites do plano resolvido server-side a partir do JWT.

Inclui plano (FREE/PRO), limites de unificações, arquivos, linhas, colunas
e tamanho. Cliente nunca decide o plano — é decisão exclusiva do servidor
baseada na sessão autenticada.

**Cache:** \`private, max-age=60\` — limites são estáveis por plano, cache
curto reduz round-trips. \`Vary: Authorization\` protege CDN cross-user.`,
      security: [{ bearerAuth: [] }],
      response: {
        200: getLimitsResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: usageController.getLimits,
  })
}
