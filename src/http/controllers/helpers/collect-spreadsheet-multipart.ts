/**
 * Coletor de multipart de planilhas (Card 6.3).
 *
 * Extrai a leitura do `multipart/form-data` (arquivos + selectedColumns +
 * outputFormat) com TODAS as defesas anti-abuso do Card 1.16 (@security):
 *  - rejeita field duplicado (atacante força N parses num request)
 *  - rejeita fieldname desconhecido (cada um consome budget de fields)
 *  - valida extensão na borda
 *  - detecta truncamento (excedeu o fileSize do multipart) → limitExceeded
 *
 * **Por que helper:** o `/process/sync` tem essa mesma lógica inline. O async
 * (6.3) precisa dela com um limite de tamanho diferente (30MB vs 2MB). Em vez
 * de duplicar a lógica de SEGURANÇA (risco de drift), centralizo aqui. O sync
 * ainda não foi migrado pra este helper (regra: não refatorar fora do escopo
 * do card) — migração rastreada como card de descoberta. Até lá, este é o
 * ponto canônico e o sync é o legado a convergir.
 *
 * A validação Zod de `{ selectedColumns, outputFormat }` (cardinalidade,
 * formato) é responsabilidade do CALLER — este helper só coleta e aplica os
 * guards estruturais/anti-abuso.
 *
 * @owner: @security
 * @card: 6.3
 */
import type { FastifyRequest } from 'fastify'
import { Errors } from '../../../errors/app-error'
import { isValidExtension } from '../../../lib/spreadsheet'
import { parseSelectedColumnsField } from '../../../lib/parse-selected-columns'

export interface CollectedMultipart {
  files: { buffer: Buffer; fileName: string }[]
  /** Raw — o caller valida via Zod (cardinalidade/colunas). */
  selectedColumns: string[]
  /** Raw — o caller valida via Zod (enum xlsx/csv). */
  outputFormat: string
}

export interface CollectMultipartOptions {
  /** Limite de bytes por arquivo (override do global do @fastify/multipart). */
  fileSizeLimitBytes: number
  /**
   * Teto CUMULATIVO de bytes somando todos os arquivos do request. Checado
   * incrementalmente A CADA arquivo coletado (não só no fim) — sem ele, N
   * arquivos no limite individual bufferizariam `N × fileSizeLimitBytes` em
   * RAM antes de qualquer reject (vetor de OOM/DoS multi-tenant — @security
   * F-1). Com o check incremental, o pico fica limitado a ~`maxTotalBytes` +
   * um arquivo em voo.
   */
  maxTotalBytes: number
  /** Máximo de arquivos por request. */
  maxFiles: number
  /** Label legível pro erro de truncamento (ex: "30MB por arquivo"). */
  fileSizeLabel: string
  /** Label legível pro erro de teto total (ex: "30MB no total"). */
  totalSizeLabel: string
  /** userId pra logs estruturados de tentativa suspeita. */
  userId: string
}

/**
 * Comprimento máximo do `fileName` persistido. Nome é dado não-confiável do
 * cliente — capamos pra evitar abuso de storage de metadados e estouro de
 * header em consumidores downstream (Content-Disposition no 6.6).
 */
const MAX_FILE_NAME_LENGTH = 255

/**
 * Sanitiza o `fileName` antes de persistir (@security F-3, defense in depth).
 * O nome NÃO é usado pra montar path de storage (o path usa userId/jobId/index
 * via key-builder), então não há path traversal aqui — mas é dado hostil que
 * será relido por consumidores downstream (nome de output 6.4, header
 * Content-Disposition no download 6.6, exibição no status/history). Remove
 * control chars (CR/LF/TAB/NUL/DEL → header injection / log injection) e capa
 * o comprimento. NÃO normaliza o restante (preserva o nome legível do usuário).
 */
function sanitizeFileName(fileName: string): string {
  // 1. Remove control chars (sem cap ainda — o cap preserva a extensão).
  let clean = ''
  for (let i = 0; i < fileName.length; i++) {
    const code = fileName.charCodeAt(i)
    // U+0000–U+001F (control) e U+007F (DEL) → descartados.
    if (code <= 0x1f || code === 0x7f) continue
    clean += fileName[i]
  }
  if (clean.length <= MAX_FILE_NAME_LENGTH) return clean

  // 2. Cap preservando a extensão (@security 9f2c4a7b1e30): truncar o tail cru
  //    poderia transformar `.xlsx` em `.xls` — extensão DIFERENTE mas ainda
  //    válida, divergindo do conteúdo. Capamos o STEM e mantemos a ext intacta
  //    pro nome armazenado casar com a ext validada na borda (isValidExtension).
  const dot = clean.lastIndexOf('.')
  if (dot > 0 && clean.length - dot <= 12) {
    const ext = clean.slice(dot)
    const stem = clean.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - ext.length))
    return stem + ext
  }
  return clean.slice(0, MAX_FILE_NAME_LENGTH)
}

/**
 * Coleta os arquivos e campos do multipart aplicando os guards de segurança.
 * NÃO valida cardinalidade de colunas nem enum de formato — isso é Zod no caller.
 *
 * @throws {AppError} validationError (formato/duplicata/desconhecido),
 *   limitExceeded (arquivo truncado).
 */
export async function collectSpreadsheetMultipart(
  request: FastifyRequest,
  opts: CollectMultipartOptions,
): Promise<CollectedMultipart> {
  const files: { buffer: Buffer; fileName: string }[] = []
  let selectedColumns: string[] = []
  let outputFormat = 'xlsx'
  let selectedColumnsSeen = false
  let outputFormatSeen = false
  // Acumulador do teto cumulativo (@security F-1): checado a cada arquivo pra
  // limitar o pico de memória, não só o tamanho individual.
  let totalBytes = 0

  // Override de limites por-request (o global é 2MB; async eleva pra 30MB).
  const parts = request.parts({
    limits: {
      fileSize: opts.fileSizeLimitBytes,
      files: opts.maxFiles,
    },
  })

  for await (const part of parts) {
    if (part.type === 'file') {
      if (!isValidExtension(part.filename)) {
        throw Errors.validationError(
          `Formato de arquivo não suportado: ${part.filename}`,
          { validFormats: ['.csv', '.xlsx', '.xls'] },
        )
      }

      const chunks: Buffer[] = []
      for await (const chunk of part.file) {
        chunks.push(chunk)
      }
      const buffer = Buffer.concat(chunks)

      if (part.file.truncated) {
        throw Errors.limitExceeded(
          opts.fileSizeLabel,
          `arquivo ${part.filename} excedeu`,
        )
      }

      // Teto CUMULATIVO incremental (@security F-1): rejeita assim que a soma
      // ultrapassa o total, limitando o pico de RAM a ~maxTotalBytes + 1
      // arquivo em voo (vs N×fileSizeLimitBytes se só checado no fim).
      totalBytes += buffer.length
      if (totalBytes > opts.maxTotalBytes) {
        request.log.warn(
          {
            userId: opts.userId,
            totalBytes,
            maxTotalBytes: opts.maxTotalBytes,
          },
          'cumulative multipart size exceeded',
        )
        throw Errors.limitExceeded(opts.totalSizeLabel, `${totalBytes} bytes`)
      }

      files.push({ buffer, fileName: sanitizeFileName(part.filename) })
    } else if (part.type === 'field') {
      const value = part.value as string

      if (part.fieldname === 'selectedColumns') {
        if (selectedColumnsSeen) {
          request.log.warn(
            { userId: opts.userId, fieldname: 'selectedColumns' },
            'duplicate multipart field rejected',
          )
          throw Errors.validationError(
            'Campo selectedColumns enviado mais de uma vez',
          )
        }
        selectedColumnsSeen = true
        try {
          selectedColumns = parseSelectedColumnsField(value)
        } catch (err) {
          request.log.warn(
            {
              userId: opts.userId,
              fieldname: 'selectedColumns',
              valueLength: value.length,
              error: err instanceof Error ? err.message : String(err),
            },
            'selectedColumns parse rejected',
          )
          throw err
        }
      } else if (part.fieldname === 'outputFormat') {
        if (outputFormatSeen) {
          throw Errors.validationError(
            'Campo outputFormat enviado mais de uma vez',
          )
        }
        outputFormatSeen = true
        outputFormat = value
      } else {
        request.log.warn(
          { userId: opts.userId, fieldname: part.fieldname },
          'unknown multipart field rejected',
        )
        throw Errors.validationError(`Campo desconhecido: ${part.fieldname}`)
      }
    }
  }

  return { files, selectedColumns, outputFormat }
}
