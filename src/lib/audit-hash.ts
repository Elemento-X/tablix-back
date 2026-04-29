/**
 * Card #150 — Hash determinístico de recurso pra audit_log_legal.
 *
 * FREEZED v1 — NÃO MUDAR A FÓRMULA. Mudança = nova coluna `resourceHashV2`
 * + função `hashResourceV2`, NUNCA mutar a v1. O `resource_hash_algo` da
 * tabela registra qual versão produziu o hash de cada row (default 'sha256v1').
 *
 * Contexto:
 *   Cron #146 (5.2b purge two-phase) emite `purge_pending` antes de deletar
 *   no Storage e `purge_completed` depois. Os 2 eventos correlacionam por
 *   `resource_hash`. Função DEVE ser determinística e estável por 5 anos.
 *
 * Decisão arquitetural (consulta time A-5, voto unânime):
 *   Fórmula: SHA-256("${userId}:${storagePath}") em bytea 32 bytes.
 *   - userId já está em storagePath (`{userId}/{filename}`), prefixar
 *     duplicado eh hardening de domínio (evita colisão se filename de
 *     user X igualar `{userY}/algo`). Custo zero.
 *   - bytea 32 bytes (vs hex 64 chars) = 50% economia em 5 anos (decisão @dba).
 *   - Sem HMAC: audit é interno, RLS-protegido, segredo eterno é
 *     overengineering (decisão @security).
 *
 * Hard requirements (gate @security pré-implementação):
 *   1. Função pura, sem side effects
 *   2. PROIBIDO logar input — `userId` e `storagePath` são PII
 *   3. Sem dependência de env var ou secret (não-rotacionável por design)
 *   4. Teste com vetor fixo conhecido — quebra do teste = quebra de
 *      contrato de 5 anos (rows antigos viram inauditáveis)
 *
 * @owner: @security
 * @card: #150
 * @plan: .claude/plans/2026-04-28-card-150-audit-log-legal.md
 */

import { createHash } from 'node:crypto'

import { RESOURCE_HASH_ALGO_V1 } from '../modules/audit-legal/audit-legal.types'

/**
 * Computa o hash determinístico do recurso.
 *
 * **PROIBIDO logar `userId` ou `storagePath`** — são PII. Função recebe e
 * retorna apenas o hash; sem `console.log`, sem `logger.debug`.
 *
 * @param userId UUID do dono do recurso
 * @param storagePath path completo no Supabase Storage (`{userId}/{filename}`)
 * @returns Buffer de 32 bytes (SHA-256 raw)
 */
export function hashResourceV1(userId: string, storagePath: string): Buffer {
  // SHA-256("${userId}:${storagePath}") raw 32 bytes
  // NUNCA hex/base64 — bytea direto pra coluna do DB (50% economia).
  return createHash('sha256').update(`${userId}:${storagePath}`).digest()
}

/**
 * Identificador da versão do algoritmo. Sempre passar pra coluna
 * `resource_hash_algo` ao persistir, pra permitir migração futura sem
 * ambiguidade.
 *
 * Quando criar v2:
 *   - Criar `hashResourceV2()` (função nova, NÃO mutar v1)
 *   - Exportar `RESOURCE_HASH_ALGO_V2` em audit-legal.types.ts
 *   - Migration: novos inserts usam algo='sha256v2'; rows antigos mantêm v1
 *   - Cron #146 usa `algo` da row pra recomputar hash com a versão correta
 */
export const HASH_RESOURCE_VERSION = RESOURCE_HASH_ALGO_V1
