/**
 * History service — Card #145 (5.2a, Fase 5 Storage).
 *
 * 5 operações sobre `file_history` + opt-in/out trail no `users`:
 *  - enableHistory / disableHistory (opt-in toggle + audit_log_legal AWAIT)
 *  - listUserHistory (cursor pagination, hot path)
 *  - getOneHistory (read-only single row)
 *  - softDeleteOne (sentinela deleted_at; cron #146 apaga físico)
 *  - softDeleteAll (cap LIMIT 10k + advisory lock + audit_log_legal AWAIT)
 *
 * Decisões fechadas (não revisitar sem nova versão):
 *  - D#2 (retention env): `disableHistory` usa `env.PRO_RETENTION_DAYS` SSOT
 *    via `LEAST(expires_at, NOW() + PRO_RETENTION_DAYS days)` — só encurta,
 *    nunca estende (LGPD: menor tempo possível). NUNCA `process.env` direto.
 *  - D-3 (LGPD delete two-phase): `softDelete*` marca `deleted_at`; cron
 *    #146 apaga objeto Storage e depois hard-deleta a row.
 *  - D-C (expires_at em service): calculado aqui, não em trigger DB.
 *  - audit_log_legal AWAIT (padrão #150 D-1): caller deve abortar se DB legal
 *    falhar. consent_given/consent_withdrawn cobrem opt-in/out. DELETE em
 *    massa usa consent_withdrawn + legal_basis='user_request_art_18'.
 *  - R-4 cap LIMIT 10k em DELETE em massa + advisory lock por user_id pra
 *    serializar deletes concorrentes do mesmo user (anti-race upload+delete).
 *
 * Dependências:
 *  - Prisma client SSOT (`src/lib/prisma`)
 *  - audit-legal.service `recordLegalEvent` AWAIT (Card #150)
 *  - audit-hash `hashResourceV1` (FREEZED v1 — NÃO mudar fórmula)
 *  - env `PRO_RETENTION_DAYS` (Card #145 F2)
 *  - logger pino com REDACT_PATHS LGPD (Card 2.1 + #150)
 *
 * **Hard requirements (gate @security):**
 *  - PROIBIDO logar `userId`/`storagePath`/`originalFilename` cru — PII LGPD
 *  - Toda mutação user-driven emite event no audit_log_legal AWAIT
 *  - softDeleteAll usa advisory lock + cap explícito LIMIT 10k
 *  - Nunca exposição de FilePurgeCandidate em response (DTO interno cron)
 *
 * @owner: @planner + @dba + @security
 * @card: #145 (5.2a) F3
 */
import type { FileHistory } from '@prisma/client'
import { randomUUID } from 'node:crypto'

import { env } from '../../config/env'
import { Errors } from '../../errors/app-error'
import { hashResourceV1 } from '../../lib/audit-hash'
import { logger } from '../../lib/logger'
import { prisma } from '../../lib/prisma'
import { recordLegalEvent } from '../audit-legal/audit-legal.service'
import {
  HISTORY_LIST_DEFAULT_LIMIT,
  HISTORY_LIST_MAX_LIMIT,
  type FileHistoryDto,
} from './history.schema'

// ============================================
// CONSTANTES
// ============================================

/**
 * Cap de rows afetadas em DELETE em massa (R-4 do plano). Acima disso, lock
 * prolongado em `idx_filehistory_user_created` durante UPDATE. Cliente recebe
 * `truncated: true` e pode repetir a operação.
 */
const DELETE_ALL_BATCH_CAP = 10_000

// ============================================
// HELPERS (puros — testáveis sem DB)
// ============================================

/**
 * Codifica cursor opaco (base64) com `{id, createdAt}` da última row da
 * página anterior. Cliente NUNCA decodifica — só passa de volta.
 */
function encodeCursor(id: string, createdAt: Date): string {
  return Buffer.from(
    JSON.stringify({ id, createdAt: createdAt.toISOString() }),
    'utf8',
  ).toString('base64url')
}

/**
 * Decodifica cursor. Falha de parsing/shape → `null` (caller trata como
 * cursor inválido sem vazar erro detalhado pro cliente).
 */
function decodeCursor(cursor: string): { id: string; createdAt: Date } | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as { id?: unknown; createdAt?: unknown }
    if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string') {
      return null
    }
    const date = new Date(parsed.createdAt)
    if (Number.isNaN(date.getTime())) return null
    return { id: parsed.id, createdAt: date }
  } catch {
    return null
  }
}

/**
 * Mapeia entidade Prisma → DTO público. Whitelist explícita previne leak
 * de campos novos quando schema evolui (lição Card 5.1 + #32). Campos
 * `userId`, `storagePath`, `deletedAt`, `purgeAttempts` NUNCA aparecem
 * em response — são uso interno do cron #146.
 */
export function toFileHistoryDto(row: FileHistory): FileHistoryDto {
  return {
    id: row.id,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSize,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }
}

// ============================================
// OPERAÇÃO 1 — enableHistory (opt-in)
// ============================================

/**
 * Liga o feature `historyOptIn` do user. Idempotente — chamada repetida
 * apenas atualiza `historyOptInAt`. Emite `consent_given` no audit_log_legal
 * AWAIT (D#150 D-1: caller aborta se evento legal falhar).
 *
 * **Side effects:**
 *  - UPDATE users SET history_opt_in=true, history_opt_in_at=NOW()
 *  - INSERT audit_log_legal (consent_given, legal_basis='feature_opt_in')
 *
 * **Hard requirements:**
 *  - userId VEM DO JWT (controller extrai de request.user.userId), NUNCA body
 *  - audit_log_legal AWAIT — falha de DB legal aborta a operação (sem evento,
 *    sem prova jurídica → não pode mutar consentimento)
 *
 * @throws AppError(LEGAL_AUDIT_PERSIST_FAILED) se audit_log_legal falhar
 */
export async function enableHistory(args: {
  userId: string
}): Promise<{ historyOptInAt: Date }> {
  const eventId = randomUUID()

  // Audit ANTES do UPDATE (padrão #150 D-1: prova legal antes do efeito).
  // Se falhar, throw → caller (controller) retorna 503 e UPDATE não roda.
  await recordLegalEvent({
    eventId,
    eventType: 'consent_given',
    userId: args.userId,
    resourceType: 'feature.history',
    resourceId: 'history_opt_in',
    legalBasis: 'feature_opt_in',
    actor: 'user_self_service',
    outcome: 'success',
  })

  const now = new Date()
  await prisma.user.update({
    where: { id: args.userId },
    data: {
      historyOptIn: true,
      historyOptInAt: now,
    },
  })

  logger.info(
    { event: 'history.enable', userId: args.userId, eventId },
    'history.opt_in.enabled',
  )

  return { historyOptInAt: now }
}

// ============================================
// OPERAÇÃO 2 — disableHistory (opt-out + agenda purga)
// ============================================

/**
 * Desliga o feature `historyOptIn`. Encurta `expires_at` de TODAS as rows
 * ativas pra `LEAST(expires_at, NOW() + PRO_RETENTION_DAYS)` — só encurta,
 * nunca estende (LGPD: menor tempo possível). Emite `consent_withdrawn`
 * AWAIT.
 *
 * **Por que LEAST:** rows com `expires_at` curto (já próximo de expirar)
 * mantêm o expiry curto. Rows com expiry longo são encurtadas pro cap.
 * Preserva monotonicidade — disable nunca aumenta retenção.
 *
 * **Side effects (em ordem):**
 *  1. INSERT audit_log_legal (consent_withdrawn, legal_basis='feature_opt_out')
 *  2. UPDATE file_history SET expires_at = LEAST(...) WHERE user_id=X AND deleted_at IS NULL
 *  3. UPDATE users SET history_opt_in=false, history_opt_out_at=NOW()
 *
 * @throws AppError(LEGAL_AUDIT_PERSIST_FAILED) se audit_log_legal falhar
 */
export async function disableHistory(args: { userId: string }): Promise<{
  historyOptOutAt: Date
  purgeScheduledFor: Date
  affectedRowCount: number
  truncated: boolean
}> {
  const eventId = randomUUID()
  const now = new Date()
  const purgeScheduledFor = new Date(
    now.getTime() + env.PRO_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  )

  await recordLegalEvent({
    eventId,
    eventType: 'consent_withdrawn',
    userId: args.userId,
    resourceType: 'feature.history',
    resourceId: 'history_opt_in',
    legalBasis: 'feature_opt_out',
    actor: 'user_self_service',
    outcome: 'success',
    metadata: {
      retentionDays: env.PRO_RETENTION_DAYS,
    },
  })

  // Encurta expires_at via LEAST com cap LIMIT (anti-lock-contention F3
  // fix-pack @dba MÉDIO). User PRO denso pode ter dezenas de milhares de
  // rows ativas; UPDATE unbounded segura ROW EXCLUSIVE em tudo, bloqueia
  // GET /history concorrente. CTE + LIMIT 10k + FOR UPDATE SKIP LOCKED
  // mesmo pattern do softDeleteAll. Cliente recebe `truncated` pra repetir.
  // Cast `::uuid` obrigatório (user_id é @db.Uuid).
  const affectedRowCount = await prisma.$executeRaw`
    WITH victims AS (
      SELECT id FROM file_history
      WHERE user_id = ${args.userId}::uuid
        AND deleted_at IS NULL
        AND expires_at > ${purgeScheduledFor}
      ORDER BY expires_at DESC
      LIMIT ${DELETE_ALL_BATCH_CAP}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE file_history
    SET expires_at = ${purgeScheduledFor}
    WHERE id IN (SELECT id FROM victims)
  `

  await prisma.user.update({
    where: { id: args.userId },
    data: {
      historyOptIn: false,
      historyOptOutAt: now,
    },
  })

  logger.info(
    {
      event: 'history.disable.scheduled',
      userId: args.userId,
      retentionDays: env.PRO_RETENTION_DAYS,
      affectedRowCount,
      purgeScheduledFor: purgeScheduledFor.toISOString(),
      eventId,
    },
    'history.opt_in.disabled',
  )

  return {
    historyOptOutAt: now,
    purgeScheduledFor,
    affectedRowCount: Number(affectedRowCount),
    truncated: Number(affectedRowCount) >= DELETE_ALL_BATCH_CAP,
  }
}

// ============================================
// OPERAÇÃO 3 — listUserHistory (cursor pagination)
// ============================================

/**
 * Lista o histórico ativo do user. Cursor pagination (preferido sobre
 * offset — `api-contract.md`). Cliente NUNCA decodifica o cursor.
 *
 * **Query plan:** usa `idx_filehistory_user_created` composto (user_id,
 * created_at DESC). EXPLAIN ANALYZE F1.1 confirmou 0.28ms na hot path.
 *
 * Filtra `deleted_at IS NULL` — soft-deleted invisível pro user. Caller
 * (controller) deve checar `historyOptIn` antes (D#4 invariante 403).
 */
export async function listUserHistory(args: {
  userId: string
  cursor?: string
  limit?: number
}): Promise<{
  items: FileHistoryDto[]
  nextCursor: string | null
  hasMore: boolean
}> {
  const limit = Math.min(
    args.limit ?? HISTORY_LIST_DEFAULT_LIMIT,
    HISTORY_LIST_MAX_LIMIT,
  )

  // Cursor inválido = trata como sem cursor (não vaza erro detalhado).
  // Defesa contra cliente enviando cursor de outro user (race seguro:
  // o WHERE user_id seguir aplicado).
  const decoded = args.cursor ? decodeCursor(args.cursor) : null

  // +1 pra detectar `hasMore` sem query extra
  const rows = await prisma.fileHistory.findMany({
    where: {
      userId: args.userId,
      deletedAt: null,
      ...(decoded != null && {
        // Cursor: pegar rows ANTES do (createdAt, id) do cursor.
        // Tie-break por id pra ordem determinística com createdAt iguais.
        OR: [
          { createdAt: { lt: decoded.createdAt } },
          {
            AND: [{ createdAt: decoded.createdAt }, { id: { lt: decoded.id } }],
          },
        ],
      }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const lastRow = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && lastRow ? encodeCursor(lastRow.id, lastRow.createdAt) : null

  return {
    items: pageRows.map(toFileHistoryDto),
    nextCursor,
    hasMore,
  }
}

// ============================================
// OPERAÇÃO 4 — getOneHistory (single row)
// ============================================

/**
 * Lê 1 row de file_history do user. Filtra `deleted_at IS NULL` — row
 * soft-deletada retorna NotFound (cliente não deve saber que existiu).
 *
 * Controller decora com signedUrl (TTL 60s — R-9 mitigation).
 *
 * @throws AppError(NOT_FOUND) se row não existe ou pertence a outro user
 *   (mesma resposta — não diferencia, evita enumeração CWE-203)
 */
export async function getOneHistory(args: {
  userId: string
  id: string
}): Promise<FileHistory> {
  const row = await prisma.fileHistory.findFirst({
    where: {
      id: args.id,
      userId: args.userId,
      deletedAt: null,
    },
  })

  if (!row) {
    throw Errors.notFound('FileHistory')
  }

  return row
}

// ============================================
// OPERAÇÃO 5 — softDeleteOne (sentinela)
// ============================================

/**
 * Soft-delete: marca `deleted_at = NOW()`. Cron #146 (5.2b) apaga objeto
 * físico no Storage e depois hard-deleta a row.
 *
 * Idempotente — chamadas repetidas após a primeira retornam NotFound
 * (já invisível pro user). Não emite no audit_log_legal aqui (delete
 * individual cobre via audit_log operacional). Audit_log_legal entra
 * em `softDeleteAll` (Art. 18 LGPD em massa) e em `consent_withdrawn`.
 *
 * @throws AppError(NOT_FOUND) se row não existe, soft-deletada, ou cross-tenant
 */
export async function softDeleteOne(args: {
  userId: string
  id: string
}): Promise<{ deletedAt: Date }> {
  const now = new Date()

  // updateMany com count — atomic + verifica ownership/deleted_at no WHERE
  const result = await prisma.fileHistory.updateMany({
    where: {
      id: args.id,
      userId: args.userId,
      deletedAt: null,
    },
    data: {
      deletedAt: now,
    },
  })

  if (result.count === 0) {
    // Mesma resposta de "não encontrado" + "cross-tenant" + "já soft-deletado".
    // Evita enumeração via timing/diff de erro (CWE-203).
    throw Errors.notFound('FileHistory')
  }

  logger.info(
    { event: 'history.delete.one', userId: args.userId, id: args.id },
    'history.soft_delete.one',
  )

  return { deletedAt: now }
}

// ============================================
// OPERAÇÃO 6 — softDeleteAll (cap + advisory lock + audit)
// ============================================

/**
 * Soft-delete em massa. Marca `deleted_at = NOW()` em até DELETE_ALL_BATCH_CAP
 * (10k) rows ativas do user. Cap previne lock prolongado em
 * `idx_filehistory_user_created` durante UPDATE.
 *
 * **Atomicidade via advisory lock:** `pg_advisory_xact_lock(hashtext(userId))`
 * serializa deletes concorrentes do mesmo user (evita race entre 2 calls
 * paralelas que rodariam UPDATE em rows que também estão sendo inseridas).
 * Lock é por transação (libera no COMMIT).
 *
 * **Audit:** `consent_withdrawn` AWAIT com legal_basis='user_request_art_18'
 * (LGPD Art. 18 direito à eliminação) + metadata com count + ip + ua + fp
 * + fingerprint do request. Hash do request via SHA-256(userId:'delete_all':timestamp).
 *
 * **Truncated flag:** se hits cap (count == 10k), retorna `truncated: true`
 * pro cliente saber que pode repetir. Ack à risk-aware UX (não dá garantia
 * "tudo apagado" num único call sem cap).
 *
 * @throws AppError(LEGAL_AUDIT_PERSIST_FAILED) se audit_log_legal falhar
 */
export async function softDeleteAll(args: {
  userId: string
  ip: string
  userAgent: string
  fingerprint?: string
}): Promise<{
  affectedRowCount: number
  deletedAt: Date
  truncated: boolean
}> {
  const eventId = randomUUID()
  const now = new Date()

  // Resource hash determinístico do request (FREEZED v1) — permite correlação
  // forense entre delete + cron purge_completed sem expor PII no audit.
  // Buffer extends Uint8Array but TS 5+ tightens generics; cast estreita
  // pra Uint8Array<ArrayBuffer> que o schema do recordLegalEvent espera.
  const resourceHash = new Uint8Array(
    hashResourceV1(args.userId, `delete_all:${now.toISOString()}`),
  )

  // (1) Audit ANTES (padrão #150 D-1). Falha = abort total.
  await recordLegalEvent({
    eventId,
    eventType: 'consent_withdrawn',
    userId: args.userId,
    resourceType: 'file_history.batch',
    resourceId: 'all',
    legalBasis: 'user_request_art_18',
    actor: 'user_self_service',
    outcome: 'success',
    resourceHash,
    metadata: {
      ip: args.ip,
      userAgent: args.userAgent,
      ...(args.fingerprint != null && { fingerprint: args.fingerprint }),
    },
  })

  // (2) Soft-delete via CTE + FOR UPDATE SKIP LOCKED (F3 fix-pack @dba ALTO).
  // O advisory lock anterior NÃO prevenia race com upload concorrente — INSERTs
  // de upload não adquirem o mesmo lock, e o subquery LIMIT usa snapshot MVCC,
  // permitindo rows criadas durante o UPDATE escaparem.
  // FOR UPDATE SKIP LOCKED dá garantia row-level + skip de rows lockadas
  // (cron #146 trabalhando em paralelo não trava esta query, e vice-versa).
  // Bonus: elimina hashtext int4 colision (BAIXO) e simplifica.
  // Cast `::uuid` obrigatório (user_id é @db.Uuid).
  const [affectedRowCount, remainingActive] = await prisma.$transaction(
    async (tx) => {
      const updated = await tx.$executeRaw`
        WITH victims AS (
          SELECT id FROM file_history
          WHERE user_id = ${args.userId}::uuid
            AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT ${DELETE_ALL_BATCH_CAP}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE file_history
        SET deleted_at = ${now}
        WHERE id IN (SELECT id FROM victims)
      `
      // Conta rows ainda ativas após o UPDATE (na MESMA tx) — pra detectar
      // truncated correto sob race. Sem isso, rows inseridas durante a tx
      // ficam invisíveis e cliente não sabe que precisa repetir.
      const remaining = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM file_history
        WHERE user_id = ${args.userId}::uuid
          AND deleted_at IS NULL
      `
      return [Number(updated), Number(remaining[0].count)] as const
    },
  )

  // truncated = ainda há rows ativas após o batch (cap atingiu OU race
  // deixou orfãs). Cliente repete até remainingActive === 0.
  const truncated = remainingActive > 0

  logger.info(
    {
      event: 'history.delete.all',
      userId: args.userId,
      affectedRowCount,
      remainingActive,
      truncated,
      eventId,
    },
    'history.soft_delete.all',
  )

  return {
    affectedRowCount,
    deletedAt: now,
    truncated,
  }
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  encodeCursor,
  decodeCursor,
  DELETE_ALL_BATCH_CAP,
}
