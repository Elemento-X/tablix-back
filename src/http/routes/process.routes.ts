import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { authMiddleware, requireRole } from '../../middleware/auth.middleware'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import * as processController from '../controllers/process.controller'
import { errorResponseSchema } from '../../modules/process/process.schema'

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
}
