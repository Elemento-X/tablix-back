import { z } from 'zod'
import { errorResponseSchema } from '../../schemas/common.schema'

// ============================================
// GET /process/download/:jobId — INPUT (Card 6.6, entrega única)
// ============================================

/** Params: `jobId` (UUID v4) do job COMPLETED cujo output será baixado. */
export const processDownloadParamsSchema = z.object({
  jobId: z.string().uuid('jobId inválido (esperado UUID v4)'),
})
export type ProcessDownloadParams = z.infer<typeof processDownloadParamsSchema>

// A resposta 200 é BINÁRIA (Content-Disposition: attachment) — não há schema
// JSON de sucesso (mesmo padrão do POST /process/sync). Só os erros são
// declarados no `response` da rota.
export { errorResponseSchema }
