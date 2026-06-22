/**
 * GET /process/status/:jobId — controller (Card 6.5, polling do LRO).
 *
 * O front faz polling deste endpoint até o job virar COMPLETED/FAILED, depois
 * baixa em GET /process/download/{jobId} (6.6). Read barato (sem custo de
 * worker/Storage).
 *
 * **Ownership (anti-IDOR/anti-enumeração):** a busca filtra por `userId` do JWT;
 * job de outro usuário OU inexistente → **404** idêntico (nunca 403). 403
 * confirmaria a EXISTÊNCIA do recurso a um não-dono (enumeração).
 *
 * @owner: @security
 * @card: 6.5
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Errors } from '../../errors/app-error'
import { prisma } from '../../lib/prisma'
import {
  processStatusParamsSchema,
  type ProcessStatusResponse,
} from '../../modules/process/process-status.schema'

export async function processStatus(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }
  const userId = request.user.userId

  // Valida o param (UUID) — defesa na borda antes de tocar o DB.
  const parsed = processStatusParamsSchema.safeParse(request.params)
  if (!parsed.success) {
    throw Errors.validationError('jobId inválido', {
      errors: parsed.error.flatten().fieldErrors,
    })
  }
  const { jobId } = parsed.data

  // Ownership embutido no WHERE: só retorna se o job for DESTE user. Não-dono
  // ou inexistente → findFirst null → 404 (anti-enumeração).
  const job = await prisma.job.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      completedAt: true,
      expiresAt: true,
      errorMessage: true,
      outputSize: true,
    },
  })
  if (!job) {
    throw Errors.jobNotFound(jobId)
  }

  const isCompleted = job.status === 'COMPLETED'
  const isFailed = job.status === 'FAILED'

  const body: ProcessStatusResponse = {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    // só FAILED — mensagem genérica (já sanitizada pelo worker).
    errorMessage: isFailed ? (job.errorMessage ?? null) : null,
    // só COMPLETED — path da rota 6.6 (stream via backend, D-4), não signed-URL.
    downloadUrl: isCompleted ? `/process/download/${job.id}` : null,
    // só COMPLETED — BigInt → string decimal (B-6.5.1).
    outputSize:
      isCompleted && job.outputSize != null ? job.outputSize.toString() : null,
  }

  // Resposta autenticada e dinâmica (polling) — nunca cacheável por CDN/cliente.
  // Vary: Authorization impede cache cross-user no edge (defense in depth sobre
  // o `private`; api-contract.md — padroniza com usage/history). @security a91c4e2f.
  reply.header('Cache-Control', 'private, no-cache')
  reply.header('Vary', 'Authorization')
  return reply.status(200).send(body)
}
