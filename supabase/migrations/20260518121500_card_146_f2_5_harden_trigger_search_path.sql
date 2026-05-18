-- =============================================================================
-- Migration: card_146_f2_5_harden_trigger_search_path
-- Version: 20260518121500
-- Card: #146 (5.2b) F2.5 fix-pack
--
-- Contexto:
--   Após apply de 20260518120100_card_146_f2_5_add_file_history_dead_letter,
--   `get_advisors security_lint` retornou 1 WARN:
--     function_search_path_mutable em block_file_history_dead_letter_delete
--
-- Hardening: SET search_path explícito ancora a resolução de objetos pra
--   pg_catalog,public — mitiga vetor onde role hostil injeta objetos no
--   search_path (ex: tabela maliciosa) e a função as resolveria.
--
-- Refs:
-- - https://supabase.com/docs/guides/database/database-linter?lint=0011
-- - Pattern recomendado pelo Supabase database linter
--
-- NOTA: função `block_audit_log_legal_mutation` (Card #150) tem o mesmo WARN
--       e NÃO foi tocada aqui (fora de escopo). Discovery card endereça.
-- =============================================================================

CREATE OR REPLACE FUNCTION "block_file_history_dead_letter_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    'file_history_dead_letter is delete-protected (prova juridica LGPD). Use cron de retencao 5 anos com role dedicada (Card LGPD-AUDIT futuro).'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
