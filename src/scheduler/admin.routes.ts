/**
 * Admin routes — Card #145 (5.2a) F4.
 *
 * Endpoints administrativos pro scheduler. Toda rota tem auth completa:
 * authMiddleware (Card 1.2: JWT + session.revokedAt) + adminMiddleware
 * (D#3 9 mitigations: allowlist, cache, step-up reauth, etc).
 *
 * Rate limit duplo (cap global + per-admin) — defense em profundidade
 * contra credential leak (1 admin comprometido = 5/min; 5 admins = 25/min;
 * cap 20/min agregado morde antes de saturar API).
 *
 * **Endpoints:**
 *  - POST /admin/jobs/run/:name — dispara job manualmente (recovery/debug)
 *  - GET /admin/jobs/list — snapshot do scheduler (card #159 discovery)
 *
 * **Mit 5 (audit_log_legal AWAIT ANTES):** handler chama
 * `recordAdminActionAttempt` ANTES de `runJobOnce`. Falha de audit = abort
 * (caller recebe 503; ação não roda). Padrão #150 D-1.
 *
 * @owner: @security + @devops
 * @card: #145 (5.2a) F4 / WV-2026-006
 */
import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { authMiddleware } from '../middleware/auth.middleware'
import {
  createGlobalCapMiddleware,
  rateLimitMiddleware,
} from '../middleware/rate-limit.middleware'
import { errorResponseSchema } from '../schemas/common.schema'
import { adminMiddleware, recordAdminActionAttempt } from './admin.middleware'
import { listJobNames, runJobOnce } from './cron'
import { cronHealthResponseSchema, getCronHealthSnapshot } from './health'
import type { JobRunMeta } from './types'

// ============================================
// SCHEMAS
// ============================================

/**
 * `:name` validado contra whitelist do registry — atacante NÃO consegue
 * trigger job arbitrário fora da lista registrada. Defense-in-depth contra
 * adminMiddleware comprometido + injeção de string mágica.
 *
 * Validação aceita kebab-case alfanumérico (mesma convenção
 * CronJobDefinition.name). Whitelist runtime via listJobNames() vem no
 * handler — schema só valida formato.
 */
const adminJobsRunParamsSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(
      /^[a-z][a-z0-9-]+$/,
      'jobName deve ser kebab-case alfanumérico lowercase',
    ),
})

const jobRunStatusEnum = z.enum([
  'running',
  'success',
  'failure',
  'skipped',
  'expired',
])

const jobRunResultSchema = z.object({
  data: z.object({
    jobName: z.string(),
    runId: z.string().uuid(),
    status: jobRunStatusEnum,
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    error: z.string().max(200).nullable(),
    // F5 fix-pack @security BAIXO: removido 'redis_unavailable' — espelha
    // sanitização do enum em health.ts (dead enum value).
    skipReason: z
      .enum(['feature_disabled', 'test_env', 'lock_not_acquired'])
      .nullable(),
  }),
})

type JobRunResult = z.infer<typeof jobRunResultSchema>

function metaToResponse(meta: JobRunMeta): JobRunResult {
  return {
    data: {
      jobName: meta.jobName,
      runId: meta.runId,
      status: meta.status,
      startedAt: meta.startedAt.toISOString(),
      finishedAt: meta.finishedAt?.toISOString() ?? null,
      durationMs: meta.durationMs ?? null,
      error: meta.error ?? null,
      skipReason: meta.skipReason ?? null,
    },
  }
}

// ============================================
// ROUTES
// ============================================

export async function adminRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // =========================================
  // POST /admin/jobs/run/:name — run manual
  // =========================================
  server.post('/admin/jobs/run/:name', {
    preHandler: [
      // Cap global ANTES do per-admin (anti credential leak — 5 admins
      // comprometidos = 25/min mas cap 20 morde antes).
      createGlobalCapMiddleware('adminJobsGlobalCap'),
      rateLimitMiddleware.adminJobs,
      authMiddleware,
      adminMiddleware,
    ],
    schema: {
      tags: ['Admin'],
      summary: 'Executa cron job manualmente (recovery/debug)',
      description: `Dispara job registrado fora do schedule. Respeita
kill-switch + lock distribuído + audit_log_legal (Mit 5 D#3 — registra
intent ANTES da action; falha de audit = 503 sem rodar).

**Auth obrigatório (4 camadas):**
1. JWT válido + session ativa (authMiddleware)
2. userId em \`ADMIN_USER_IDS\` env via timingSafeEqual (Mit 7)
3. User existe no DB (cache 30s — Mit 3)
4. Header \`X-Admin-Confirm: <ts>.<hmac>\` válido (Mit 8 step-up reauth)

**Response status 200** mesmo em \`status: 'skipped'\` (kill-switch off,
lock não adquirido) — caller distingue via campo \`status\` no body.

**Cache:** \`no-store\`.`,
      security: [{ bearerAuth: [] }],
      params: adminJobsRunParamsSchema,
      response: {
        200: jobRunResultSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { name } = request.params

      // Validação adicional: jobName deve estar registrado. Sem isso,
      // recordAdminActionAttempt seria emitido pra job inexistente.
      // F4 fix-pack @security F-BAIXO-01: 404 SEM availableJobs em prod
      // (anti-enumeração CWE-209 — atacante já burlou auth, não precisa
      // facilitar inventory do scheduler). Em dev/test mantém pra UX.
      const registered = listJobNames()
      if (!registered.includes(name)) {
        const isProd = process.env.NODE_ENV === 'production'
        return reply.code(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Cron job não registrado.`,
            ...(isProd ? {} : { details: { availableJobs: registered } }),
          },
        })
      }

      // Mit 5: audit_log_legal AWAIT ANTES da action. Falha = abort.
      // adminMiddleware já validou request.user; non-null assertion safe.
      const userId = request.user!.userId
      const ip = request.ip
      const userAgent = String(
        request.headers['user-agent'] ?? 'unknown',
      ).slice(0, 512)

      await recordAdminActionAttempt({
        adminUserId: userId,
        action: `cron_run_${name}`,
        resourceType: 'scheduler.job',
        resourceId: name,
        ip,
        userAgent,
      })

      const meta = await runJobOnce(name)

      reply.header('Cache-Control', 'no-store')
      return reply.send(metaToResponse(meta))
    },
  })

  // =========================================
  // GET /admin/jobs/list — snapshot health
  // =========================================
  server.get('/admin/jobs/list', {
    preHandler: [
      createGlobalCapMiddleware('adminJobsGlobalCap'),
      rateLimitMiddleware.adminJobs,
      authMiddleware,
      adminMiddleware,
    ],
    schema: {
      tags: ['Admin'],
      summary: 'Lista cron jobs registrados + snapshot last run',
      description: `Snapshot in-memory dos jobs registrados, último run, taxa
de sucesso nas últimas 10 runs. Sem segredos (token de lock omitido,
stack trace sanitizado em error).

Mesma auth do POST /admin/jobs/run/:name (4 camadas + step-up reauth).

**Cache:** \`private, no-cache\` + \`Vary: Authorization\` (admin-only,
pode estar atrás de proxy admin gate).`,
      security: [{ bearerAuth: [] }],
      response: {
        200: cronHealthResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = request.user!.userId
      const ip = request.ip
      const userAgent = String(
        request.headers['user-agent'] ?? 'unknown',
      ).slice(0, 512)

      // Audit list-action também (LGPD: admin viu dados operacionais).
      // Mit 5 do D#3.
      await recordAdminActionAttempt({
        adminUserId: userId,
        action: 'cron_list',
        resourceType: 'scheduler.jobs',
        resourceId: 'all',
        ip,
        userAgent,
      })

      reply.header('Cache-Control', 'private, no-cache')
      reply.header('Vary', 'Authorization')
      return reply.send(getCronHealthSnapshot())
    },
  })
}
