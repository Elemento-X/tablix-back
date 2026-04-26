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
import { ProcessSyncInput, ProcessSyncResult } from './process.schema'
// Card 4.1 (#33): SSOT de leitura de usage migrou pra usage.service. Esta
// função era duplicada aqui antes — agora `getCurrentUsage` (ler) e
// `getCurrentPeriod` vivem só em um lugar. Card 4.2 vai trazer
// `validateAndIncrementUsage()` atômico (fecha waiver WV-2026-002).
import { getCurrentPeriod, getCurrentUsage } from '../usage/usage.service'

interface FileData {
  buffer: Buffer
  fileName: string
}

/**
 * Incrementa o contador de uso mensal.
 *
 * Permanece neste arquivo até o Card 4.2 substituir por
 * `validateAndIncrementUsage()` atômico no `usage.service` (fecha o
 * TOCTOU do waiver WV-2026-002).
 */
async function incrementUsage(userId: string): Promise<void> {
  const period = getCurrentPeriod()

  await prisma.usage.upsert({
    where: {
      userId_period: {
        userId,
        period,
      },
    },
    update: {
      unificationsCount: {
        increment: 1,
      },
    },
    create: {
      userId,
      period,
      unificationsCount: 1,
    },
  })
}

/**
 * Valida os limites do plano Pro antes do processamento
 */
export async function validateProLimits(
  userId: string,
  files: FileData[],
): Promise<void> {
  // Verifica limite de unificações mensais
  const currentUsage = await getCurrentUsage(userId)
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

  // Verifica tamanho por arquivo individual (D.1)
  const limitMB = (PRO_LIMITS.maxFileSize / 1024 / 1024).toFixed(0)
  for (const file of files) {
    if (file.buffer.length > PRO_LIMITS.maxFileSize) {
      const fileMB = (file.buffer.length / 1024 / 1024).toFixed(2)
      throw Errors.limitExceeded(
        `${limitMB}MB por arquivo`,
        `${file.fileName} tem ${fileMB}MB`,
      )
    }
  }

  // Verifica tamanho total
  const totalSize = files.reduce((acc, file) => acc + file.buffer.length, 0)
  if (totalSize > PRO_LIMITS.maxTotalSize) {
    const totalMB = (totalSize / 1024 / 1024).toFixed(2)
    const totalLimitMB = (PRO_LIMITS.maxTotalSize / 1024 / 1024).toFixed(0)
    throw Errors.limitExceeded(
      `${totalLimitMB}MB total`,
      `${totalMB}MB enviados`,
    )
  }
}

/**
 * Valida o limite total de linhas após o parse
 */
function validateRowLimits(spreadsheets: ParsedSpreadsheet[]): void {
  // Verifica linhas por arquivo individual (D.1)
  for (const spreadsheet of spreadsheets) {
    if (spreadsheet.rowCount > PRO_LIMITS.maxRowsPerFile) {
      throw Errors.limitExceeded(
        `${PRO_LIMITS.maxRowsPerFile.toLocaleString()} linhas por arquivo`,
        `${spreadsheet.fileName} tem ${spreadsheet.rowCount.toLocaleString()} linhas`,
      )
    }
  }

  // Verifica total de linhas no merge
  const totalRows = spreadsheets.reduce((acc, s) => acc + s.rowCount, 0)

  if (totalRows > PRO_LIMITS.maxTotalRows) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.maxTotalRows.toLocaleString()} linhas`,
      `${totalRows.toLocaleString()} linhas`,
    )
  }
}

/**
 * Processa as planilhas e retorna buffer + metadata
 */
export async function processSpreadsheets(
  userId: string,
  files: FileData[],
  input: ProcessSyncInput,
): Promise<ProcessSyncResult> {
  const { selectedColumns, outputFormat } = input

  // Valida limites antes de processar
  await validateProLimits(userId, files)

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
  await incrementUsage(userId)

  return {
    buffer: outputFile.buffer,
    fileName: outputFile.fileName,
    fileSize: outputFile.buffer.length,
    rowsCount: merged.totalRows,
    columnsCount: selectedColumns.length,
    format: outputFormat,
    mimeType: outputFile.mimeType,
  }
}
