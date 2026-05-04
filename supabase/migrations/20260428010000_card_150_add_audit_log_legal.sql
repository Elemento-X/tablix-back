-- =============================================================================
-- Migration: card_150_add_audit_log_legal
-- Version: 20260428010000
-- Card: #150 (pVasIL6l) — Fase 5 — Storage
--
-- Contexto:
--   Tabela `audit_log_legal` SEPARADA do `audit_log` operacional (Card 2.4).
--   Eventos legais (purge/consent/dsar) exigem retencao 5 ANOS por LGPD
--   Art. 16/37 + CDC Art. 27 (prazo prescricional reparacao por fato do
--   servico). 90d do audit_log operacional eh INCOMPATIVEL.
--
--   Pre-requisito hard de #146 (5.2b cron purge two-phase) — emite eventos
--   `purge_pending`/`purge_completed` aqui pra prova juridica de eliminacao.
--
-- Plano completo: .claude/plans/2026-04-28-card-150-audit-log-legal.md
--
-- DECISOES IRREVERSIVEIS (consultar plano antes de mudar):
--
-- (D-1) Service `recordLegalEvent` eh AWAIT (nao fire-and-forget).
--       Falha de DB DEVE bloquear caller. LGPD nao tolera evento perdido.
--
-- (D-2/D-4) event_type, actor, outcome, legal_basis sao WHITELIST via
--       CHECK constraint. Defesa em profundidade contra bug/injection.
--       Adicionar valor exige migration nova.
--
-- (D-3) Tabela SEPARADA do audit_log (nao flag `is_legal`). Cron 90d com
--       WHERE is_legal=false = bug = apaga prova legal.
--
-- (D-5) userId SEM FOREIGN KEY pra users.id. INTENCIONAL.
--       Razao: evento legal deve SOBREVIVER ao delete do user (essa eh a
--       prova). FK SET NULL = "purga de quem?" absurdo legalmente.
--       FK RESTRICT trava cron de delete user.
--
-- (R-7) NAO REUSAR cron de retencao 90d (audit_log) nesta tabela.
--       Cron 5 anos vive em card #152.
--
-- (resource_hash) bytea 32 bytes = SHA-256(userId:storagePath). FREEZED v1.
--       Mudanca de formula = nova coluna resourceHashV2, NUNCA mutar v1.
--       Implementacao em src/lib/audit-hash.ts (PROIBIDO logar input).
--       Versionamento via coluna resource_hash_algo (default 'sha256v1').
--       50% economia vs hex 64 chars (decisao @dba).
--
-- Hard requirements consolidados (consulta time A-5, voto unanime):
--   @planner: A (HIGH confidence)
--   @security: A — B falha CWE-916 + brute-force; C overengineering
--   @dba: A — B colide cross-tenant; C HMAC sem ganho
--
-- Decisoes operacionais:
--   1. CONCURRENTLY nao usado: tabela nasce vazia, build instantaneo.
--      Indices novos pos-MVP devem usar CONCURRENTLY em migration separada.
--   2. RLS DENY ALL pra `authenticated` (zero leituras de user comum).
--      Backend usa service_role e bypassa RLS por design (mesmo pattern
--      Card 5.1).
--   3. pgcrypto habilitada pra queries forenses ad-hoc (`encode(digest(...))`)
--      embora computo do hash seja em JS (SSOT app, evita drift).
--
-- @owner: @dba + @security
-- =============================================================================

-- ===========================================
-- EXTENSAO pgcrypto (forensics ad-hoc)
-- ===========================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===========================================
-- TABELA audit_log_legal
-- ===========================================

CREATE TABLE "audit_log_legal" (
  "id"                  UUID           NOT NULL DEFAULT gen_random_uuid(),
  "event_id"            UUID           NOT NULL,
  "event_type"          VARCHAR(40)    NOT NULL,
  "timestamp"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "user_id"             UUID           NOT NULL,
  "resource_type"       VARCHAR(40)    NOT NULL,
  "resource_id"         VARCHAR(64)    NOT NULL,
  "legal_basis"         VARCHAR(60)    NOT NULL,
  "actor"               VARCHAR(40)    NOT NULL,
  "expires_at_original" TIMESTAMPTZ(3),
  "resource_hash"       BYTEA,
  "resource_hash_algo"  VARCHAR(8)     NOT NULL DEFAULT 'sha256v1',
  "outcome"             VARCHAR(16)    NOT NULL,
  "error_code"          VARCHAR(80),
  "metadata"            JSONB,
  CONSTRAINT "audit_log_legal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_legal_event_id_key" UNIQUE ("event_id")
);

-- ===========================================
-- CHECK CONSTRAINTS (defesa em profundidade)
-- ===========================================

-- Whitelist explicita de event_type (D-2). Adicionar novo tipo exige migration.
-- Mantida em sync com src/modules/audit-legal/audit-legal.types.ts (as const).
ALTER TABLE "audit_log_legal"
  ADD CONSTRAINT "audit_log_legal_event_type_check"
  CHECK ("event_type" IN (
    'purge_pending',
    'purge_completed',
    'purge_failed',
    'consent_given',
    'consent_withdrawn',
    'dsar_request',
    'dsar_fulfilled'
  ));

-- Whitelist de actor (D-4). Quem disparou o evento.
ALTER TABLE "audit_log_legal"
  ADD CONSTRAINT "audit_log_legal_actor_check"
  CHECK ("actor" IN (
    'cron_purge_worker',
    'user_self_service',
    'admin_panel'
  ));

-- Whitelist de outcome.
ALTER TABLE "audit_log_legal"
  ADD CONSTRAINT "audit_log_legal_outcome_check"
  CHECK ("outcome" IN ('success', 'failure'));

-- legal_basis: snake_case lowercase, length 3-60.
-- Ex: retention_expired, user_request_art_18, consent_withdrawn
ALTER TABLE "audit_log_legal"
  ADD CONSTRAINT "audit_log_legal_legal_basis_format_check"
  CHECK ("legal_basis" ~ '^[a-z_]+$' AND length("legal_basis") BETWEEN 3 AND 60);

-- resource_hash: bytea de exatamente 32 bytes (SHA-256) ou NULL.
-- Decisao @dba: bytea (32B) vs hex (64 chars) = 50% economia em 5 anos.
ALTER TABLE "audit_log_legal"
  ADD CONSTRAINT "audit_log_legal_resource_hash_size_check"
  CHECK ("resource_hash" IS NULL OR octet_length("resource_hash") = 32);

-- error_code obrigatorio se outcome='failure' (validado em Zod superRefine
-- no app; defesa em profundidade no banco).
ALTER TABLE "audit_log_legal"
  ADD CONSTRAINT "audit_log_legal_error_code_required_check"
  CHECK (
    ("outcome" = 'success') OR
    ("outcome" = 'failure' AND "error_code" IS NOT NULL)
  );

-- ===========================================
-- TOAST TUNING (mesmo pattern audit_log)
-- ===========================================
-- metadata pode crescer ate 1024 bytes (cap no app). Mantemos margem
-- pra evitar out-of-line storage que triplica tempo de INSERT.

ALTER TABLE "audit_log_legal" SET (toast_tuple_target = 4096);

-- ===========================================
-- ROW LEVEL SECURITY
-- ===========================================
-- DENY ALL implicito pra qualquer role nao explicitamente permitido.
-- Backend usa service_role e bypassa RLS por design (mesmo pattern Card 5.1).
-- Auditor LGPD com role admin separado pode receber GRANT futuro (card #150 NAO faz).

ALTER TABLE "audit_log_legal" ENABLE ROW LEVEL SECURITY;

-- ===========================================
-- INDICES DECLARATIVOS
-- ===========================================
-- (Espelham os declarados em prisma/schema.prisma — Prisma gera com mesmo
-- nome em prisma migrate dev; criados manualmente aqui pra paridade total.)

-- Query forense: "ultimos N eventos legais do user X"
CREATE INDEX "idx_audit_log_legal_user_ts"
  ON "audit_log_legal" ("user_id", "timestamp" DESC);

-- Query forense: "ultimas purgas/consents/dsars no periodo"
CREATE INDEX "idx_audit_log_legal_event_type_ts"
  ON "audit_log_legal" ("event_type", "timestamp" DESC);

-- ===========================================
-- INDICES PARCIAIS (otimizacao @dba)
-- ===========================================

-- Forensics: investigar falhas de purga (raras, devem ser anomalia).
-- Padrao convencido por Card 2.4 (audit_log_failures).
CREATE INDEX "idx_audit_log_legal_failures"
  ON "audit_log_legal" ("timestamp" DESC)
  WHERE "outcome" = 'failure';

-- Hot path do cron #146: correlacionar `purge_pending` com `purge_completed`
-- via resource_hash. Sem este indice, cron faz seq scan na tabela inteira.
-- Indice parcial = ~5% do volume (so eventos de purga, com hash).
CREATE INDEX "idx_audit_log_legal_hash_pending"
  ON "audit_log_legal" ("resource_hash")
  WHERE "event_type" IN ('purge_pending', 'purge_completed', 'purge_failed')
    AND "resource_hash" IS NOT NULL;

-- ===========================================
-- COMMENTS (documentacao SQL pra auditor LGPD futuro)
-- ===========================================

COMMENT ON TABLE "audit_log_legal" IS
  'Trilha LGPD com retencao 5 anos. SEPARADA de audit_log (90d). Eventos: purge/consent/dsar. Card #150. Plano: .claude/plans/2026-04-28-card-150-audit-log-legal.md';

COMMENT ON COLUMN "audit_log_legal"."user_id" IS
  'Sem FK pra users.id (D-5). Evento legal sobrevive ao delete do user — essa eh a prova juridica.';

COMMENT ON COLUMN "audit_log_legal"."resource_hash" IS
  'Determinístico SHA-256(userId:storagePath) em 32 bytes. NUNCA path real. Nao reversivel. Nao rotacionavel. FREEZED v1. Implementacao: src/lib/audit-hash.ts';

COMMENT ON COLUMN "audit_log_legal"."resource_hash_algo" IS
  'Algoritmo do resource_hash. Default sha256v1. Permite migracao futura pra v2 sem ambiguidade (defense in depth do hash freezed).';

COMMENT ON COLUMN "audit_log_legal"."event_id" IS
  'UUID idempotency-key fornecido pelo CALLER. UNIQUE permite cron retentar sem duplicar evento (P2002 → service faz lookup).';

-- =============================================================================
-- ROLLBACK PLAN (manual, nao automatizado)
-- =============================================================================
-- Tabela nasce vazia em prod (pre-Fase 9). Reversivel ate cron #146 popular.
--
--   DROP TABLE IF EXISTS "audit_log_legal" CASCADE;
--   -- (extension pgcrypto NAO removida — pode estar em uso por outras tabelas)
--
-- Pos-rollback:
--   1. git revert <merge commit>
--   2. npm run schema:fingerprint (regenerar)
--   3. Confirmar prisma generate sem erro
-- =============================================================================
