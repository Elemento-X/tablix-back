-- Migration: card_6_7_jobs_cleanup_indexes
-- Version: 20260622120000
-- Card: #6.7 — índices parciais para os crons de cleanup async + sweeper #197.
--
-- ARTEFATO DE 1ª CLASSE (mesma disciplina do idx_jobs_expires_at do 6.3): os
-- índices vivem como DDL versionado e rastreável, NÃO como comentário. CI /
-- disaster-recovery que reconstrói o schema a partir das migrations precisa
-- deles — sem eles, os crons do 6.7 viram seq scan na tabela jobs inteira.
--
-- POR QUE STATEMENTS SEPARADOS / FORA DE TRANSAÇÃO: `CREATE INDEX CONCURRENTLY`
-- NÃO roda dentro de bloco de transação (erro 25001) e o runner de migration
-- (Supabase MCP apply_migration) envolve a migration numa transação. Portanto
-- CADA statement abaixo DEVE ser aplicado via `execute_sql` como STATEMENT
-- ÚNICO, sem SET prévio (ver memória do projeto: feedback_execute_sql_concurrently).
-- Idempotentes (IF NOT EXISTS) e seguros pra reaplicar.
--
-- SHAPE validado pelo @dba no pipeline. Parciais pra manter o índice pequeno e
-- só sobre as linhas que cada cron varre:
--
--   1. idx_jobs_pending_created  → sweeper #197: WHERE status='PENDING'
--      AND created_at < (now() - sweep_limiar). PENDING órfão da fila.
--   2. idx_jobs_processing_started → force-fail 6.7b: WHERE status='PROCESSING'
--      AND started_at < (now() - stuck_limiar). Job travado.
--   3. idx_jobs_inputs_unpurged → cleanup 6.7a (inputs): WHERE status IN
--      ('COMPLETED','FAILED') AND inputs_purged_at IS NULL. Resíduo de PII.
--      Predicado inclui status (fix-pack @dba/@performance BAIXO): sem ele o
--      índice abrangia TODO job não-purgado (PENDING/PROCESSING também) e o
--      status virava recheck de heap + bloat. Com status no predicado, o índice
--      cobre estritamente o conjunto de purga.
--   4. idx_jobs_outputs_purgeable → cleanup 6.7a (outputs): WHERE downloaded_at
--      IS NULL AND output_file_url IS NOT NULL (fix-pack @dba MÉDIO). Índice
--      DEDICADO em vez de reusar idx_jobs_expires_at (Card 6.3): aquele só tem
--      predicado `expires_at IS NOT NULL` e NÃO encolhe — linhas baixadas/
--      tombstonadas permaneciam, e o scan de outputs degradava O(histórico). Este
--      encolhe via download/tombstone → scan O(pendentes reais).
--
-- @owner: @dba
-- @card: #6.7
-- Aplicação: Supabase MCP execute_sql (cada CREATE INDEX como single-statement, fora de transação).

-- 1) Sweeper #197 — PENDING órfão da fila (varre por idade de criação).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_pending_created
  ON jobs (created_at) WHERE status = 'PENDING';

COMMENT ON INDEX idx_jobs_pending_created IS
  'Index parcial pro sweeper #197 (PENDING orfao da fila, varre por created_at). Card #6.7.';

-- 2) Force-fail 6.7b — PROCESSING travado (varre por started_at).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_processing_started
  ON jobs (started_at) WHERE status = 'PROCESSING';

COMMENT ON INDEX idx_jobs_processing_started IS
  'Index parcial pro force-fail 6.7b (PROCESSING travado, varre por started_at). Card #6.7.';

-- 3) Cleanup 6.7a (inputs) — terminais com inputs ainda nao purgados (M-03).
--    Partial sobre status terminal + inputs_purged_at IS NULL; ordena por
--    completed_at (FIFO de purga). status no predicado evita bloat (fix-pack @dba).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_inputs_unpurged
  ON jobs (completed_at)
  WHERE status IN ('COMPLETED', 'FAILED') AND inputs_purged_at IS NULL;

COMMENT ON INDEX idx_jobs_inputs_unpurged IS
  'Index parcial pro cleanup 6.7a (inputs de terminais nao purgados, M-03). Card #6.7.';

-- 4) Cleanup 6.7a (outputs) — expirados nao baixados com output presente.
--    Encolhe via downloaded_at/tombstone (output_file_url NULL) → scan O(pendentes).
--    expires_at como chave de range/ORDER BY (fix-pack @dba MÉDIO).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_outputs_purgeable
  ON jobs (expires_at)
  WHERE downloaded_at IS NULL AND output_file_url IS NOT NULL;

COMMENT ON INDEX idx_jobs_outputs_purgeable IS
  'Index parcial pro cleanup 6.7a (outputs expirados nao baixados). Card #6.7.';

-- ROLLBACK (fora de transação, cada um single-statement):
--   DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_pending_created;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_processing_started;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_inputs_unpurged;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_outputs_purgeable;
