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
// POST /process/sync - RESPONSE
// ============================================

export const processSyncResponseSchema = z.object({
  file: z.string().describe('Arquivo de saída codificado em base64'),
  fileName: z.string().describe('Nome do arquivo gerado'),
  fileSize: z.number().int().describe('Tamanho do arquivo em bytes'),
  rowsCount: z.number().int().describe('Total de linhas no arquivo'),
  columnsCount: z.number().int().describe('Total de colunas no arquivo'),
  format: z.enum(['xlsx', 'csv']).describe('Formato do arquivo'),
})

export type ProcessSyncResponse = z.infer<typeof processSyncResponseSchema>

// ============================================
// SHARED ERROR SCHEMAS
// ============================================

export { errorResponseSchema }
