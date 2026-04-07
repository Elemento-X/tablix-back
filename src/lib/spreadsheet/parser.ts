// ===========================================
// TABLIX - PARSER DE PLANILHAS (CSV/XLSX)
// ===========================================

import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import {
  ParsedSpreadsheet,
  SpreadsheetFormat,
  SpreadsheetRow,
  VALID_EXTENSIONS,
} from './types'
import { Errors } from '../../errors/app-error'

/**
 * Detecta o formato do arquivo baseado na extensão
 */
export function detectFormat(fileName: string): SpreadsheetFormat {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))

  if (ext === '.csv') return 'csv'
  if (ext === '.xlsx') return 'xlsx'
  if (ext === '.xls') return 'xls'

  throw Errors.validationError(`Formato de arquivo não suportado: ${ext}`, {
    fileName,
    validFormats: VALID_EXTENSIONS,
  })
}

/**
 * Valida a extensão do arquivo
 */
export function isValidExtension(fileName: string): boolean {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))
  return VALID_EXTENSIONS.includes(ext as (typeof VALID_EXTENSIONS)[number])
}

/**
 * Faz o parse de um arquivo CSV usando papaparse
 */
function parseCsv(buffer: Buffer, fileName: string): ParsedSpreadsheet {
  const content = buffer.toString('utf-8')

  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => header.trim(),
    transform: (value: string) => value.trim(),
  })

  if (result.errors.length > 0) {
    const firstError = result.errors[0]
    throw Errors.processingFailed(
      `Erro ao processar CSV "${fileName}": ${firstError.message}`,
    )
  }

  const headers = result.meta.fields || []
  const rows: SpreadsheetRow[] = result.data.map((row) => {
    const normalizedRow: SpreadsheetRow = {}
    for (const key of headers) {
      normalizedRow[key] = row[key] ?? null
    }
    return normalizedRow
  })

  return {
    fileName,
    format: 'csv',
    headers,
    rows,
    rowCount: rows.length,
    fileSize: buffer.length,
  }
}

/**
 * Faz o parse de um arquivo Excel (xlsx/xls) usando xlsx
 */
function parseExcel(
  buffer: Buffer,
  fileName: string,
  format: 'xlsx' | 'xls',
): ParsedSpreadsheet {
  const workbook = XLSX.read(buffer, { type: 'buffer' })

  // Pega a primeira planilha
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) {
    throw Errors.processingFailed(
      `Arquivo Excel "${fileName}" não contém planilhas`,
    )
  }

  const worksheet = workbook.Sheets[sheetName]
  if (!worksheet) {
    throw Errors.processingFailed(
      `Erro ao ler planilha "${sheetName}" de "${fileName}"`,
    )
  }

  // Converte para JSON com headers (header: 1 retorna array de arrays)
  const jsonData = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: null,
    blankrows: false,
  }) as unknown[][]

  if (jsonData.length === 0) {
    return {
      fileName,
      format,
      headers: [],
      rows: [],
      rowCount: 0,
      fileSize: buffer.length,
    }
  }

  // Primeira linha são os headers
  const rawHeaders = jsonData[0] as unknown[]
  const headers = rawHeaders.map((h, i) => {
    if (h === null || h === undefined || h === '') {
      return `Column_${i + 1}`
    }
    return String(h).trim()
  })

  // Demais linhas são os dados
  const rows: SpreadsheetRow[] = []
  for (let i = 1; i < jsonData.length; i++) {
    const rowData = jsonData[i] as unknown[]
    const row: SpreadsheetRow = {}

    for (let j = 0; j < headers.length; j++) {
      const value = rowData[j]
      if (value === null || value === undefined) {
        row[headers[j]] = null
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        row[headers[j]] = value
      } else {
        row[headers[j]] = String(value).trim()
      }
    }

    rows.push(row)
  }

  return {
    fileName,
    format,
    headers,
    rows,
    rowCount: rows.length,
    fileSize: buffer.length,
  }
}

/**
 * Faz o parse de uma planilha (detecta formato automaticamente)
 */
export function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
): ParsedSpreadsheet {
  if (!isValidExtension(fileName)) {
    throw Errors.validationError(
      `Formato de arquivo não suportado: ${fileName}`,
      {
        fileName,
        validFormats: VALID_EXTENSIONS,
      },
    )
  }

  const format = detectFormat(fileName)

  if (format === 'csv') {
    return parseCsv(buffer, fileName)
  }

  return parseExcel(buffer, fileName, format)
}

/**
 * Valida se as colunas selecionadas existem nos headers
 */
export function validateColumns(
  headers: string[],
  selectedColumns: string[],
  fileName: string,
): void {
  const headerSet = new Set(headers.map((h) => h.toLowerCase()))
  const missingColumns: string[] = []

  for (const col of selectedColumns) {
    if (!headerSet.has(col.toLowerCase())) {
      missingColumns.push(col)
    }
  }

  if (missingColumns.length > 0) {
    throw Errors.validationError(
      `Colunas não encontradas no arquivo "${fileName}": ${missingColumns.join(', ')}`,
      {
        fileName,
        missingColumns,
        availableColumns: headers,
      },
    )
  }
}

/**
 * Encontra a coluna correspondente (case-insensitive)
 */
export function findMatchingColumn(
  headers: string[],
  columnName: string,
): string | null {
  const lowerColumnName = columnName.toLowerCase()
  return headers.find((h) => h.toLowerCase() === lowerColumnName) || null
}
