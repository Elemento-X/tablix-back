-- Migration: card_189_stripe_events_status_expand
-- Version: 20260621182500
-- Card: #189 — FIX CRÍTICO idempotência não-atômica do webhook Stripe
--
-- Contexto: o controller registrava event.id em stripe_events ANTES de processar
-- o handler. Falha transitória no handler → 500 → row já commitada → retry do
-- Stripe descartado como duplicata (P2002) → token nunca criado (cliente paga e
-- não recebe). Correção: idempotent receiver com status RECEIVED→PROCESSED
-- (Opção B, tiebreaker @reviewer; desenho de schema/lock por @dba).
--
-- Esta é a fase EXPAND (aditiva, forward+backward compatível com o código antigo).
-- O CUTOVER (deploy do código novo) e o CONTRACT (remoção do legado) seguem depois.
--
-- @owner: @dba
-- @card: #189
-- Aplicado via Supabase MCP em 2026-06-21 (stripe_events com 0 rows pré-go-live;
-- backfill é no-op no estado atual, mantido idempotente para ambientes com dados).

-- ============================================================================
-- DEPLOY 1 — EXPAND (transacional)
-- ============================================================================

-- status: default constante = metadata-only em PG11+ (sem table rewrite).
ALTER TABLE "stripe_events" ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'RECEIVED';

-- received_at: o que processed_at REALMENTE gravava (momento da recepção/gate).
ALTER TABLE "stripe_events" ADD COLUMN IF NOT EXISTS "received_at" TIMESTAMPTZ(3);

-- processed_at vira honesto: NULL enquanto RECEIVED, preenchido na transição PROCESSED.
ALTER TABLE "stripe_events" ALTER COLUMN "processed_at" DROP NOT NULL;
ALTER TABLE "stripe_events" ALTER COLUMN "processed_at" DROP DEFAULT;

-- CHECK como NOT VALID evita full scan sob ACCESS EXCLUSIVE; validado em seguida.
ALTER TABLE "stripe_events" DROP CONSTRAINT IF EXISTS "stripe_events_status_check";
ALTER TABLE "stripe_events"
  ADD CONSTRAINT "stripe_events_status_check" CHECK ("status" IN ('RECEIVED','PROCESSED')) NOT VALID;

-- Backfill: discrimina por processed_at populado (rows do mundo antigo = terminais).
UPDATE "stripe_events" SET "received_at" = "processed_at" WHERE "received_at" IS NULL;
UPDATE "stripe_events" SET "status" = 'PROCESSED' WHERE "status" = 'RECEIVED' AND "processed_at" IS NOT NULL;

-- VALIDATE separado (SHARE UPDATE EXCLUSIVE — permite reads+writes, sem outage).
ALTER TABLE "stripe_events" VALIDATE CONSTRAINT "stripe_events_status_check";

-- ============================================================================
-- Índice parcial — aplicado SEPARADO via MCP (CONCURRENTLY não roda em transação).
-- Varre eventos RECEIVED travados/in-flight (observabilidade + reconciliação).
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stripe_events_pending
--   ON stripe_events (received_at) WHERE status = 'RECEIVED';
-- ============================================================================

-- ============================================================================
-- DEPLOY 3 — CONTRACT (NÃO executar agora; só após dias de observação estável
-- do código novo. Ponto de não-retorno). Executar fora de transação.
--
-- IMPORTANTE (@dba MÉDIO Card #189): rows inseridas pelo código ANTIGO na janela
-- EXPAND→cutover têm received_at NULL (coluna nullable sem default, código antigo
-- não a preenche). O SET NOT NULL falha (23502) se houver qualquer NULL. Logo:
--   -- 1) Re-backfill dos NULLs residuais ANTES do SET NOT NULL:
--   UPDATE stripe_events SET received_at = COALESCE(received_at, processed_at, now())
--     WHERE received_at IS NULL;
--   -- 2) SET NOT NULL sem full scan (PG12+: CHECK NOT VALID → VALIDATE → SET NOT NULL):
--   ALTER TABLE stripe_events ADD CONSTRAINT received_at_nn CHECK (received_at IS NOT NULL) NOT VALID;
--   ALTER TABLE stripe_events VALIDATE CONSTRAINT received_at_nn;
--   ALTER TABLE stripe_events ALTER COLUMN received_at SET NOT NULL;
--   ALTER TABLE stripe_events DROP CONSTRAINT received_at_nn;
--   -- 3) Default + troca do índice legado:
--   ALTER TABLE stripe_events ALTER COLUMN received_at SET DEFAULT now();
--   DROP INDEX CONCURRENTLY IF EXISTS idx_stripe_events_processed_at;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stripe_events_received_at ON stripe_events (received_at);
-- ============================================================================

-- ============================================================================
-- ROLLBACK (EXPAND é backward-compat: reverter o CÓDIGO basta; o schema expandido
-- não precisa ser tocado). Down só se necessário, e SOMENTE antes do cutover —
-- após o código novo inserir rows com processed_at NULL, o SET NOT NULL falharia:
--   ALTER TABLE stripe_events DROP CONSTRAINT IF EXISTS stripe_events_status_check;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_stripe_events_pending;
--   ALTER TABLE stripe_events DROP COLUMN IF EXISTS status;
--   ALTER TABLE stripe_events DROP COLUMN IF EXISTS received_at;
--   ALTER TABLE stripe_events ALTER COLUMN processed_at SET DEFAULT now();
--   ALTER TABLE stripe_events ALTER COLUMN processed_at SET NOT NULL;
-- ============================================================================
