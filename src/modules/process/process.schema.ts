import { z } from 'zod'
import { errorResponseSchema } from '../../schemas/common.schema'
import { PRO_LIMITS } from '../../lib/spreadsheet'

// ============================================
// POST /process/sync - INPUT
// ============================================

export const processSyncInputSchema = z.object({
  selectedColumns: z
    .array(z.string().min(1, 'Nome da coluna não pode ser vazio'))
    .min(1, 'Selecione pelo menos 1 coluna')
    .max(PRO_LIMITS.maxColumns, `Máximo de ${PRO_LIMITS.maxColumns} colunas`)
    .describe('Colunas a serem extraídas e unificadas'),
  outputFormat: z
    .enum(['xlsx', 'csv'])
    .default('xlsx')
    .describe('Formato do arquivo de saída'),
})

export type ProcessSyncInput = z.infer<typeof processSyncInputSchema>

// ============================================
// POST /process/sync - RESPONSE (binary)
// ============================================

// Response é binário (Buffer) com metadata nos headers:
//   Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
//   Content-Disposition: attachment; filename="unified-2026-04-11.xlsx"
//   X-Tablix-Rows: 150
//   X-Tablix-Columns: 5
//   X-Tablix-File-Size: 12345
//   X-Tablix-Format: xlsx
//   X-Tablix-File-Name: unified-2026-04-11.xlsx

// Schema pro Swagger (indica resposta binária)
export const processSyncResponseSchema = z
  .string()
  .describe(
    'Arquivo binário. Metadata nos headers X-Tablix-Rows, X-Tablix-Columns, X-Tablix-File-Size, X-Tablix-Format, X-Tablix-File-Name.',
  )

/** Metadata retornada pelo service junto com o buffer */
export interface ProcessSyncResult {
  buffer: Buffer
  fileName: string
  fileSize: number
  rowsCount: number
  columnsCount: number
  format: string
  mimeType: string
}

// ============================================
// SHARED ERROR SCHEMAS
// ============================================

export { errorResponseSchema }
