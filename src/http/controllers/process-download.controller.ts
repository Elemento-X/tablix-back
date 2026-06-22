/**
 * GET /process/download/:jobId — controller (Card 6.6, entrega única).
 *
 * Entrega o output de um job COMPLETED via backend (NÃO signed-URL — decisão
 * D-4: stream pelo backend pra logar o acesso + entrega única). O download é
 * de USO ÚNICO: o claim atômico marca `downloaded_at` e remove o output do
 * Storage pós-entrega; uma 2ª tentativa recebe 410 Gone.
 *
 * **Ordem (fetch ANTES do claim — @dba ALTO):** o buffer é baixado pra memória
 * ANTES de marcar `downloaded_at`. Se a leitura do Storage falhar (transiente
 * 5xx), `downloaded_at` continua NULL → o cliente PRO pode retentar (a entrega
 * paga não é queimada por uma falha de infra passageira). O claim atômico vem
 * logo depois, imediatamente antes da entrega.
 *
 * **Concorrência / double-download (R-5):** o claim é um UPDATE atômico
 * `WHERE id=:jobId AND user_id=:userId AND status='COMPLETED' AND
 * downloaded_at IS NULL`. Sob requests concorrentes, ambas podem baixar o
 * buffer, mas só UMA vence o claim (`count===1`) e entrega; a perdedora
 * (`count===0`) descarta o buffer e recebe 410.
 *
 * **Ownership (anti-IDOR/anti-enum):** o `userId` do JWT entra no WHERE do read
 * de discriminação E do claim. Job de outro usuário → 404 idêntico ao
 * inexistente (B-6.6.3).
 *
 * @owner: @security
 * @card: 6.6
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Errors } from '../../errors/app-error'
import { prisma } from '../../lib/prisma'
import { getStorageAdapter } from '../../lib/storage'
import {
  buildJobOutputPath,
  formatUtcDate,
} from '../../lib/storage/key-builder'
import {
  EXTENSION_TO_MIME,
  type AllowedExtension,
} from '../../lib/storage/types'
import { emitAuditEvent } from '../../lib/audit/audit.service'
import { AuditAction } from '../../lib/audit/audit.types'
import { logger } from '../../lib/logger'
import { sanitizeErrorMessage } from '../../lib/sanitize-error'
import { processDownloadParamsSchema } from '../../modules/process/process-download.schema'

export async function processDownload(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }
  const userId = request.user.userId
  const ip = request.ip
  const userAgent = request.headers['user-agent'] ?? null

  const parsed = processDownloadParamsSchema.safeParse(request.params)
  if (!parsed.success) {
    throw Errors.validationError('jobId inválido', {
      errors: parsed.error.flatten().fieldErrors,
    })
  }
  const { jobId } = parsed.data

  /** Audita uma falha de download (LGPD — registra a tentativa de acesso). */
  const auditFailure = (reason: string): void => {
    emitAuditEvent({
      action: AuditAction.PROCESS_DOWNLOAD,
      actor: userId,
      ip,
      userAgent,
      success: false,
      metadata: { jobId, reason },
    })
  }

  // 1. Read scoped por userId (ownership + discriminação ANTES do claim).
  //    null → 404 (não-dono OU inexistente, anti-enumeração); já baixado → 410;
  //    não-COMPLETED → 409. Traz também os metadados pro path/headers.
  const job = await prisma.job.findFirst({
    where: { id: jobId, userId },
    select: {
      status: true,
      downloadedAt: true,
      createdAt: true,
      outputFormat: true,
    },
  })
  if (!job) {
    throw Errors.jobNotFound(jobId)
  }
  if (job.downloadedAt) {
    throw Errors.jobAlreadyDownloaded(jobId)
  }
  if (job.status !== 'COMPLETED') {
    throw Errors.jobNotReady(jobId, job.status)
  }

  const outputFormat = job.outputFormat
  if (outputFormat !== 'csv' && outputFormat !== 'xlsx') {
    // COMPLETED sem outputFormat válido = inconsistência (não deveria ocorrer).
    logger.error(
      { jobId, userId, metric: 'download.bad_output_format' },
      '[download] job COMPLETED com outputFormat inválido',
    )
    auditFailure('bad_output_format')
    throw Errors.internal('Output do job em formato inválido')
  }
  const ext = outputFormat as AllowedExtension

  const storage = getStorageAdapter()
  if (!storage) {
    auditFailure('storage_unavailable')
    throw Errors.internal('Storage indisponível para o download')
  }

  const outputPath = buildJobOutputPath({
    userId,
    jobId,
    ext,
    now: job.createdAt,
  })

  // 2. Baixa o output pra memória ANTES do claim (@dba ALTO). Falha aqui =
  //    downloaded_at intacto (NULL) → cliente retenta sem perder a entrega.
  let buffer: Buffer
  try {
    buffer = (await storage.downloadByPath(outputPath)).buffer
  } catch (err) {
    const code = (err as { storageError?: { code?: string } }).storageError
      ?.code
    logger.error(
      {
        jobId,
        userId,
        code,
        metric: 'download.fetch_failed',
        err: sanitizeErrorMessage(err),
      },
      '[download] falha ao recuperar output do Storage (downloaded_at intacto)',
    )
    auditFailure(code === 'OBJECT_NOT_FOUND' ? 'output_gone' : 'fetch_failed')
    // Output ausente (purgado/expirado pelo cron 6.7) → 410 Gone (não volta).
    // Falha transiente → 500 (downloaded_at NULL, cliente retenta).
    if (code === 'OBJECT_NOT_FOUND') {
      throw Errors.jobAlreadyDownloaded(jobId)
    }
    throw Errors.internal('Falha ao recuperar o arquivo de output')
  }

  // 3. Claim atômico de entrega única (R-5) — só AGORA, com o buffer em mãos.
  //    count===0 = outra request concorrente venceu o claim entre o read e aqui
  //    → descarta o buffer (não entrega 2×) e responde 410.
  const claim = await prisma.job.updateMany({
    where: { id: jobId, userId, status: 'COMPLETED', downloadedAt: null },
    data: { downloadedAt: new Date() },
  })
  if (claim.count === 0) {
    throw Errors.jobAlreadyDownloaded(jobId)
  }

  // 4. Remove o output do Storage pós-entrega (entrega única, D-4). Best-effort
  //    — o buffer já está em memória; o cron 6.7 é backstop se isto falhar.
  try {
    await storage.removeByPath(outputPath)
  } catch (err) {
    logger.warn(
      { jobId, err: sanitizeErrorMessage(err) },
      '[download] cleanup do output falhou — cron 6.7 recupera',
    )
  }

  // 5. Audita o acesso ao dado (LGPD — quem baixou o quê e quando).
  emitAuditEvent({
    action: AuditAction.PROCESS_DOWNLOAD,
    actor: userId,
    ip,
    userAgent,
    success: true,
    metadata: { jobId, bytes: buffer.length },
  })

  // 6. Entrega binária. Nome gerado (sem input do usuário) + RFC 5987 (B-6.6.1).
  const filename = `tablix-unificado-${formatUtcDate(job.createdAt)}.${ext}`
  return reply
    .status(200)
    .header('Content-Type', EXTENSION_TO_MIME[ext])
    .header(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    .header('Cache-Control', 'no-store')
    .send(buffer)
}
