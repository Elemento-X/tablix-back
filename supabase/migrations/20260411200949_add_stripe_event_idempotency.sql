-- Migration: add_stripe_event_idempotency
-- Version: 20260411200949
-- Card: 1.1 — Webhook idempotency
--
-- NOTA HISTORICA (retrofit 2026-04-19):
-- Esta migration foi originalmente aplicada via MCP apply_migration e
-- armazenada apenas em supabase_migrations.schema_migrations.
-- Arquivo criado retroativamente para versionamento em git (Card 2.4).
-- Conteudo identico ao registrado no banco.

-- Card 1.1: Idempotencia do webhook Stripe
-- Tabela de eventos processados para deduplicacao
CREATE TABLE "stripe_events" (
    "id" TEXT PRIMARY KEY,
    "type" VARCHAR(255) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique compound no Token: previne duplicata de token para mesmo user+subscription
ALTER TABLE "tokens" ADD CONSTRAINT "uq_tokens_user_subscription" UNIQUE ("user_id", "stripe_subscription_id");
