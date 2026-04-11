import { FastifyRequest, FastifyReply } from 'fastify'
import { Errors } from '../../errors/app-error'
import { processSyncInputSchema } from '../../modules/process/process.schema'
import { processSpreadsheets } from '../../modules/process/process.service'
import { isValidExtension } from '../../lib/spreadsheet'

interface FileData {
  buffer: Buffer
  fileName: string
}

/**
 * POST /process/sync
 * Processa e unifica planilhas de forma síncrona
 */
export async function processSync(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const userId = request.user.userId
  const files: FileData[] = []
  let selectedColumns: string[] = []
  let outputFormat = 'xlsx'

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
          '30MB por upload',
          `arquivo ${part.filename} excedeu`,
        )
      }

      files.push({
        buffer,
        fileName: part.filename,
      })
    } else if (part.type === 'field') {
      // Processa campos do formulário
      const value = part.value as string

      if (part.fieldname === 'selectedColumns') {
        // Aceita como JSON array ou como campo repetido
        try {
          selectedColumns = JSON.parse(value)
        } catch {
          // Se não for JSON, adiciona como item único
          selectedColumns.push(value)
        }
      } else if (part.fieldname === 'outputFormat') {
        outputFormat = value
      }
    }
  }

  // Valida se há arquivos
  if (files.length === 0) {
    throw Errors.validationError('Nenhum arquivo enviado')
  }

  // Valida input com Zod
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

  return reply.send(result)
}
