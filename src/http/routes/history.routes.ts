/**
 * History routes — Card #145 (5.2a, Fase 5 Storage).
 *
 * Registra 6 endpoints REST do feature opt-in de histórico de arquivos PRO:
 *
 *  POST /history/enable   — opt-in (consent_given AWAIT)
 *  POST /history/disable  — opt-out (consent_withdrawn AWAIT + agenda purga)
 *  GET  /history          — listagem paginada (cursor)
 *  GET  /history/:id      — detalhe + signedUrl efêmera (TTL 60s)
 *  DELETE /history/:id    — soft-delete individual
 *  DELETE /history        — soft-delete em massa (Idempotency-Key MANDATORY)
 *
 * Toda rota tem auth obrigatório (JWT) + rate limit dedicado. Endpoints
 * que tocam recursos opt-in (GET/DELETE) verificam `historyOptIn` no
 * controller e retornam 403 FEATURE_DISABLED se desligado (invariante D#4).
 *
 * **Rate limits (5 limiters distintos do F2):**
 *  - historyOptIn: 10/min (POST enable/disable — operação rara por user)
 *  - historyList: 60/min (GET — polling-friendly)
 *  - historyDeleteOne: 5/min (DELETE /:id — anti-abuse)
 *  - historyDeleteAll: 1 req/5min POR USER (DELETE — atrito proposital)
 *  - historyDeleteAllGlobalCap: 5 req/5min AGREGADO (denial-of-wallet)
 *
 * **Schemas Zod completos** (request + response 2xx + 4xx) alimentam Swagger.
 *
 * @owner: @planner + @reviewer
 * @card: #145 (5.2a) F3
 */
import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'

import { authMiddleware } from '../../middleware/auth.middleware'
import {
  createGlobalCapMiddleware,
  rateLimitMiddleware,
} from '../../middleware/rate-limit.middleware'
import {
  deleteAllHistoryRequestSchema,
  deleteAllHistoryResponseSchema,
  deleteOneHistoryParamsSchema,
  deleteOneHistoryRequestSchema,
  deleteOneHistoryResponseSchema,
  disableHistoryRequestSchema,
  disableHistoryResponseSchema,
  enableHistoryRequestSchema,
  enableHistoryResponseSchema,
  getHistoryParamsSchema,
  getHistoryResponseSchema,
  listHistoryQuerySchema,
  listHistoryResponseSchema,
} from '../../modules/history/history.schema'
import { errorResponseSchema } from '../../schemas/common.schema'
import * as historyController from '../controllers/history.controller'

export async function historyRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // =========================================
  // POST /history/enable — opt-in
  // =========================================
  server.post('/history/enable', {
    preHandler: [rateLimitMiddleware.historyOptIn, authMiddleware],
    schema: {
      tags: ['History'],
      summary: 'Habilitar histórico de arquivos (opt-in)',
      description: `Liga o feature opt-in de histórico de arquivos. Idempotente —
chamada repetida apenas atualiza o timestamp \`historyOptInAt\`.

**LGPD:** emite evento \`consent_given\` no audit_log_legal (retenção 5 anos)
ANTES da mutação. Se o evento legal falhar, a operação é abortada (sem prova
jurídica do consentimento).

**Cache:** \`no-store\` (mutação).`,
      security: [{ bearerAuth: [] }],
      body: enableHistoryRequestSchema,
      response: {
        200: enableHistoryResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
    handler: historyController.postEnableHistory,
  })

  // =========================================
  // POST /history/disable — opt-out + agenda purga
  // =========================================
  server.post('/history/disable', {
    preHandler: [rateLimitMiddleware.historyOptIn, authMiddleware],
    schema: {
      tags: ['History'],
      summary: 'Desabilitar histórico (opt-out + agenda purga)',
      description: `Desliga o feature opt-in. Encurta \`expires_at\` de TODAS
as rows ativas para no máximo \`PRO_RETENTION_DAYS\` dias a partir de agora
(via SQL LEAST — só encurta, nunca estende). Cron #146 (5.2b) apaga rows
expiradas posteriormente.

**LGPD:** emite \`consent_withdrawn\` AWAIT (legal_basis='feature_opt_out')
ANTES da mutação. Falha = abort total.

**Resposta:** inclui \`affectedRowCount\` (quantas rows tiveram TTL encurtado)
e \`purgeScheduledFor\` (cap superior do quando os dados sumirão).`,
      security: [{ bearerAuth: [] }],
      body: disableHistoryRequestSchema,
      response: {
        200: disableHistoryResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
    handler: historyController.postDisableHistory,
  })

  // =========================================
  // GET /history — listagem paginada
  // =========================================
  server.get('/history', {
    preHandler: [rateLimitMiddleware.historyList, authMiddleware],
    schema: {
      tags: ['History'],
      summary: 'Listar histórico de arquivos do usuário',
      description: `Cursor pagination (preferido sobre offset). Cliente NUNCA
decodifica o cursor — apenas passa de volta. Resposta inclui \`meta.nextCursor\`
e \`meta.hasMore\`.

**Invariante D#4:** retorna **403 FEATURE_DISABLED** se \`historyOptIn=false\`
(mesmo regra para GET /history/:id). NUNCA retorna 200 com array vazio quando
existem rows — viola direito de informação ao titular do dado (LGPD).

**Cache:** \`private, no-cache\` + \`Vary: Authorization\`.`,
      security: [{ bearerAuth: [] }],
      querystring: listHistoryQuerySchema,
      response: {
        200: listHistoryResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: historyController.getListHistory,
  })

  // =========================================
  // GET /history/:id — detalhe + signed URL
  // =========================================
  server.get('/history/:id', {
    preHandler: [rateLimitMiddleware.historyList, authMiddleware],
    schema: {
      tags: ['History'],
      summary: 'Detalhe de uma entrada do histórico',
      description: `Retorna metadata + signedUrl efêmera (TTL 60s) para
download. signedUrl gerada on-demand, NUNCA persistida no DB.

**Limitação conhecida (R-9):** signedUrl pré-gerada continua válida até o
\`signedUrlExpiresAt\` mesmo após DELETE da row. Card #158 endereça revogação.

**Mesma invariante D#4 do GET /history:** 403 FEATURE_DISABLED se
\`historyOptIn=false\`. 404 se row não existe / soft-deletada / cross-tenant
(mesma resposta — anti enumeração CWE-203).

**Cache:** \`private, no-store\` (signedUrl é efêmera).`,
      security: [{ bearerAuth: [] }],
      params: getHistoryParamsSchema,
      response: {
        200: getHistoryResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: historyController.getOneHistoryHandler,
  })

  // =========================================
  // DELETE /history/:id — purga individual (two-phase)
  // =========================================
  server.delete('/history/:id', {
    preHandler: [rateLimitMiddleware.historyDeleteOne, authMiddleware],
    schema: {
      tags: ['History'],
      summary: 'Soft-delete de uma entrada (two-phase)',
      description: `Marca \`deleted_at = NOW()\`. Cron #146 (5.2b) apaga
objeto físico no Storage e depois hard-deleta a row.

Idempotente — chamadas repetidas após a primeira retornam 404 (row já
invisível pro user). Mesma resposta para "não existe" / "já deletada" /
"cross-tenant" — anti enumeração.

**Cache:** \`no-store\`.`,
      security: [{ bearerAuth: [] }],
      params: deleteOneHistoryParamsSchema,
      body: deleteOneHistoryRequestSchema,
      response: {
        200: deleteOneHistoryResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    handler: historyController.deleteOneHistoryHandler,
  })

  // =========================================
  // DELETE /history — purga em massa (D#1)
  // =========================================
  server.delete('/history', {
    preHandler: [
      // Cap global ANTES do per-user (anti denial-of-wallet — cap morde
      // mesmo se atacante tem N contas). Pattern Card 8.7 / billing.
      createGlobalCapMiddleware('historyDeleteAllGlobalCap'),
      rateLimitMiddleware.historyDeleteAll,
      authMiddleware,
    ],
    schema: {
      tags: ['History'],
      summary: 'Soft-delete em MASSA do histórico do usuário',
      description: `Operação destrutiva irreversível. Marca \`deleted_at = NOW()\`
em até **10.000 rows ativas** (cap R-4). Cron #146 apaga objetos físicos
posteriormente. Resposta inclui \`truncated: true\` se atingiu o cap —
cliente pode repetir a operação para limpar o restante.

**Confirmation MANDATORY (D#1):** body deve conter
\`{ "confirmation": "CONFIRM_DELETE_ALL" }\` literal. \`z.literal()\` rejeita
coerção (boolean true, etc). Atrito proposital contra cliente buggado /
curl errado / replay de payload genérico.

**Idempotency-Key MANDATORY:** header \`Idempotency-Key: <uuid-v4-lowercase>\`
obrigatório. Sem header = 400 VALIDATION_ERROR. Protege contra retry de
timeout que dispararia segundo wipe.

**Rate limit:** 1 req/5min POR USER + cap global agregado de 5 req/5min
(denial-of-wallet contra Supabase delete API que é paga).

**LGPD:** emite \`consent_withdrawn\` AWAIT com legal_basis='user_request_art_18'
(direito de eliminação) + metadata { ip, userAgent, fingerprint } pro audit
forense.

**Cache:** \`no-store\`.`,
      security: [{ bearerAuth: [] }],
      body: deleteAllHistoryRequestSchema,
      response: {
        200: deleteAllHistoryResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        409: errorResponseSchema,
        422: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
    handler: historyController.deleteAllHistoryHandler,
  })
}
