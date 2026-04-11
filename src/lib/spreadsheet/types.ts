// ===========================================
// TABLIX - TIPOS PARA PROCESSAMENTO DE PLANILHAS
// ===========================================

/**
 * Limites do plano Pro
 */
export const PRO_LIMITS = {
  unificationsPerMonth: 40,
  maxInputFiles: 15,
  maxFileSize: 2 * 1024 * 1024, // 2 MB por arquivo (D.1: front é fonte da verdade)
  maxTotalSize: 30 * 1024 * 1024, // 30 MB total
  maxRowsPerFile: 5_000, // 5.000 linhas por arquivo (D.1)
  maxTotalRows: 75_000, // 75.000 linhas totais no merge
  maxColumns: 10, // 10 colunas selecionáveis (D.1)
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
