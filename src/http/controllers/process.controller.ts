import { FastifyRequest, FastifyReply } from 'fastify'
import { Errors } from '../../errors/app-error'
import { processSyncInputSchema } from '../../modules/process/process.schema'
import { processSpreadsheets } from '../../modules/process/process.service'
import { isValidExtension } from '../../lib/spreadsheet'
import { parseSelectedColumnsField } from '../../lib/parse-selected-columns'
import { redis } from '../../config/redis'

interface FileData {
  buffer: Buffer
  fileName: string
}

/** Headers custom expostos ao frontend */
const TABLIX_HEADERS = {
  rows: 'X-Tablix-Rows',
  columns: 'X-Tablix-Columns',
  fileSize: 'X-Tablix-File-Size',
  format: 'X-Tablix-Format',
  fileName: 'X-Tablix-File-Name',
} as const

/** Max requests simultâneas por usuário */
const MAX_CONCURRENT_PER_USER = 2
const CONCURRENCY_KEY_PREFIX = 'tablix:concurrency:'
const CONCURRENCY_TTL_SECONDS = 120

/**
 * Adquire slot de concorrência via Redis INCR.
 * Retorna true se adquiriu, false se limite atingido.
 */
async function acquireConcurrencySlot(userId: string): Promise<boolean> {
  if (!redis) return true // sem Redis, sem guard

  const key = `${CONCURRENCY_KEY_PREFIX}${userId}`
  const current = await redis.incr(key)

  // Sempre seta TTL após INCR — garante que a key expira mesmo se
  // houve crash entre INCR e EXPIRE em request anterior
  await redis.expire(key, CONCURRENCY_TTL_SECONDS)

  if (current > MAX_CONCURRENT_PER_USER) {
    // Desfaz o increment — não adquiriu
    await redis.decr(key)
    return false
  }

  return true
}

/**
 * Libera slot de concorrência via Redis DECR.
 * Envolvido em try/catch — falha no release não deve propagar pro caller.
 */
async function releaseConcurrencySlot(
  userId: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  if (!redis) return

  try {
    const key = `${CONCURRENCY_KEY_PREFIX}${userId}`
    const val = await redis.decr(key)

    // Limpa key se zerou (evita lixo no Redis)
    if (val <= 0) {
      await redis.del(key)
    }
  } catch (err) {
    log?.warn(
      { userId, error: err instanceof Error ? err.message : String(err) },
      'concurrency slot release failed — TTL will auto-expire',
    )
  }
}

/**
 * POST /process/sync
 * Processa e unifica planilhas — retorna binary com metadata nos headers
 */
export async function processSync(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const userId = request.user.userId
  const heapBefore = process.memoryUsage().heapUsed

  // Concurrency guard
  const acquired = await acquireConcurrencySlot(userId)
  if (!acquired) {
    throw Errors.rateLimited(
      'Limite de processamento simultâneo atingido. Aguarde a conclusão da request anterior.',
    )
  }

  try {
    const files: FileData[] = []
    let selectedColumns: string[] = []
    let outputFormat = 'xlsx'
    // Card 1.16 @security finding c8a3f70e5d12: sem flag, atacante manda o
    // mesmo fieldname N vezes e cada iteração paga parse+Zod. Trava em 1 só.
    let selectedColumnsSeen = false
    let outputFormatSeen = false

    // Coleta arquivos e campos do multipart
    const parts = request.parts()

    for await (const part of parts) {
      if (part.type === 'file') {
        // Valida extensão do arquivo
        if (!isValidExtension(part.filename)) {
          throw Errors.validationError(
            `Formato de arquivo não suportado: ${part.filename}`,
            {
              validFormats: ['.csv', '.xlsx', '.xls'],
            },
          )
        }

        // Lê o buffer do arquivo
        const chunks: Buffer[] = []
        for await (const chunk of part.file) {
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)

        // Verifica se o arquivo foi truncado (excedeu o limite)
        if (part.file.truncated) {
          throw Errors.limitExceeded(
            '2MB por arquivo',
            `arquivo ${part.filename} excedeu`,
          )
        }

        files.push({ buffer, fileName: part.filename })
      } else if (part.type === 'field') {
        const value = part.value as string

        if (part.fieldname === 'selectedColumns') {
          // Defesa em profundidade (Card 1.16) — 2 camadas:
          //   Camada 1 (aqui): parseSelectedColumnsField faz cap de 8KB,
          //     JSON.parse seguro, valida shape (rejeita prototype pollution,
          //     control chars, tamanho por coluna). Falha rápido na borda.
          //   Camada 2 (abaixo): processSyncInputSchema valida a cardinalidade
          //     (PRO_LIMITS.maxColumns) depois. Mesmo input passa por 2 Zods
          //     independentes — remover qualquer um não abre vetor.
          if (selectedColumnsSeen) {
            // @security finding c8a3f70e5d12: rejeita duplicatas pra evitar
            // que atacante force N parses num único request.
            request.log.warn(
              { userId, fieldname: 'selectedColumns' },
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
            // @reviewer finding (observability): log estruturado de tentativa
            // suspeita antes de re-lançar. Pega ataques no 3am test.
            request.log.warn(
              {
                userId,
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
          // @security finding c8a3f70e5d12: rejeita fieldnames desconhecidos
          // em vez de ignorar silenciosamente. Cada um consome budget
          // (fields=10 no @fastify/multipart) — fechar silenciosamente amplia
          // a janela de abuso sem trazer valor.
          request.log.warn(
            { userId, fieldname: part.fieldname },
            'unknown multipart field rejected',
          )
          throw Errors.validationError(`Campo desconhecido: ${part.fieldname}`)
        }
      }
    }

    // Valida se há arquivos
    if (files.length === 0) {
      throw Errors.validationError('Nenhum arquivo enviado')
    }

    // Valida input com Zod (camada 2 — ver doc no handler de selectedColumns)
    const validation = processSyncInputSchema.safeParse({
      selectedColumns,
      outputFormat,
    })

    if (!validation.success) {
      throw Errors.validationError('Dados inválidos', {
        errors: validation.error.flatten().fieldErrors,
      })
    }

    // Processa as planilhas
    const result = await processSpreadsheets(userId, files, validation.data)

    // Memory logging
    const heapAfter = process.memoryUsage().heapUsed
    const heapDeltaMB = ((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)
    request.log.info(
      {
        userId,
        filesCount: files.length,
        rowsCount: result.rowsCount,
        heapBeforeMB: (heapBefore / 1024 / 1024).toFixed(2),
        heapAfterMB: (heapAfter / 1024 / 1024).toFixed(2),
        heapDeltaMB,
      },
      'process/sync heap usage',
    )

    // Envia binary com metadata nos headers
    return reply
      .status(200)
      .header('Content-Type', result.mimeType)
      .header(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`,
      )
      .header(TABLIX_HEADERS.rows, String(result.rowsCount))
      .header(TABLIX_HEADERS.columns, String(result.columnsCount))
      .header(TABLIX_HEADERS.fileSize, String(result.fileSize))
      .header(TABLIX_HEADERS.format, result.format)
      .header(TABLIX_HEADERS.fileName, result.fileName)
      .send(result.buffer)
  } finally {
    await releaseConcurrencySlot(userId, request.log)
  }
}
