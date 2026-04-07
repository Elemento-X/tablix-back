// ===========================================
// TABLIX - SERVIÇO DE PROCESSAMENTO
// ===========================================

import { prisma } from '../../lib/prisma'
import { Errors } from '../../errors/app-error'
import {
  parseSpreadsheet,
  validateColumns,
  mergeSpreadsheets,
  generateOutputFile,
  PRO_LIMITS,
  ParsedSpreadsheet,
  OutputFormat,
} from '../../lib/spreadsheet'
import { ProcessSyncInput, ProcessSyncResponse } from './process.schema'

interface FileData {
  buffer: Buffer
  fileName: string
}

/**
 * Retorna o período atual no formato YYYY-MM
 */
function getCurrentPeriod(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

/**
 * Busca o uso atual do mês para o token
 */
async function getCurrentUsage(tokenId: string): Promise<number> {
  const period = getCurrentPeriod()

  const usage = await prisma.usage.findUnique({
    where: {
      tokenId_period: {
        tokenId,
        period,
      },
    },
  })

  return usage?.unificationsCount ?? 0
}

/**
 * Incrementa o contador de uso mensal
 */
async function incrementUsage(tokenId: string): Promise<void> {
  const period = getCurrentPeriod()

  await prisma.usage.upsert({
    where: {
      tokenId_period: {
        tokenId,
        period,
      },
    },
    update: {
      unificationsCount: {
        increment: 1,
      },
    },
    create: {
      tokenId,
      period,
      unificationsCount: 1,
    },
  })
}

/**
 * Valida os limites do plano Pro antes do processamento
 */
export async function validateProLimits(
  tokenId: string,
  files: FileData[],
): Promise<void> {
  // Verifica limite de unificações mensais
  const currentUsage = await getCurrentUsage(tokenId)
  if (currentUsage >= PRO_LIMITS.unificationsPerMonth) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.unificationsPerMonth} unificações/mês`,
      `${currentUsage} utilizadas`,
    )
  }

  // Verifica limite de arquivos por unificação
  if (files.length > PRO_LIMITS.maxInputFiles) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.maxInputFiles} arquivos`,
      `${files.length} enviados`,
    )
  }

  // Verifica tamanho total
  const totalSize = files.reduce((acc, file) => acc + file.buffer.length, 0)
  if (totalSize > PRO_LIMITS.maxTotalSize) {
    const totalMB = (totalSize / 1024 / 1024).toFixed(2)
    const limitMB = (PRO_LIMITS.maxTotalSize / 1024 / 1024).toFixed(0)
    throw Errors.limitExceeded(`${limitMB}MB total`, `${totalMB}MB enviados`)
  }
}

/**
 * Valida o limite total de linhas após o parse
 */
function validateRowLimits(spreadsheets: ParsedSpreadsheet[]): void {
  const totalRows = spreadsheets.reduce((acc, s) => acc + s.rowCount, 0)

  if (totalRows > PRO_LIMITS.maxTotalRows) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.maxTotalRows.toLocaleString()} linhas`,
      `${totalRows.toLocaleString()} linhas`,
    )
  }
}

/**
 * Processa as planilhas e retorna o arquivo unificado
 */
export async function processSpreadsheets(
  tokenId: string,
  files: FileData[],
  input: ProcessSyncInput,
): Promise<ProcessSyncResponse> {
  const { selectedColumns, outputFormat } = input

  // Valida limites antes de processar
  await validateProLimits(tokenId, files)

  // Valida número de colunas
  if (selectedColumns.length > PRO_LIMITS.maxColumns) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.maxColumns} colunas`,
      `${selectedColumns.length} selecionadas`,
    )
  }

  // Parse de cada arquivo
  const parsedSpreadsheets: ParsedSpreadsheet[] = []

  for (const file of files) {
    const parsed = parseSpreadsheet(file.buffer, file.fileName)

    // Valida se as colunas existem no arquivo
    validateColumns(parsed.headers, selectedColumns, file.fileName)

    parsedSpreadsheets.push(parsed)
  }

  // Valida limite total de linhas
  validateRowLimits(parsedSpreadsheets)

  // Merge das planilhas
  const merged = mergeSpreadsheets(parsedSpreadsheets, selectedColumns)

  // Gera arquivo de saída
  const outputFile = generateOutputFile(merged, outputFormat as OutputFormat)

  // Incrementa contador de uso
  await incrementUsage(tokenId)

  // Retorna resposta
  return {
    file: outputFile.buffer.toString('base64'),
    fileName: outputFile.fileName,
    fileSize: outputFile.buffer.length,
    rowsCount: merged.totalRows,
    columnsCount: selectedColumns.length,
    format: outputFormat,
  }
}
