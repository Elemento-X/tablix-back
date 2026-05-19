/**
 * Card 2.4 — Tipos do domínio de auditoria.
 *
 * Fonte única da verdade dos eventos auditáveis. Toda emissão DEVE usar
 * `AuditAction` — strings livres são proibidas (CHECK constraint do banco
 * reforça `^[A-Z_]+$` + length 3-50 como defesa em profundidade).
 *
 * Decisões (consolidadas com @security + @dba em 2026-04-19):
 *
 *   1. **Objeto `as const` + union type** em vez de `enum`.
 *      Não gera código runtime (tree-shaking-friendly) e evita as gotchas
 *      clássicas do `enum` TS (numeric enum reverse-mapping, string enum
 *      incompatível entre `erasableSyntaxOnly` e isolatedModules).
 *
 *   2. **11 eventos cobrem o blast radius de autenticação e billing**.
 *      Não incluímos eventos de domínio (ex: UPLOAD_STARTED) porque o
 *      objetivo do audit_log é investigação forense de acesso e mudança
 *      de estado financeiro — telemetria de feature fica em log estruturado
 *      regular (pino) com tracing do Sentry.
 *
 *   3. **`actor` opcional** por design. Eventos de webhook (`WEBHOOK_*`)
 *      nem sempre têm user resolvido no momento de registrar (idempotency
 *      hit acontece antes de carregar o user). Melhor registrar `null`
 *      do que bloquear o evento.
 *
 *   4. **`metadata` é `Record<string, unknown>`**, não `Json` genérico.
 *      Obriga o caller a passar objeto estruturado. `unknown` em cada
 *      valor força narrow pelo consumidor (analista forense). Nunca
 *      `any` — perde audit trail de tipo.
 *
 * @owner: @security + @dba (pipeline core estendido)
 */

/**
 * Eventos auditáveis do sistema. Ordem importa para revisão humana:
 * agrupados por domínio (auth → webhook → billing → bind).
 *
 * IMPORTANTE: adicionar evento novo exige:
 *   (1) adicionar aqui
 *   (2) atualizar CHECK constraint não é necessário (regex já cobre)
 *   (3) atualizar docs do agente @security com novo evento
 *   (4) adicionar caso de teste em audit.service.spec.ts
 */
export const AuditAction = {
  // ========================================
  // Auth — validação de token e sessão
  // ========================================
  /** Token Pro validado com sucesso (ativação ou re-login). */
  TOKEN_VALIDATE_SUCCESS: 'TOKEN_VALIDATE_SUCCESS',
  /** Token Pro inválido, expirado, revogado ou fingerprint mismatch. */
  TOKEN_VALIDATE_FAILURE: 'TOKEN_VALIDATE_FAILURE',
  /** Refresh token rotacionado com sucesso (prolongou sessão). */
  SESSION_REFRESH: 'SESSION_REFRESH',
  /** Refresh falhou (token revogado, expirado, reuso detectado). */
  SESSION_REFRESH_FAILURE: 'SESSION_REFRESH_FAILURE',
  /** Logout voluntário da sessão atual. */
  LOGOUT: 'LOGOUT',
  /** Logout em massa (revoga todas as sessões do usuário). */
  LOGOUT_ALL: 'LOGOUT_ALL',

  // ========================================
  // Webhook — eventos do Stripe
  // ========================================
  /** Webhook processado com sucesso (state mutation aplicada). */
  WEBHOOK_PROCESSED: 'WEBHOOK_PROCESSED',
  /** Webhook duplicado (idempotency hit em stripe_events). */
  WEBHOOK_DUPLICATE: 'WEBHOOK_DUPLICATE',
  /** Assinatura do webhook falhou (possível forgery — A07). */
  WEBHOOK_SIGNATURE_FAILED: 'WEBHOOK_SIGNATURE_FAILED',

  // ========================================
  // Billing — falhas de pagamento
  // ========================================
  /** Cobrança recusada (Stripe invoice.payment_failed). */
  PAYMENT_FAILED: 'PAYMENT_FAILED',

  // ========================================
  // Identity — criação e privilégio (ASVS V7.1)
  // ========================================
  /** Conta de usuário criada (primeira checkout.session.completed por email). */
  ACCOUNT_CREATED: 'ACCOUNT_CREATED',
  /** Role do usuário mudou (FREE↔PRO, escalada ou downgrade de privilégio). */
  ROLE_CHANGED: 'ROLE_CHANGED',

  // ========================================
  // Bind — vínculo device/fingerprint
  // ========================================
  /** Fingerprint do device vinculado a um token (anti-compartilhamento). */
  FINGERPRINT_BOUND: 'FINGERPRINT_BOUND',
  /**
   * Fingerprint apresentado difere do vinculado ao token. Forense crítico:
   * pode ser compartilhamento de token, sequestro ou device change legítimo.
   * Registrado antes de TOKEN_VALIDATE_FAILURE para preservar o discriminator
   * de motivo (o controller emite o FAILURE com metadata.reason genérico).
   */
  FINGERPRINT_MISMATCH: 'FINGERPRINT_MISMATCH',
} as const

/**
 * Union type derivado dos valores do objeto — é o tipo aceito por
 * `emitAuditEvent` e pelo serviço de persistência.
 */
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction]

/**
 * Input do emissor — o que o caller passa.
 *
 * Campos opcionais refletem a realidade operacional:
 *   - `actor`: null em webhook antes de resolver o user
 *   - `ip`/`userAgent`: null em contexto cron/worker (sem request)
 *   - `metadata`: sempre opcional — evento pode ser autoexplicativo
 *     pelo action + actor (ex: LOGOUT não precisa de extras)
 *
 * `success` é obrigatório e boolean — evento ambíguo ("não sei se deu
 * certo") é bug do caller, não caso de uso.
 */
export interface AuditEventInput {
  /** Tipo do evento (enum). */
  action: AuditAction
  /** userId, stripeCustomerId, 'system' ou null (webhook sem user resolvido). */
  actor?: string | null
  /** IP do client (request.ip). null em contexto sem request. */
  ip?: string | null
  /** User agent do client. null em contexto sem request. */
  userAgent?: string | null
  /** Resultado do evento: sucesso lógico (não sucesso da gravação). */
  success: boolean
  /** Contexto extra estruturado. Passado por REDACT_PATHS antes de persistir. */
  metadata?: Record<string, unknown>
}
