// ===========================================
// TABLIX - PARSER DE PLANILHAS (CSV/XLSX)
// ===========================================
// Defesas ativas (Card 1.8):
//   1. Sanitização de headers contra prototype pollution
//   2. Object.create(null) em todos os row objects
//   3. Magic bytes validation antes do parse
//   4. Zip bomb detection via ZIP central directory

import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import {
  ParsedSpreadsheet,
  PRO_LIMITS,
  SpreadsheetFormat,
  SpreadsheetRow,
  VALID_EXTENSIONS,
} from './types'
import { Errors } from '../../errors/app-error'

/**
 * Nomes de propriedade perigosos que causam prototype pollution
 * quando usados como chave em objetos JS.
 * Ref: CVE-2023-30533, OWASP Prototype Pollution
 */
const DANGEROUS_HEADER_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__definegetter__',
  '__definesetter__',
  '__lookupgetter__',
  '__lookupsetter__',
  'tostring',
  'valueof',
  'hasownproperty',
  'isprototypeof',
  'propertyisenumerable',
  'tolocalestring',
])

/**
 * Magic bytes esperados por formato de arquivo.
 * XLSX = ZIP (PK header), XLS = OLE2 Compound Document.
 */
const MAGIC_BYTES = {
  xlsx: [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04
  xls: [0xd0, 0xcf, 0x11, 0xe0], // OLE2
} as const

/** Ratio maximo de descompressao permitido (100:1) */
const MAX_DECOMPRESSION_RATIO = 100

/** Tamanho maximo descompactado absoluto: 100 MB */
const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024

// -------------------------------------------------
// Camada 1: Sanitizacao de headers perigosos
// -------------------------------------------------

/**
 * Sanitiza um nome de header contra prototype pollution.
 * Headers perigosos sao prefixados com '_safe_' para
 * neutralizar o vetor sem perder dados.
 */
export function sanitizeHeaderName(header: string): string {
  if (DANGEROUS_HEADER_NAMES.has(header.toLowerCase())) {
    return `_safe_${header}`
  }
  return header
}

// -------------------------------------------------
// Camada 3: Magic bytes validation
// -------------------------------------------------

/**
 * Valida os magic bytes do buffer contra o formato declarado.
 * Rejeita arquivos cuja assinatura nao corresponde ao formato.
 */
export function validateMagicBytes(
  buffer: Buffer,
  format: 'xlsx' | 'xls',
): void {
  const expected = MAGIC_BYTES[format]
  if (buffer.length < expected.length) {
    throw Errors.validationError(
      `Arquivo muito pequeno para ser ${format.toUpperCase()} valido`,
    )
  }

  for (let i = 0; i < expected.length; i++) {
    if (buffer[i] !== expected[i]) {
      throw Errors.validationError(
        `Assinatura de arquivo invalida: esperado ${format.toUpperCase()}, conteudo nao corresponde`,
      )
    }
  }
}

// -------------------------------------------------
// Camada 4: Zip bomb detection
// -------------------------------------------------

/**
 * Le o ZIP central directory para somar os tamanhos
 * descompactados de todas as entries.
 *
 * Formato ZIP End of Central Directory Record (EOCD):
 *   Signature: 0x06054b50 (4 bytes)
 *   ...
 *   Offset of start of central directory (4 bytes at offset 16)
 *   ...
 *
 * Central Directory File Header:
 *   Signature: 0x02014b50 (4 bytes)
 *   Uncompressed size at offset 24 (4 bytes, little-endian)
 *   File name length at offset 28 (2 bytes)
 *   Extra field length at offset 30 (2 bytes)
 *   File comment length at offset 32 (2 bytes)
 *   Total header size = 46 + nameLen + extraLen + commentLen
 */
export function checkZipBombRisk(buffer: Buffer, fileName: string): void {
  // Localiza o End of Central Directory record (busca do fim)
  const eocdSignature = 0x06054b50
  let eocdOffset = -1

  // EOCD fica nos ultimos 65557 bytes (max comment = 65535 + 22 EOCD size)
  const searchStart = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i
      break
    }
  }

  if (eocdOffset === -1) {
    throw Errors.validationError(
      `Arquivo "${fileName}" nao e um ZIP/XLSX valido`,
    )
  }

  // Le offset do central directory
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16)
  const cdSignature = 0x02014b50
  let totalUncompressedSize = 0
  let pos = cdOffset

  while (pos + 46 <= buffer.length) {
    if (buffer.readUInt32LE(pos) !== cdSignature) break

    const uncompressedSize = buffer.readUInt32LE(pos + 24)

    // ZIP64: se o campo de 4 bytes e 0xFFFFFFFF, o tamanho real
    // esta no Extra Field. Para arquivos de 2MB, ZIP64 nao e necessario.
    // Rejeitar como suspeito.
    if (uncompressedSize === 0xffffffff) {
      throw Errors.validationError(
        `Arquivo "${fileName}" rejeitado: entrada ZIP64 detectada (nao esperada para arquivos deste tamanho)`,
      )
    }

    totalUncompressedSize += uncompressedSize

    const nameLen = buffer.readUInt16LE(pos + 28)
    const extraLen = buffer.readUInt16LE(pos + 30)
    const commentLen = buffer.readUInt16LE(pos + 32)
    pos += 46 + nameLen + extraLen + commentLen
  }

  // Verifica ratio de descompressao
  const ratio = buffer.length > 0 ? totalUncompressedSize / buffer.length : 0

  if (
    totalUncompressedSize > MAX_DECOMPRESSED_SIZE ||
    ratio > MAX_DECOMPRESSION_RATIO
  ) {
    throw Errors.validationError(
      `Arquivo "${fileName}" rejeitado: ratio de descompressao suspeito (${ratio.toFixed(0)}:1)`,
      {
        compressedSize: buffer.length,
        uncompressedSize: totalUncompressedSize,
        ratio: Math.round(ratio),
        maxRatio: MAX_DECOMPRESSION_RATIO,
        maxSize: MAX_DECOMPRESSED_SIZE,
      },
    )
  }
}

/**
 * Detecta o formato do arquivo baseado na extensao
 */
export function detectFormat(fileName: string): SpreadsheetFormat {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))

  if (ext === '.csv') return 'csv'
  if (ext === '.xlsx') return 'xlsx'
  if (ext === '.xls') return 'xls'

  throw Errors.validationError(`Formato de arquivo nao suportado: ${ext}`, {
    fileName,
    validFormats: VALID_EXTENSIONS,
  })
}

/**
 * Valida a extensao do arquivo
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
    transformHeader: (header: string) => sanitizeHeaderName(header.trim()),
    transform: (value: string) => value.trim(),
    // Limita linhas parseadas na origem — anti-DoS (alinhado com sheetRows no XLSX)
    preview: PRO_LIMITS.maxRowsPerFile + 1,
  })

  if (result.errors.length > 0) {
    const firstError = result.errors[0]
    throw Errors.processingFailed(
      `Erro ao processar CSV "${fileName}": ${firstError.message}`,
    )
  }

  const headers = result.meta.fields || []

  // Object.create(null) previne prototype pollution (defesa em profundidade)
  const rows: SpreadsheetRow[] = result.data.map((row) => {
    const normalizedRow: SpreadsheetRow = Object.create(null)
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
  // Camada 3: magic bytes
  validateMagicBytes(buffer, format)

  // Camada 4: zip bomb (apenas XLSX, que e ZIP)
  if (format === 'xlsx') {
    checkZipBombRisk(buffer, fileName)
  }

  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    // Limita linhas lidas na origem — anti-DoS
    sheetRows: PRO_LIMITS.maxRowsPerFile + 1,
  })

  // Pega a primeira planilha
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) {
    throw Errors.processingFailed(
      `Arquivo Excel "${fileName}" nao contem planilhas`,
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

  // Primeira linha sao os headers — sanitizados contra prototype pollution
  const rawHeaders = jsonData[0] as unknown[]
  const headers = rawHeaders.map((h, i) => {
    if (h === null || h === undefined || h === '') {
      return `Column_${i + 1}`
    }
    return sanitizeHeaderName(String(h).trim())
  })

  // Demais linhas sao os dados
  const rows: SpreadsheetRow[] = []
  for (let i = 1; i < jsonData.length; i++) {
    const rowData = jsonData[i] as unknown[]
    // Object.create(null) — sem cadeia de prototipos
    const row: SpreadsheetRow = Object.create(null)

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
      `Formato de arquivo nao suportado: ${fileName}`,
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
      `Colunas nao encontradas no arquivo "${fileName}": ${missingColumns.join(', ')}`,
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
