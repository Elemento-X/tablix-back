import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { authMiddleware, requireRole } from '../../middleware/auth.middleware'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import * as processController from '../controllers/process.controller'
import { processAsync } from '../controllers/process-async.controller'
import { processStatus } from '../controllers/process-status.controller'
import { processDownload } from '../controllers/process-download.controller'
import { errorResponseSchema } from '../../modules/process/process.schema'
import { processAsyncResponseSchema } from '../../modules/process/process-async.schema'
import {
  processStatusParamsSchema,
  processStatusResponseSchema,
} from '../../modules/process/process-status.schema'
import { processDownloadParamsSchema } from '../../modules/process/process-download.schema'
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

    // GET /process/status/:jobId — polling do LRO (Card 6.5). Mesmo dark launch
    // do POST /async. Ownership por userId do JWT → 404 (anti-enumeração) se
    // o job não for do usuário ou não existir.
    server.get('/status/:jobId', {
      preHandler: [
        rateLimitMiddleware.processStatus,
        authMiddleware,
        requireRole('PRO'),
      ],
      schema: {
        tags: ['Process'],
        summary: 'Status de um job assíncrono (polling do LRO)',
        description: `
Retorna o estado de um job criado em \`POST /process/async\`. Faça polling até
\`status\` ser \`COMPLETED\` ou \`FAILED\`.

- **COMPLETED:** \`downloadUrl\` (\`GET /process/download/{jobId}\`) e \`outputSize\`
  (string, bytes) ficam preenchidos. O download é de entrega única.
- **FAILED:** \`errorMessage\` (genérico) fica preenchido.
- Campos condicionais vêm \`null\` quando não-aplicáveis (shape estável).

Job de outro usuário ou inexistente → **404** (não 403, anti-enumeração).
        `,
        security: [{ bearerAuth: [] }],
        params: processStatusParamsSchema,
        response: {
          200: processStatusResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
      handler: processStatus,
    })

    // GET /process/download/:jobId — entrega única do output (Card 6.6). Mesmo
    // dark launch. Stream via backend (D-4): claim atômico downloaded_at +
    // remove output pós-entrega + audita. Ownership por userId → 404 anti-enum;
    // já baixado → 410 Gone; não concluído → 409.
    server.get('/download/:jobId', {
      preHandler: [
        rateLimitMiddleware.process,
        authMiddleware,
        requireRole('PRO'),
      ],
      schema: {
        tags: ['Process'],
        summary: 'Baixar o output de um job assíncrono (entrega única)',
        description: `
Entrega o arquivo unificado de um job \`COMPLETED\`, via backend (não signed-URL).

**Entrega única:** o output é removido após o download. Uma 2ª chamada retorna
**410 Gone**. Job não concluído → **409**; de outro usuário/inexistente → **404**.
        `,
        security: [{ bearerAuth: [] }],
        produces: [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/csv',
        ],
        params: processDownloadParamsSchema,
        response: {
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          410: errorResponseSchema,
          429: errorResponseSchema,
          // 500: storage indisponível / output em formato inconsistente /
          // falha transiente ao recuperar o output (downloaded_at intacto →
          // cliente PRO pode retentar). Declarado pro contrato/Swagger refletir
          // os 3 ramos de internal() do controller.
          500: errorResponseSchema,
        },
      },
      handler: processDownload,
    })
  }
}
