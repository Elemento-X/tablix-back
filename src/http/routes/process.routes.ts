import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { authMiddleware, requireRole } from '../../middleware/auth.middleware'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import * as processController from '../controllers/process.controller'
import {
  processSyncResponseSchema,
  errorResponseSchema,
} from '../../modules/process/process.schema'

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

**Limites do Plano Pro:**
- 40 unificações por mês
- Até 15 arquivos por unificação
- Tamanho total máximo: 30MB
- Até 75.000 linhas totais
- Até 15 colunas selecionadas

**Formato da requisição:**
- Content-Type: multipart/form-data
- Campos:
  - files: Arquivos CSV/XLSX/XLS (pode ser múltiplos)
  - selectedColumns: JSON array com nomes das colunas a extrair
  - outputFormat: "xlsx" ou "csv" (padrão: xlsx)

**Exemplo de uso com curl:**
\`\`\`bash
curl -X POST /process/sync \\
  -H "Authorization: Bearer <jwt>" \\
  -F "files=@planilha1.csv" \\
  -F "files=@planilha2.xlsx" \\
  -F 'selectedColumns=["nome","email","telefone"]' \\
  -F "outputFormat=xlsx"
\`\`\`
      `,
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      response: {
        200: processSyncResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: processController.processSync,
  })
}
