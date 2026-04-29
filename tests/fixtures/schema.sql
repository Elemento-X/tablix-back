-- ============================================================================
-- Schema snapshot — Tablix Backend
-- ============================================================================
-- Origem: introspection de produção (Supabase) via MCP em 2026-04-21,
--         re-sincronizado em 2026-04-24 após Fase 3 DB Hardening (commit
--         43bc1c2) — migrations TIMESTAMPTZ + UUID native + drop orphan
--         indexes aplicadas em prod Supabase em 2026-04-24.
-- Uso: aplicado no Testcontainers (postgres:17-alpine) antes de cada suíte
-- de integração. É a SSOT do schema em ambiente de teste.
--
-- NÃO EDITAR À MÃO. Para regenerar após mudança de schema em prod, rodar:
--   npx tsx scripts/dump-test-schema.ts
--
-- Pareado com: prisma/schema.prisma e supabase/migrations/**.sql (são as
-- fontes canônicas de prod; este arquivo é só o snapshot consolidado).
-- ============================================================================

-- Extensão requerida por gen_random_uuid() (presente em Supabase/PG 17)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- ENUMS
-- ----------------------------------------------------------------------------
CREATE TYPE "JobStatus"   AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "Plan"        AS ENUM ('PRO');
CREATE TYPE "Role"        AS ENUM ('FREE', 'PRO');
CREATE TYPE "TokenStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED');

-- ----------------------------------------------------------------------------
-- TABLE: users
-- ----------------------------------------------------------------------------
CREATE TABLE "users" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "email"               VARCHAR(255)    NOT NULL,
  "role"                "Role"          NOT NULL DEFAULT 'FREE',
  "stripe_customer_id"  VARCHAR(255),
  "created_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key"              ON "users" ("email");
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users" ("stripe_customer_id");

-- ----------------------------------------------------------------------------
-- TABLE: sessions
-- ----------------------------------------------------------------------------
CREATE TABLE "sessions" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             UUID            NOT NULL,
  "fingerprint"         VARCHAR(64),
  "user_agent"          VARCHAR(512),
  "ip_address"          VARCHAR(45),
  "refresh_token_hash"  VARCHAR(64)     NOT NULL,
  "created_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_activity_at"    TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"          TIMESTAMPTZ(3)  NOT NULL,
  "revoked_at"          TIMESTAMPTZ(3),
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions" ("refresh_token_hash");
CREATE        INDEX "sessions_user_id_idx"            ON "sessions" ("user_id");
CREATE        INDEX "idx_sessions_expires_at"         ON "sessions" ("expires_at");
CREATE        INDEX "idx_sessions_revoked_at"         ON "sessions" ("revoked_at");

-- ----------------------------------------------------------------------------
-- TABLE: tokens
-- ----------------------------------------------------------------------------
-- NOTA: índice `tokens_token_idx` (BTREE em token) era redundante com
-- `tokens_token_key` UNIQUE — droppado em Fase 3 Migration C (2026-04-24).
-- UNIQUE serve queries de leitura tão bem quanto BTREE comum.
CREATE TABLE "tokens" (
  "id"                      UUID            NOT NULL DEFAULT gen_random_uuid(),
  "token"                   VARCHAR(64)     NOT NULL,
  "fingerprint"             VARCHAR(64),
  "stripe_subscription_id"  VARCHAR(255),
  "plan"                    "Plan"          NOT NULL DEFAULT 'PRO',
  "status"                  "TokenStatus"   NOT NULL DEFAULT 'ACTIVE',
  "created_at"              TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at"            TIMESTAMPTZ(3),
  "expires_at"              TIMESTAMPTZ(3),
  "user_id"                 UUID            NOT NULL,
  CONSTRAINT "tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "uq_tokens_user_subscription" UNIQUE ("user_id", "stripe_subscription_id")
);
CREATE UNIQUE INDEX "tokens_token_key"       ON "tokens" ("token");
CREATE        INDEX "tokens_fingerprint_idx" ON "tokens" ("fingerprint");
CREATE        INDEX "idx_tokens_user"        ON "tokens" ("user_id");

-- ----------------------------------------------------------------------------
-- TABLE: usage
-- ----------------------------------------------------------------------------
-- NOTA: índice `idx_usage_token_period` era redundante com a UNIQUE composta
-- `usage_user_id_period_key` — droppado em Fase 3 Migration C (2026-04-24).
CREATE TABLE "usage" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             UUID            NOT NULL,
  "period"              VARCHAR(7)      NOT NULL,
  "unifications_count"  INTEGER         NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "usage_user_id_period_key" ON "usage" ("user_id", "period");

-- ----------------------------------------------------------------------------
-- TABLE: jobs
-- ----------------------------------------------------------------------------
CREATE TABLE "jobs" (
  "id"                UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"           UUID            NOT NULL,
  "status"            "JobStatus"     NOT NULL DEFAULT 'PENDING',
  "input_files"       JSONB           NOT NULL,
  "output_file_url"   VARCHAR(500),
  "error_message"     TEXT,
  "created_at"        TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"        TIMESTAMPTZ(3),
  "completed_at"      TIMESTAMPTZ(3),
  CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX "idx_jobs_user"   ON "jobs" ("user_id");
CREATE INDEX "idx_jobs_status" ON "jobs" ("status");

-- ----------------------------------------------------------------------------
-- TABLE: stripe_events
-- ----------------------------------------------------------------------------
CREATE TABLE "stripe_events" (
  "id"            VARCHAR(255)               NOT NULL,
  "type"          VARCHAR(255)               NOT NULL,
  "processed_at"  TIMESTAMPTZ(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_stripe_events_processed_at" ON "stripe_events" ("processed_at");

-- ----------------------------------------------------------------------------
-- TABLE: audit_log
-- ----------------------------------------------------------------------------
CREATE TABLE "audit_log" (
  "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "action"      VARCHAR(50)     NOT NULL,
  "actor"       VARCHAR(255),
  "ip"          VARCHAR(45),
  "user_agent"  VARCHAR(512),
  "success"     BOOLEAN         NOT NULL,
  "metadata"    JSONB,
  "created_at"  TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_action_format_check" CHECK (
    ((action)::text ~ '^[A-Z_]+$'::text)
    AND (length((action)::text) >= 3)
    AND (length((action)::text) <= 50)
  )
);
ALTER TABLE "audit_log" SET (toast_tuple_target = 4096);
CREATE INDEX "idx_audit_log_action"            ON "audit_log" ("action");
CREATE INDEX "idx_audit_log_actor_created_at"  ON "audit_log" ("actor", "created_at" DESC);
CREATE INDEX "idx_audit_log_created_at"        ON "audit_log" ("created_at");
CREATE INDEX "idx_audit_log_failures"          ON "audit_log" ("created_at" DESC) WHERE (success = false);

-- ----------------------------------------------------------------------------
-- TABLE: audit_log_legal
-- ----------------------------------------------------------------------------
-- Trilha LGPD com retencao 5 anos. SEPARADA de audit_log (90d).
-- Eventos: purge/consent/dsar. Card #150 (Fase 5).
-- IRREVERSIVEIS: D-1 (await), D-2/D-4 (whitelists), D-3 (tabela separada),
-- D-5 (sem FK userId), R-7 (nao reusar cron 90d), resource_hash FREEZED v1.
-- Plano: .claude/plans/2026-04-28-card-150-audit-log-legal.md
CREATE TABLE "audit_log_legal" (
  "id"                    UUID            NOT NULL DEFAULT gen_random_uuid(),
  "event_id"              UUID            NOT NULL,
  "event_type"            VARCHAR(40)     NOT NULL,
  "timestamp"             TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "user_id"               UUID            NOT NULL,
  "resource_type"         VARCHAR(40)     NOT NULL,
  "resource_id"           VARCHAR(64)     NOT NULL,
  "legal_basis"           VARCHAR(60)     NOT NULL,
  "actor"                 VARCHAR(40)     NOT NULL,
  "expires_at_original"   TIMESTAMPTZ(3),
  "resource_hash"         BYTEA,
  "resource_hash_algo"    VARCHAR(8)      NOT NULL DEFAULT 'sha256v1',
  "outcome"               VARCHAR(16)     NOT NULL,
  "error_code"            VARCHAR(80),
  "metadata"              JSONB,
  CONSTRAINT "audit_log_legal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_legal_event_id_key" UNIQUE ("event_id"),
  CONSTRAINT "audit_log_legal_event_type_check" CHECK (
    "event_type" IN (
      'purge_pending', 'purge_completed', 'purge_failed',
      'consent_given', 'consent_withdrawn',
      'dsar_request', 'dsar_fulfilled'
    )
  ),
  CONSTRAINT "audit_log_legal_actor_check" CHECK (
    "actor" IN ('cron_purge_worker', 'user_self_service', 'admin_panel')
  ),
  CONSTRAINT "audit_log_legal_outcome_check" CHECK (
    "outcome" IN ('success', 'failure')
  ),
  CONSTRAINT "audit_log_legal_legal_basis_format_check" CHECK (
    ("legal_basis"::text ~ '^[a-z_]+$'::text)
    AND (length("legal_basis"::text) >= 3)
    AND (length("legal_basis"::text) <= 60)
  ),
  CONSTRAINT "audit_log_legal_resource_hash_size_check" CHECK (
    "resource_hash" IS NULL OR octet_length("resource_hash") = 32
  ),
  CONSTRAINT "audit_log_legal_error_code_required_check" CHECK (
    ("outcome" = 'success') OR
    ("outcome" = 'failure' AND "error_code" IS NOT NULL)
  )
);
ALTER TABLE "audit_log_legal" SET (toast_tuple_target = 4096);
ALTER TABLE "audit_log_legal" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "idx_audit_log_legal_user_ts"          ON "audit_log_legal" ("user_id", "timestamp" DESC);
CREATE INDEX "idx_audit_log_legal_event_type_ts"    ON "audit_log_legal" ("event_type", "timestamp" DESC);
CREATE INDEX "idx_audit_log_legal_failures"         ON "audit_log_legal" ("timestamp" DESC) WHERE ("outcome" = 'failure');
CREATE INDEX "idx_audit_log_legal_hash_pending"     ON "audit_log_legal" ("resource_hash") WHERE ("event_type" IN ('purge_pending', 'purge_completed', 'purge_failed') AND "resource_hash" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- TRIGGER: audit_log_legal append-only enforcement (Card #150 fix-pack F-MED-01)
-- ----------------------------------------------------------------------------
-- Bloqueia UPDATE/DELETE em audit_log_legal (LGPD prova juridica intacta).
-- Excecao prevista: cron de retencao 5 anos (Card #152 futuro) com role dedicada.
CREATE OR REPLACE FUNCTION block_audit_log_legal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log_legal is append-only (LGPD prova juridica). UPDATE/DELETE proibidos. Cron de retencao 5 anos (Card #152) usa role dedicada com bypass explicito.'
    USING
      ERRCODE = 'insufficient_privilege',
      HINT = 'Para deletar registros expirados, use o cron #152 com role audit_legal_purge_role.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_legal_block_update
  BEFORE UPDATE ON "audit_log_legal"
  FOR EACH ROW EXECUTE FUNCTION block_audit_log_legal_mutation();
CREATE TRIGGER audit_log_legal_block_delete
  BEFORE DELETE ON "audit_log_legal"
  FOR EACH ROW EXECUTE FUNCTION block_audit_log_legal_mutation();
