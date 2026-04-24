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
