// ===========================================
// TABLIX - TIPOS PARA PROCESSAMENTO DE PLANILHAS
// ===========================================

import { PRO_LIMITS as PLAN_PRO_LIMITS } from '../../config/plan-limits'

/**
 * Limites do plano Pro aplicados ao processamento de planilhas.
 *
 * Fonte única da verdade: `src/config/plan-limits.ts`. Este objeto só
 * re-exporta os campos do PRO na forma esperada pelo pipeline de spreadsheet
 * (com `maxRowsPerFile` como alias de `maxRows` pra clareza local).
 *
 * D.1: 30 unificações/mês no plano PRO.
 */
export const PRO_LIMITS = {
  unificationsPerMonth: PLAN_PRO_LIMITS.unificationsPerMonth,
  maxInputFiles: PLAN_PRO_LIMITS.maxInputFiles,
  maxFileSize: PLAN_PRO_LIMITS.maxFileSize,
  maxTotalSize: PLAN_PRO_LIMITS.maxTotalSize,
  maxRowsPerFile: PLAN_PRO_LIMITS.maxRows,
  maxTotalRows: PLAN_PRO_LIMITS.maxTotalRows,
  maxColumns: PLAN_PRO_LIMITS.maxColumns,
} as const

/**
 * Formatos de arquivo suportados
 */
export type SpreadsheetFormat = 'csv' | 'xlsx' | 'xls'

/**
 * Formatos de saída suportados
 */
export type OutputFormat = 'csv' | 'xlsx'

/**
 * Uma linha de dados da planilha
 */
export type SpreadsheetRow = Record<string, string | number | boolean | null>

/**
 * Resultado do parse de uma planilha
 */
export interface ParsedSpreadsheet {
  fileName: string
  format: SpreadsheetFormat
  headers: string[]
  rows: SpreadsheetRow[]
  rowCount: number
  fileSize: number
}

/**
 * Resultado do merge de múltiplas planilhas
 */
export interface MergedResult {
  headers: string[]
  rows: SpreadsheetRow[]
  totalRows: number
  sourcesCount: number
}

/**
 * Arquivo de saída gerado
 */
export interface OutputFile {
  buffer: Buffer
  fileName: string
  format: OutputFormat
  mimeType: string
}

/**
 * Erro de processamento com detalhes
 */
export interface ProcessingError {
  code: string
  message: string
  fileName?: string
  details?: Record<string, unknown>
}

/**
 * Opções de processamento
 */
export interface ProcessOptions {
  selectedColumns: string[]
  outputFormat: OutputFormat
}

/**
 * MIME types para os formatos de arquivo
 */
export const MIME_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
} as const

/**
 * Extensões de arquivo válidas
 */
export const VALID_EXTENSIONS = ['.csv', '.xlsx', '.xls'] as const
