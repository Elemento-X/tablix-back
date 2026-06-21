/**
 * Card #189 — Tipos do idempotent receiver de webhooks Stripe.
 *
 * Os handlers de webhook são unit-of-work PURAS: recebem o `tx` da transação
 * e fazem APENAS DB-writes dentro dela. Efeitos colaterais com I/O externo
 * (email) e auditoria fire-and-forget NÃO podem rodar dentro da transação
 * (R-2: I/O na tx segura conexão do pool → exhaustion sob connection_limit=5;
 * além de poder emitir email/audit de um estado que sofreu rollback). Por isso
 * o handler os DECLARA num `WebhookSideEffects` e o orquestrador os EXECUTA
 * depois do COMMIT (padrão outbox-light / Transactional Inbox).
 *
 * @owner: @planner + @dba + @security
 * @card: #189
 */
import type { AuditEventInput } from '../../lib/audit/audit.types'

/**
 * Efeitos colaterais acumulados por um handler durante o processamento na
 * transação, executados pelo orquestrador APÓS o commit.
 *
 * - `emails`: closures de envio (cada uma roda em try/catch fire-and-forget).
 * - `audits`: eventos forenses (emitAuditEvent, fire-and-forget).
 */
export interface WebhookSideEffects {
  emails?: Array<() => Promise<void>>
  audits?: AuditEventInput[]
}

/**
 * Resultado do processamento de um evento Stripe.
 * - `processed`: evento novo (ou reprocessado) concluído com sucesso.
 * - `duplicate`: evento já estava PROCESSED — ignorado sem side-effects.
 */
export type WebhookOutcome = 'processed' | 'duplicate'
