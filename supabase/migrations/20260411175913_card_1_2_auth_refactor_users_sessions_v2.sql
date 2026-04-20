-- Migration: card_1_2_auth_refactor_users_sessions_v2
-- Version: 20260411175913
-- Card: 1.2 — Session-backed JWT auth refactor
--
-- NOTA HISTORICA (retrofit 2026-04-19):
-- Esta migration foi originalmente aplicada via MCP apply_migration e
-- armazenada apenas em supabase_migrations.schema_migrations.
-- Arquivo criado retroativamente para versionamento em git (Card 2.4).
-- Conteudo identico ao registrado no banco.

-- 1. Criar enum Role
CREATE TYPE "Role" AS ENUM ('FREE', 'PRO');

-- 2. Criar tabela users
CREATE TABLE "users" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "email" VARCHAR(255) NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'FREE',
  "stripe_customer_id" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");
CREATE INDEX "users_email_idx" ON "users"("email");

-- 3. Criar tabela sessions
CREATE TABLE "sessions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "fingerprint" VARCHAR(64),
  "user_agent" VARCHAR(512),
  "ip_address" VARCHAR(45),
  "refresh_token_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "idx_sessions_expires_at" ON "sessions"("expires_at");
CREATE INDEX "idx_sessions_revoked_at" ON "sessions"("revoked_at");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Alterar tokens: dropar colunas migradas pro User, adicionar user_id
ALTER TABLE "usage" DROP CONSTRAINT "usage_token_id_fkey";
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_token_id_fkey";
ALTER TABLE "tokens" DROP COLUMN "email";
ALTER TABLE "tokens" DROP COLUMN "stripe_customer_id";
ALTER TABLE "tokens" ADD COLUMN "user_id" TEXT NOT NULL DEFAULT '';
CREATE INDEX "idx_tokens_user" ON "tokens"("user_id");
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Alterar usage: token_id → user_id
DROP INDEX IF EXISTS "usage_token_id_period_key";
ALTER TABLE "usage" RENAME COLUMN "token_id" TO "user_id";
CREATE UNIQUE INDEX "usage_user_id_period_key" ON "usage"("user_id", "period");
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Alterar jobs: token_id → user_id
DROP INDEX IF EXISTS "jobs_token_id_idx";
DROP INDEX IF EXISTS "idx_jobs_status";
ALTER TABLE "jobs" RENAME COLUMN "token_id" TO "user_id";
CREATE INDEX "idx_jobs_user" ON "jobs"("user_id");
CREATE INDEX "idx_jobs_status" ON "jobs"("status");
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Limpar default temporário
ALTER TABLE "tokens" ALTER COLUMN "user_id" DROP DEFAULT;
