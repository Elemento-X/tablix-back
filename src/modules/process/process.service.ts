// ===========================================
// TABLIX - SERVIÇO DE PROCESSAMENTO
// ===========================================

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
// Card 4.2 (#68 absorvido): atomic quota enforcement. O fluxo legado
// `validateProLimits` (lê usage) → ... → `incrementUsage` (escreve) tinha
// race TOCTOU — N requests paralelas passavam o check com mesmo count.
// `validateAndIncrementUsage` faz validação E incremento em single-statement
// Postgres (INSERT...ON CONFLICT WHERE), fechando WV-2026-002.
import { validateAndIncrementUsage } from '../usage/usage.service'

interface FileData {
  buffer: Buffer
  fileName: string
}

/**
 * Validações **pré-flight** dos limites do plano Pro: file size individual,
 * tamanho total, número de arquivos. NÃO valida unificações mensais aqui —
 * essa parte foi movida pra `validateAndIncrementUsage()` atômico (Card 4.2).
 *
 * Validações cheap (sem I/O) ficam aqui propositalmente: capturam 99% das
 * falhas ANTES do increment de usage, pra reduzir desperdício de slot quando
 * o input é claramente inválido.
 */
export async function validateProLimits(
  _userId: string,
  files: FileData[],
): Promise<void> {
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
 * Processa as planilhas e retorna buffer + metadata.
 *
 * **Card 4.2 — ordem de validação refatorada:**
 *  1. Pre-flight cheap (file size, count, columns) — capturam input claramente
 *     inválido sem nenhum I/O.
 *  2. `validateAndIncrementUsage` atômico — valida quota mensal E incrementa
 *     em single-statement Postgres. Race TOCTOU fechada (WV-2026-002).
 *  3. Parse + merge + generate — operações pesadas, só rodam se quota foi
 *     reservada com sucesso.
 *
 * Trade-off documentado em `usage.service.validateAndIncrementUsage`: se o
 * processamento falhar pós-reserva, usuário "perde" 1 slot. Aceito (padrão
 * Stripe — cobrar quota na entrada > arriscar overage por race em rollback).
 *
 * `userId` aqui é o `request.user.userId` (UUID do JWT). Plan vem do mesmo
 * lugar (caller deve passar). Mantemos `'PRO'` hardcoded por compat com
 * o controller atual que ainda não propaga `request.user.role` — refator
 * separado em pipeline-discovery (não escopo do 4.2).
 */
export async function processSpreadsheets(
  userId: string,
  files: FileData[],
  input: ProcessSyncInput,
): Promise<ProcessSyncResult> {
  const { selectedColumns, outputFormat } = input

  // 1. Pré-flight cheap (sem I/O): file size, count, total
  await validateProLimits(userId, files)

  // Valida número de colunas (também cheap)
  if (selectedColumns.length > PRO_LIMITS.maxColumns) {
    throw Errors.limitExceeded(
      `${PRO_LIMITS.maxColumns} colunas`,
      `${selectedColumns.length} selecionadas`,
    )
  }

  // 2. Atomic quota check + increment (Card 4.2 — fecha WV-2026-002).
  // Plan='PRO' hardcoded — controller atualmente só chama esta função para
  // usuários PRO autenticados (FREE faz processamento client-side). Quando
  // o controller passar `request.user.role`, propagar até aqui.
  await validateAndIncrementUsage(userId, 'PRO')

  // 3. Parse + merge + generate (operações pesadas)
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
