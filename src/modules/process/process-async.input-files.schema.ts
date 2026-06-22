/**
 * Schema de READ-BACK do `Job.inputFiles` (Card 6.4 — worker).
 *
 * O 6.3 ESCREVE este shape no `Job.inputFiles` (Json) com um cast. O worker
 * (6.4) LÊ de volta do banco e NÃO confia no cast — valida via Zod antes de
 * reconstruir paths e parsear. Um shape inesperado (DB corrompido, migration
 * futura malfeita, write divergente) é tratado como erro PERMANENTE (não
 * adianta retentar). Defense in depth no consumidor.
 *
 * SSOT do enum de extensão: `ALLOWED_EXTENSIONS` do storage (csv/xlsx/xls).
 *
 * @owner: @reviewer + @security
 * @card: 6.4
 */
import { z } from 'zod'
import { ALLOWED_EXTENSIONS } from '../../lib/storage/types'
import { MAX_JOB_INPUT_INDEX } from '../../lib/storage/key-builder'

/** Metadado de um input persistido pelo 6.3 (NÃO guarda bytes, só metadados). */
export const jobInputFileMetaSchema = z.object({
  // `.max(MAX_JOB_INPUT_INDEX)` (@security 2f8d4c): índice fora de range faria
  // buildJobInputPath lançar Error genérico (→ transiente, retry inútil); aqui
  // vira erro de validação permanente, alinhado ao teto do key-builder.
  index: z.number().int().min(0).max(MAX_JOB_INPUT_INDEX),
  fileName: z.string(),
  ext: z.enum(ALLOWED_EXTENSIONS),
  size: z.number().int().nonnegative(),
})

/** Shape completo do `Job.inputFiles`. */
export const jobInputFilesSchema = z.object({
  files: z.array(jobInputFileMetaSchema).min(1),
  selectedColumns: z.array(z.string()).min(1),
})

export type JobInputFileMeta = z.infer<typeof jobInputFileMetaSchema>
export type JobInputFiles = z.infer<typeof jobInputFilesSchema>
