-- =============================================================================
-- Migration: card_146_fixpack_add_reconcile_index
-- Version: 20260518124000
-- Card: #146 (5.2b) F5 fix-pack ciclo 1
--
-- Contexto:
--   @dba ALTO #3 (fingerprint d4f8a1c7e2b6): a Fase C (reconciliação) do
--   handler purgeExpiredFiles consulta:
--     WHERE deleted_at IS NOT NULL
--       AND deleted_at < (NOW() - INTERVAL '1 hour')
--       AND purge_attempts < 5
--     ORDER BY deleted_at ASC
--     LIMIT 500
--     FOR UPDATE SKIP LOCKED
--
--   Índices existentes em file_history:
--     - idx_filehistory_expires_active (expires_at) WHERE deleted_at IS NULL
--       → cobre Fase A, NÃO cobre Fase C (filtro inverso de deleted_at)
--     - idx_filehistory_purge_pending (deleted_at) WHERE deleted_at IS NOT NULL
--       → cobre parcialmente Fase C, MAS:
--         (a) Sem INCLUDE (purge_attempts), planner faz Index Scan + heap fetch
--             + filter — degrada com volume (>4k rows pendentes).
--         (b) FOR UPDATE SKIP LOCKED pega rows que não satisfazem o filter no
--             planner — desperdiça ciclos de lock acquisition.
--
-- Solução: INDEX PARTIAL covering específico pra Fase C.
--   - WHERE clause estreita (`deleted_at IS NOT NULL AND purge_attempts < 5`)
--     reduz cardinalidade (~5% volume esperado).
--   - INCLUDE (purge_attempts) habilita Index-Only-Scan — planner pula heap
--     pra verificar filter, lock acquisition é covering.
--
-- Notas operacionais:
--   - Tabela file_history está VAZIA em prod (HISTORY_FEATURE_ENABLED=false
--     ainda — pré-go-live). CONCURRENTLY no-op porque sem rows a re-indexar.
--   - Migration usa CREATE INDEX inline (sem CONCURRENTLY) — instantâneo em
--     tabela vazia. Aplicação via MCP apply_migration (transação implícita
--     funciona porque NÃO é CONCURRENTLY).
--   - Futuro: índice novo em file_history populada DEVE usar CONCURRENTLY em
--     migration separada via psql direto (memory feedback_execute_sql_concurrently
--     — MCP gera erro 25001 com SET prévio).
--
-- Pattern: append-only migration.
-- =============================================================================

-- Index PARTIAL covering pra Fase C reconciliação do retention.job.
-- Suporta: SELECT FOR UPDATE SKIP LOCKED com filtro `deleted_at < X AND purge_attempts < 5`
-- ORDER BY deleted_at ASC LIMIT 500. INCLUDE habilita Index-Only-Scan.
CREATE INDEX "idx_filehistory_reconcile"
  ON "file_history" ("deleted_at")
  INCLUDE ("purge_attempts")
  WHERE "deleted_at" IS NOT NULL AND "purge_attempts" < 5;

COMMENT ON INDEX "idx_filehistory_reconcile" IS
  'Card #146 fix-pack ciclo 1 (@dba ALTO #3). Hot path da Fase C reconciliacao do retention.job: FOR UPDATE SKIP LOCKED em rows com deleted_at antigo + purge_attempts < 5. PARTIAL+INCLUDE pra Index-Only-Scan.';
