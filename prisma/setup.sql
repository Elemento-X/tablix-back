-- ===========================================
-- TABLIX BACKEND - SETUP DO BANCO DE DADOS
-- Execute este SQL no SQL Editor do Supabase
-- ===========================================

-- Criar ENUMs
CREATE TYPE "Plan" AS ENUM ('PRO');
CREATE TYPE "TokenStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- Tabela de Tokens (acesso Pro)
CREATE TABLE "tokens" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "token" VARCHAR(64) UNIQUE NOT NULL,
    "fingerprint" VARCHAR(64),
    "stripe_customer_id" VARCHAR(255) NOT NULL,
    "stripe_subscription_id" VARCHAR(255),
    "plan" "Plan" NOT NULL DEFAULT 'PRO',
    "status" "TokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "email" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3)
);

-- Tabela de Usage (uso mensal)
CREATE TABLE "usage" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "token_id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "unifications_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE("token_id", "period")
);

-- Tabela de Jobs (processamento assíncrono)
CREATE TABLE "jobs" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "token_id" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "input_files" JSONB NOT NULL,
    "output_file_url" VARCHAR(500),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "jobs_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Índices
CREATE INDEX "idx_tokens_token" ON "tokens"("token");
CREATE INDEX "idx_tokens_fingerprint" ON "tokens"("fingerprint");
CREATE INDEX "idx_tokens_stripe_customer" ON "tokens"("stripe_customer_id");
CREATE INDEX "idx_usage_token_period" ON "usage"("token_id", "period");
CREATE INDEX "idx_jobs_status" ON "jobs"("status");
