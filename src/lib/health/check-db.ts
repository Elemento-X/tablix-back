/**
 * Card 2.3 — Health check do banco (Prisma + Supabase Postgres).
 *
 * `SELECT 1` é o ping idempotente canônico: sem locks, sem I/O de tabela,
 * usa apenas a conexão e o parser. Roda contra o pooler (DATABASE_URL com
 * pgbouncer) — testa o caminho completo que a aplicação usa em runtime,
 * não apenas o DIRECT_URL.
 *
 * **Limitação conhecida** (documentada como contrato):
 * Prisma 5 não respeita AbortSignal em `$queryRaw` — o `Promise.race` com
 * setTimeout só faz a *promessa* JS resolver, mas a query continua
 * executando do lado do banco até finalizar ou o pooler matar a conexão.
 * Mitigação real é o `connection_limit` do Prisma + pool do Supabase, não
 * este timeout. O timeout daqui serve para que o probe responda rápido
 * ao orquestrador, não para abortar a query travada.
 *
 * @owner: @dba
 */
import { prisma } from '../prisma'
import type { CheckResult } from './types'
import { TIMEOUTS } from './types'

/** Sentinel interno para diferenciar timeout de erro de execução. */
const TIMEOUT_SENTINEL = Symbol('DB_TIMEOUT')

export async function checkDb(): Promise<CheckResult> {
  const start = Date.now()

  let timeoutHandle: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), TIMEOUTS.db)
  })

  try {
    // Query template tag — NUNCA $queryRawUnsafe (regra security.md).
    // `SELECT 1` não é parametrizado nem pode ser injection vector.
    const queryPromise = prisma.$queryRaw`SELECT 1`

    const result = await Promise.race([queryPromise, timeoutPromise])

    if (result === TIMEOUT_SENTINEL) {
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        code: 'DB_TIMEOUT',
      }
    }

    return { status: 'up', latencyMs: Date.now() - start }
  } catch {
    // Erro deliberadamente não logado aqui — caller (orchestrator) loga
    // com contexto via request.log para herdar reqId + REDACT_PATHS.
    // Errors do Prisma podem conter hostname/credentials no message.
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      code: 'DB_ERROR',
    }
  } finally {
    /* c8 ignore next -- timeoutHandle is always assigned before any path reaches finally */
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
