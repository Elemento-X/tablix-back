-- Migration: card11_fix_stripe_events_schema
-- Version: 20260411202424
-- Card: 1.1 (fix) — Schema corrections from @dba review
--
-- NOTA HISTORICA (retrofit 2026-04-19):
-- Esta migration foi originalmente aplicada via MCP apply_migration e
-- armazenada apenas em supabase_migrations.schema_migrations.
-- Arquivo criado retroativamente para versionamento em git (Card 2.4).
-- Conteudo identico ao registrado no banco.

-- Card 1.1 fix: schema corrections from @dba review
-- 1. CRITICO: processedAt TIMESTAMP -> TIMESTAMPTZ (timezone-aware)
-- 2. MEDIO: stripe_events.id TEXT -> VARCHAR(255) (bounded PK)
-- 3. MEDIO: index on processed_at for future cleanup queries
-- 4. BAIXO: drop redundant index on users.email (already has unique constraint)

-- Fix 1+2: Alter stripe_events columns
ALTER TABLE "stripe_events"
  ALTER COLUMN "id" TYPE VARCHAR(255),
  ALTER COLUMN "processed_at" TYPE TIMESTAMPTZ(3);

-- Fix 3: Index for retention/cleanup queries (non-concurrent, table is small)
CREATE INDEX IF NOT EXISTS "idx_stripe_events_processed_at"
  ON "stripe_events" ("processed_at");

-- Fix 4: Drop redundant email index (unique constraint already creates one)
DROP INDEX IF EXISTS "users_email_idx";
