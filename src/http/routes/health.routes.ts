/**
 * Card 2.3 — Rotas de health check.
 *
 * Três rotas com contratos distintos e propósitos não-intercambiáveis:
 *
 *   GET /health/live
 *     Liveness probe (orquestrador). Sempre 200 se o processo respondeu.
 *     Sem checks externos, sem cache, sem rate limit. Latência alvo: <5ms p99.
 *     Usado pelo Fly.io para detectar deadlock/event-loop travado.
 *
 *   GET /health/ready
 *     Readiness probe (orquestrador). 200 se DB+Redis OK; 503 se qualquer
 *     dependência crítica down. Cache stale-while-revalidate de 2s
 *     (ver orchestrator.ts). Latência alvo: <50ms p99 com cache warm.
 *     Usado pelo Fly.io para decidir se o container pode receber tráfego.
 *
 *   GET /health
 *     Verbose para debug humano e dashboard. Mesmo snapshot do /ready
 *     + version + uptime. NÃO É probe — não usar em config de Fly.io.
 *
 * **Auth/CORS:**
 *   Esta rota NÃO declara `authMiddleware` — é pública por design (probes
 *   vêm do orquestrador, não de cliente autenticado). Auth no Tablix é
 *   per-route (não global), então basta omitir aqui.
 *
 * **Rate limit:**
 *   - `/live` sem rate limit (precisa responder mesmo sob ataque)
 *   - `/ready` e `/health` com limiter `health` (60/min por IP)
 *
 * @owner: @devops + @reviewer (api-routes + api-contract)
 */
import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import { getReadinessSnapshot } from '../../lib/health'
import {
  liveResponseSchema,
  readyResponseSchema,
  healthVerboseResponseSchema,
  errorResponseSchema,
} from '../../modules/health/health.schema'

/**
 * Timestamp do boot do processo. Capturado uma vez no module load —
 * usado pra calcular `uptimeSeconds` em /health verbose.
 */
const BOOT_AT = Date.now()

export async function healthRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // GET /health/live — liveness probe
  server.get('/live', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness probe',
      description:
        'Sempre 200 se o processo está vivo. NÃO toca dependências externas. ' +
        'Usado pelo orquestrador (Fly.io) para detectar processo travado/deadlock.',
      operationId: 'healthLive',
      response: {
        200: liveResponseSchema,
      },
    },
    handler: async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      return { data: { status: 'ok' as const } }
    },
  })

  // GET /health/ready — readiness probe
  server.get('/ready', {
    preHandler: rateLimitMiddleware.health,
    schema: {
      tags: ['Health'],
      summary: 'Readiness probe',
      description:
        '200 se dependências críticas (DB, Redis) estão up; 503 se degraded. ' +
        'Cache in-process stale-while-revalidate de 2s. ' +
        'Usado pelo orquestrador para decidir se o container recebe tráfego.',
      operationId: 'healthReady',
      response: {
        200: readyResponseSchema,
        503: readyResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const snapshot = await getReadinessSnapshot()

      // Log estruturado de degradação — herda reqId do hook onRequest
      // e REDACT_PATHS do logger pino (Card 2.1). Não logamos quando
      // 'ok' pra evitar spam (probe roda a cada 10s).
      if (snapshot.status === 'degraded') {
        request.log.warn(
          {
            db: snapshot.checks.db,
            redis: snapshot.checks.redis,
            cached: snapshot.cached,
          },
          '[health] readiness degraded',
        )
      }

      reply.header('Cache-Control', 'no-store')
      const httpStatus = snapshot.status === 'ok' ? 200 : 503
      return reply.status(httpStatus).send({ data: snapshot })
    },
  })

  // GET /health — verbose para debug humano / dashboard
  server.get('/', {
    preHandler: rateLimitMiddleware.health,
    schema: {
      tags: ['Health'],
      summary: 'Health check verbose (debug)',
      description:
        'Snapshot do /ready estendido com uptime do processo. ' +
        'Para debug humano e dashboard. NÃO é probe. ' +
        'Versão do serviço omitida por segurança (reconnaissance — @security finding a7f3c2e1b9d4).',
      operationId: 'healthVerbose',
      response: {
        200: healthVerboseResponseSchema,
        503: healthVerboseResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: async (_request, reply) => {
      const snapshot = await getReadinessSnapshot()
      reply.header('Cache-Control', 'no-store')

      const httpStatus = snapshot.status === 'ok' ? 200 : 503
      return reply.status(httpStatus).send({
        data: {
          ...snapshot,
          uptimeSeconds: Math.floor((Date.now() - BOOT_AT) / 1000),
        },
      })
    },
  })
}
