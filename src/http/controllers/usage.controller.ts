/**
 * Usage controller — Card 4.1 (#33).
 *
 * Handlers de GET /usage e GET /limits. Ambas as rotas exigem JWT (auth
 * middleware aplicado upstream em routes). Resolve plano server-side via
 * `request.user.role` — cliente nunca decide o plano.
 *
 * Cache headers seguem `.claude/rules/api-contract.md` § "Cache headers":
 *  - /usage é dinâmico/autenticado → `private, no-cache` (sempre revalida)
 *  - /limits é estável por plano → `private, max-age=60` (cache curto, mas
 *    `private` pra evitar cross-user em CDN; `Vary: Authorization`)
 *
 * @owner: @planner + @reviewer
 * @card: 4.1 (#33)
 */
import { FastifyRequest, FastifyReply } from 'fastify'
import { Errors } from '../../errors/app-error'
import {
  getUserUsage,
  getLimitsForPlanResponse,
} from '../../modules/usage/usage.service'

/**
 * GET /usage
 * Retorna o uso do mês corrente do usuário autenticado.
 */
export async function getUsage(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const usage = await getUserUsage(request.user.userId, request.user.role)

  reply.header('Cache-Control', 'private, no-cache')
  reply.header('Vary', 'Authorization')
  return reply.send({ data: usage })
}

/**
 * GET /limits
 * Retorna os limites do plano do usuário autenticado.
 */
export async function getLimits(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw Errors.unauthorized('Usuário não autenticado')
  }

  const data = getLimitsForPlanResponse(request.user.role)

  // Cache curto autenticado (private + max-age=60). Vary protege CDN
  // contra cross-user mesmo em rota técnicamente "estável por plano".
  reply.header('Cache-Control', 'private, max-age=60')
  reply.header('Vary', 'Authorization')
  return reply.send({ data })
}
