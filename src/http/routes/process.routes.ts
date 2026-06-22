import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { authMiddleware, requireRole } from '../../middleware/auth.middleware'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import * as processController from '../controllers/process.controller'
import { processAsync } from '../controllers/process-async.controller'
import { errorResponseSchema } from '../../modules/process/process.schema'
import { processAsyncResponseSchema } from '../../modules/process/process-async.schema'
import { env } from '../../config/env'

export async function processRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // POST /process/sync - Processa e unifica planilhas
  server.post('/sync', {
    preHandler: [
      rateLimitMiddleware.process,
      authMiddleware,
      requireRole('PRO'),
    ],
    schema: {
      tags: ['Process'],
      summary: 'Unificar planilhas',
      description: `
Processa e unifica múltiplas planilhas CSV/Excel em um único arquivo.

**Resposta:** arquivo binário (XLSX ou CSV) com metadata nos headers.

**Headers de resposta:**
- Content-Disposition: attachment; filename="unified-YYYY-MM-DD.xlsx"
- X-Tablix-Rows: total de linhas
- X-Tablix-Columns: total de colunas
- X-Tablix-File-Size: tamanho em bytes
- X-Tablix-Format: xlsx ou csv
- X-Tablix-File-Name: nome do arquivo

**Limites do Plano Pro:**
- 40 unificações por mês
- Até 15 arquivos por unificação
- Até 2MB por arquivo
- Até 75.000 linhas totais
- Até 10 colunas selecionadas

**Exemplo de uso com curl:**
\`\`\`bash
curl -X POST /process/sync \\
  -H "Authorization: Bearer <jwt>" \\
  -F "files=@planilha1.csv" \\
  -F "files=@planilha2.xlsx" \\
  -F 'selectedColumns=["nome","email","telefone"]' \\
  -F "outputFormat=xlsx" \\
  --output resultado.xlsx
\`\`\`
      `,
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      produces: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv',
      ],
      response: {
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: processController.processSync,
  })

  // POST /process/async — caminho ASSÍNCRONO (LRO) pra arquivos grandes que
  // estourariam o requestTimeout do sync. Dark launch: a rota só é registrada
  // quando ASYNC_PROCESSING_ENABLED=true — com a flag off, a feature nem
  // existe publicamente (404). Cria Job, sobe inputs no Storage, enfileira no
  // BullMQ e retorna 202 + Location pro polling em GET /process/status/:jobId.
  if (env.ASYNC_PROCESSING_ENABLED) {
    server.post('/async', {
      preHandler: [
        // Ordem: cap global (denial-of-wallet) → per-IP → auth → role.
        rateLimitMiddleware.processAsyncGlobalCap,
        rateLimitMiddleware.processAsync,
        authMiddleware,
        requireRole('PRO'),
      ],
      schema: {
        tags: ['Process'],
        summary: 'Unificar planilhas (assíncrono / LRO)',
        description: `
Processa planilhas grandes de forma assíncrona (Long-Running Operation).

**Header obrigatório:** \`Idempotency-Key: <string única, máx 255>\` — ausência
retorna **428**. Reenvio com a mesma key (retry de rede) NÃO cria 2 jobs.

**Resposta:** \`202 Accepted\` + header \`Location: /process/status/{jobId}\`.
Faça polling em \`GET /process/status/{jobId}\` até \`COMPLETED\`/\`FAILED\`,
depois baixe em \`GET /process/download/{jobId}\` (entrega única).

**Limites do Plano Pro (async):**
- Até 15 arquivos por unificação
- Até 30MB por arquivo (vs 2MB no /sync)
- Até 30MB no total
- Até 75.000 linhas totais (validado no worker)
        `,
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        response: {
          202: processAsyncResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          // 409: outra request com a mesma Idempotency-Key ainda em andamento
          // (IDEMPOTENCY_IN_PROGRESS) — cliente faz poll/retry com Retry-After.
          409: errorResponseSchema,
          422: errorResponseSchema,
          428: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      handler: processAsync,
    })
  }
}
