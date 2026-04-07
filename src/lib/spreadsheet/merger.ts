// ===========================================
// TABLIX - MERGE DE PLANILHAS
// ===========================================

import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import {
  ParsedSpreadsheet,
  MergedResult,
  OutputFile,
  OutputFormat,
  SpreadsheetRow,
  MIME_TYPES,
} from './types'
import { findMatchingColumn } from './parser'

/**
 * Combina múltiplas planilhas usando as colunas selecionadas
 */
export function mergeSpreadsheets(
  spreadsheets: ParsedSpreadsheet[],
  selectedColumns: string[],
): MergedResult {
  const mergedRows: SpreadsheetRow[] = []

  for (const spreadsheet of spreadsheets) {
    // Mapeia as colunas selecionadas para as colunas reais do arquivo
    const columnMapping: Map<string, string> = new Map()

    for (const selectedCol of selectedColumns) {
      const matchingCol = findMatchingColumn(spreadsheet.headers, selectedCol)
      if (matchingCol) {
        columnMapping.set(selectedCol, matchingCol)
      }
    }

    // Extrai os dados de cada linha
    for (const row of spreadsheet.rows) {
      const mergedRow: SpreadsheetRow = {}

      for (const selectedCol of selectedColumns) {
        const actualCol = columnMapping.get(selectedCol)
        if (actualCol) {
          mergedRow[selectedCol] = row[actualCol] ?? null
        } else {
          mergedRow[selectedCol] = null
        }
      }

      mergedRows.push(mergedRow)
    }
  }

  return {
    headers: selectedColumns,
    rows: mergedRows,
    totalRows: mergedRows.length,
    sourcesCount: spreadsheets.length,
  }
}

/**
 * Gera arquivo de saída no formato especificado
 */
export function generateOutputFile(
  merged: MergedResult,
  format: OutputFormat,
): OutputFile {
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10) // YYYY-MM-DD
  const fileName = `unified-${dateStr}.${format}`

  if (format === 'csv') {
    return generateCsvOutput(merged, fileName)
  }

  return generateXlsxOutput(merged, fileName)
}

/**
 * Gera arquivo CSV
 */
function generateCsvOutput(merged: MergedResult, fileName: string): OutputFile {
  // Converte os dados para o formato esperado pelo papaparse
  const data = merged.rows.map((row) => {
    const csvRow: Record<string, string> = {}
    for (const header of merged.headers) {
      const value = row[header]
      if (value === null || value === undefined) {
        csvRow[header] = ''
      } else {
        csvRow[header] = String(value)
      }
    }
    return csvRow
  })

  const csv = Papa.unparse(data, {
    columns: merged.headers,
    header: true,
  })

  const buffer = Buffer.from(csv, 'utf-8')

  return {
    buffer,
    fileName,
    format: 'csv',
    mimeType: MIME_TYPES.csv,
  }
}

/**
 * Gera arquivo XLSX
 */
function generateXlsxOutput(
  merged: MergedResult,
  fileName: string,
): OutputFile {
  // Cria array de arrays com headers + dados
  const data: (string | number | boolean | null)[][] = []

  // Headers
  data.push(merged.headers)

  // Dados
  for (const row of merged.rows) {
    const rowData: (string | number | boolean | null)[] = []
    for (const header of merged.headers) {
      rowData.push(row[header] ?? null)
    }
    data.push(rowData)
  }

  // Cria workbook e worksheet
  const worksheet = XLSX.utils.aoa_to_sheet(data)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Unified')

  // Ajusta largura das colunas
  const colWidths = merged.headers.map((header) => {
    let maxWidth = header.length

    for (const row of merged.rows) {
      const value = row[header]
      if (value !== null && value !== undefined) {
        const valueLength = String(value).length
        if (valueLength > maxWidth) {
          maxWidth = valueLength
        }
      }
    }

    return { wch: Math.min(maxWidth + 2, 50) } // Max 50 chars
  })
  worksheet['!cols'] = colWidths

  // Gera buffer
  const buffer = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer

  return {
    buffer,
    fileName,
    format: 'xlsx',
    mimeType: MIME_TYPES.xlsx,
  }
}
