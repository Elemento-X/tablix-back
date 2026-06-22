-- Migration: card_6_3_jobs_expires_idx
-- Version: 20260621232846
-- Card: #6.3 — índice parcial de expiração da tabela jobs.
--
-- ARTEFATO DE 1ª CLASSE (M-02 @dba/@reviewer): este índice ANTES vivia como
-- COMENTÁRIO dentro da migration EXPAND (card_6_3_jobs_async_expand). Comentário
-- não é recriado por CI / disaster-recovery que reconstrói o schema a partir das
-- migrations — o cleanup 6.7 viraria seq scan num ambiente restaurado. Promovido
-- a migration própria pra ter o DDL versionado e rastreável.
--
-- POR QUE ARQUIVO SEPARADO: `CREATE INDEX CONCURRENTLY` NÃO roda dentro de um
-- bloco de transação (erro 25001). O runner de migration do projeto (Supabase
-- MCP `apply_migration`) envolve cada migration numa transação — então este
-- statement DEVE ser aplicado via `execute_sql` como STATEMENT ÚNICO, sem SET
-- prévio (ver memória do projeto: feedback_execute_sql_concurrently). Mantido
-- aqui isolado, idempotente (IF NOT EXISTS) e seguro pra reaplicar.
--
-- Parcial: só jobs async com TTL (expires_at não nulo) entram — exclui linhas
-- do caminho sync. Suporta o range scan do cleanup 6.7: WHERE expires_at < now().
--
-- @owner: @dba
-- @card: #6.3
-- Aplicação: Supabase MCP execute_sql (single-statement, fora de transação).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_expires_at
  ON jobs (expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON INDEX idx_jobs_expires_at IS
  'Index parcial pro cleanup 6.7 (varre jobs async expirados). Card #6.3.';

-- ROLLBACK (fora de transação):
--   DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_expires_at;
