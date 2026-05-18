/**
 * Storage path hash helper — Card #146 (5.2b) F1 (promoção do helper do
 * Card #145 F5 fix-pack).
 *
 * Hash SHA-256 hex determinístico do storage path para audit trail forense
 * em logs estruturados (pino + Sentry breadcrumbs) E em `audit_log_legal.metadata`
 * via cron de purge. NUNCA logar path cru — vaza estrutura interna
 * (`{userId}/{yyyy-mm-dd}/{jobId}.{ext}`) e pode incluir partes do
 * userId/jobId (PII indireta).
 *
 * **Propósito desta promoção**: original em `src/http/controllers/history.controller.ts`
 * (introduzido pelo Card #145 F5 fix-pack como helper privado) precisa ser
 * reusado pelo cron `history-purge` (Card #146 F3) em `src/jobs/retention.job.ts`.
 * Duplicar o helper viola DRY E gera risco de divergência (ex: alguém troca
 * SHA-256 por SHA-1 em um lugar). Promover pra módulo dedicado é o caminho
 * correto antes de adicionar o segundo caller.
 *
 * **Diferença vs `src/lib/audit/audit-hash.ts` (Card #150)**: aquele helper
 * retorna `Uint8Array` (32 bytes raw) pra coluna `resource_hash bytea` da
 * `audit_log_legal`. ESTE helper retorna string hex (64 chars) pra log
 * estruturado E pra `audit_log_legal.metadata` (JSONB — strings legíveis
 * em SQL queries forenses). Propósitos distintos, intencionalmente separados.
 *
 * **Forense LGPD**: cruzar `storage.signed_url.created.pathHash` (logs pino
 * via `fly logs`) com `audit_log_legal(purge_pending).metadata.pathHash`
 * (DB query) permite identificar todo usuário cujo signed URL foi emitido
 * no intervalo suspeito antes do DELETE.
 *
 * @owner: @security + @reviewer
 * @card: #146 F1 (#145 F5 originator)
 */
import { createHash } from 'node:crypto'

/**
 * Hash SHA-256 hex (64 chars lowercase) do storage path. Determinístico —
 * mesmo input gera mesmo output. Reversibilidade brute-force impossível
 * (SHA-256 + path com UUID v4 + cuid = ~190 bits de entropia).
 *
 * @param storagePath path no Supabase Storage (formato `{userId}/{yyyy-mm-dd}/{jobId}.{ext}`)
 * @returns hex string SHA-256 (64 chars)
 *
 * @example
 * hashStoragePathForAudit('abc-uuid/2026-05-18/job123.csv')
 * // → '8a2c1d4e...' (64 chars hex)
 */
export function hashStoragePathForAudit(storagePath: string): string {
  return createHash('sha256').update(storagePath).digest('hex')
}
