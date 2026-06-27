-- =============================================================================
-- Card 7.12 (#89) — audit_log: partial index (actor, created_at) WHERE actor IS NOT NULL
-- Fase 7 — Infra & Deploy (HARDENING/BAIXO)
-- =============================================================================
-- Problema: o índice idx_audit_log_actor_created_at (actor, created_at DESC) NÃO
-- era parcial. Como `actor` é nullable (webhooks antes de resolver o user), as
-- entries com actor IS NULL poluíam o índice sem valor — queries forenses são
-- sempre "por actor X" (actor específico), nunca "actor IS NULL".
--
-- Expand-contract:
--   EXPAND  → cria idx_audit_log_actor_created (parcial, WHERE actor IS NOT NULL)
--   CONTRACT→ dropa idx_audit_log_actor_created_at (antigo, não-parcial)
--
-- IMPORTANTE: CONCURRENTLY NÃO roda em transação. Aplicado em prod via MCP
-- execute_sql (single-statement, autocommit) — apply_migration (que envolve em tx)
-- FALHARIA. Este arquivo é a SSOT versionada; idempotente (IF NOT EXISTS / IF EXISTS).
--
-- Validação (prod, 2026-06-27): índice indisvalid=true/indisready=true; EXPLAIN de
-- `WHERE actor = $1 ORDER BY created_at DESC LIMIT 50` → Index Scan using
-- idx_audit_log_actor_created (com enable_seqscan=off; tabela vazia pré-go-live).
--
-- @owner: @dba | @card: 7.12 (#89)
-- =============================================================================

-- EXPAND
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_actor_created
  ON public.audit_log (actor, created_at DESC)
  WHERE actor IS NOT NULL;

-- CONTRACT (após validar o novo via EXPLAIN)
DROP INDEX CONCURRENTLY IF EXISTS public.idx_audit_log_actor_created_at;
