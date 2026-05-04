/**
 * Card #150 — Audit Legal service (AWAIT + idempotency).
 *
 * Persiste eventos LGPD-relevantes (purge/consent/dsar) na tabela
 * `audit_log_legal` com retencao 5 anos.
 *
 * SEPARADO do `src/lib/audit/audit.service.ts` (operacional, 90d, fire-and-forget).
 *
 * Diferencas chave vs audit_log operacional:
 *
 *   1. **AWAIT obrigatorio (D-1)**. Assinatura `Promise<AuditLogLegal>`.
 *      Falha de DB DEVE bloquear caller. LGPD nao tolera evento perdido —
 *      sem audit, nao ha prova juridica da purga, e o caller (cron #146 ou
 *      DSAR handler) DEVE abortar a operacao downstream (delete Storage,
 *      export DSAR, etc).
 *
 *   2. **Idempotencia por eventId UNIQUE**. Caller fornece UUID v4 como
 *      idempotency-key. P2002 (UNIQUE violation) → service faz lookup do
 *      evento existente e RETORNA — cron pode retentar sem duplicar.
 *      Pattern alinhado com `stripe_events.id`.
 *
 *   3. **Sem retry, sem fire-and-forget**. Auditoria operacional aceita
 *      perda silenciosa (telemetria); auditoria legal NAO.
 *
 *   4. **Sem ip / userAgent**. Tabela nao tem essas colunas — eventos legais
 *      nao precisam (audit_log operacional cobre acesso/network forensics).
 *
 *   5. **scrubObject + cap 1024 bytes** no metadata (mesmo SSOT do audit_log
 *      operacional). Defense in depth contra PII vazada por bug do caller.
 *
 *   6. **resourceHash sempre Bytes (32) ou null**. Computado por
 *      `src/lib/audit-hash.ts` (FREEZED v1). Service NAO computa, apenas
 *      persiste — mantém SSOT da formula em um lugar.
 *
 * Hard requirements (gate @security pre-implementacao):
 *   - PROIBIDO logar payload completo do input (PII em userId/resourceId)
 *   - Logs estruturados pino com `legal: true` flag
 *   - Sentry breadcrumb sempre (sucesso info, falha error)
 *   - Throw AppError(LEGAL_AUDIT_PERSIST_FAILED) em qualquer falha de DB
 *
 * @owner: @security + @dba
 * @card: #150
 * @plan: .claude/plans/2026-04-28-card-150-audit-log-legal.md
 */

import type { AuditLogLegal, Prisma } from '@prisma/client'
import { Prisma as PrismaNs } from '@prisma/client'

import { Sentry, scrubObject } from '../../config/sentry'
import { Errors } from '../../errors/app-error'
import { logger } from '../../lib/logger'
import { prisma } from '../../lib/prisma'

import {
  legalEventInputSchema,
  METADATA_MAX_BYTES,
  RESOURCE_HASH_ALGO_V1,
  type LegalEventInput,
} from './audit-legal.types'

/**
 * Remove CR/LF/NUL bytes para prevenir log injection. Reusa pattern do
 * audit_log operacional (Card #88).
 *
 * NOTA (Card #150 fix-pack): truncate/COLUMN_LIMITS removidos — Zod schema em
 * audit-legal.types.ts garante max length via .max(N) (sync com CHECK SQL via
 * teste de paridade em audit-legal.integration.test.ts). Manter dois sistemas
 * de limite criava falsa SSOT (operador via const exportada e assumia ser hot
 * path quando era apenas helper de teste). Defesa restante: stripCrlf (que
 * Zod NAO garante).
 */
function stripCrlf(value: string): string {
  return value.split('\r').join('').split('\n').join('').split('\0').join('')
}

/**
 * Aplica scrubObject + cap de bytes no metadata. Mesmo pattern do audit_log
 * operacional. Caller pode passar objeto com secret por engano — esta eh a
 * ultima barreira antes do banco.
 */
function prepareMetadata(
  raw: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  if (raw == null) return undefined
  const scrubbed = scrubObject(raw) as Record<string, unknown>
  const serialized = JSON.stringify(scrubbed)
  if (serialized.length <= METADATA_MAX_BYTES) {
    return scrubbed as Prisma.InputJsonValue
  }
  return {
    _truncated: true,
    _originalBytes: serialized.length,
    _limitBytes: METADATA_MAX_BYTES,
  }
}

/**
 * Persiste o evento na tabela `audit_log_legal` com idempotency por eventId.
 *
 * Fluxo:
 *   1. Validacao Zod do input (throw em violacao)
 *   2. Sanitizacao defensiva (stripCrlf — anti log-injection; max length via Zod)
 *   3. scrubObject + cap em metadata
 *   4. INSERT no Postgres
 *   5. Em P2002 (UNIQUE violation no eventId): lookup do evento existente
 *      e RETORNA (idempotente, cron pode retentar)
 *   6. Em qualquer outra falha: log error + Sentry + throw AppError
 *
 * **NUNCA logar `input` cru** — contem PII (userId, resourceId).
 * Log estruturado emite apenas: legal:true, eventType, eventId, actor,
 * outcome, resourceType.
 *
 * @throws ZodError em input invalido
 * @throws AppError(LEGAL_AUDIT_PERSIST_FAILED) em falha de DB nao-recuperavel
 */
export async function recordLegalEvent(
  input: LegalEventInput,
): Promise<AuditLogLegal> {
  // (1) Validacao Zod
  const validated = legalEventInputSchema.parse(input)

  // (2) Sanitizacao defensiva: stripCrlf pra evitar log injection.
  // NOTA: Zod ja garante max length nos schemas — sem truncate redundante.
  const resourceType = stripCrlf(validated.resourceType)
  const resourceId = stripCrlf(validated.resourceId)
  const legalBasis = stripCrlf(validated.legalBasis)
  const errorCode =
    validated.errorCode != null ? stripCrlf(validated.errorCode) : null

  // (3) Metadata: scrub + cap
  const metadata = prepareMetadata(validated.metadata)

  // resource_hash: converter Uint8Array -> Buffer pra Prisma (Bytes)
  const resourceHash =
    validated.resourceHash != null ? Buffer.from(validated.resourceHash) : null

  // Sentry breadcrumb antes da persistencia (vai junto se erro escalar).
  // Level info (sucesso esperado) ou warning se outcome=failure.
  try {
    Sentry.addBreadcrumb({
      category: 'audit-legal',
      type: 'info',
      level: validated.outcome === 'failure' ? 'warning' : 'info',
      message: `legal_event:${validated.eventType}`,
      data: {
        legal: true,
        eventId: validated.eventId,
        eventType: validated.eventType,
        actor: validated.actor,
        outcome: validated.outcome,
        resourceType,
        // PII propositalmente OMITIDA: userId, resourceId, metadata
      },
    })
  } catch {
    // Sentry nao inicializado (dev/test sem DSN) — silencioso.
  }

  // Pino log estruturado SEMPRE (segunda copia da evidencia).
  logger.info(
    {
      legal: true,
      eventId: validated.eventId,
      eventType: validated.eventType,
      actor: validated.actor,
      outcome: validated.outcome,
      resourceType,
      legalBasis,
      // userId/resourceId NAO logados (PII LGPD)
    },
    'audit_legal_event',
  )

  // (4) INSERT
  try {
    const created = await prisma.auditLogLegal.create({
      data: {
        eventId: validated.eventId,
        eventType: validated.eventType,
        userId: validated.userId,
        resourceType,
        resourceId,
        legalBasis,
        actor: validated.actor,
        expiresAtOriginal: validated.expiresAtOriginal,
        resourceHash,
        resourceHashAlgo: RESOURCE_HASH_ALGO_V1,
        outcome: validated.outcome,
        errorCode,
        metadata,
      },
    })
    return created
  } catch (err) {
    // (5) P2002 = UNIQUE violation. Esperado em cron retry — lookup e retorna.
    let raceCondition = false
    if (
      err instanceof PrismaNs.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const existing = await prisma.auditLogLegal.findUnique({
        where: { eventId: validated.eventId },
      })
      if (existing != null) {
        logger.info(
          {
            legal: true,
            eventId: validated.eventId,
            eventType: validated.eventType,
            idempotent: true,
          },
          'audit_legal_event.idempotent_hit',
        )
        return existing
      }
      // Race teorica: P2002 mas findUnique retorna null = OUTRO worker pegou
      // o eventId entre nosso INSERT e nosso findUnique. Diferente de DB-down:
      // caller (cron) deve retentar IMEDIATAMENTE com mesmo eventId, nao com
      // backoff exponencial. Sinalizamos via details.raceCondition pro consumer
      // discriminar (Card #150 fix-pack F-ALTO-02).
      raceCondition = true
    }

    // (6) Falha nao-recuperavel: log error + Sentry breadcrumb + throw.
    logger.error(
      {
        err,
        legal: true,
        eventId: validated.eventId,
        eventType: validated.eventType,
        actor: validated.actor,
        raceCondition,
      },
      'audit_legal.persist_failed',
    )

    try {
      Sentry.addBreadcrumb({
        category: 'audit-legal',
        type: 'error',
        level: 'error',
        message: 'audit_legal.persist_failed',
        data: {
          legal: true,
          eventId: validated.eventId,
          eventType: validated.eventType,
          raceCondition,
        },
      })
    } catch {
      // noop
    }

    throw Errors.legalAuditPersistFailed(
      raceCondition
        ? 'Race condition ao persistir evento legal — retry imediato'
        : 'Falha ao persistir evento legal de auditoria',
      {
        eventId: validated.eventId,
        eventType: validated.eventType,
        raceCondition,
      },
    )
  }
}

/**
 * Internals expostos APENAS para testes unitarios. Nao usar em producao.
 */
export const __testing = {
  prepareMetadata,
  stripCrlf,
}
