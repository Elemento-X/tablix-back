-- =============================================================================
-- Migration: card_146_fixpack_align_fhdl_with_file_history
-- Version: 20260518123000
-- Card: #146 (5.2b) F5 fix-pack ciclo 1
--
-- Contexto:
--   @dba ALTO #2 (fingerprint c2e8b4a9d7f1): CHECK fhdl_storage_path_format_check
--   NÃO foi atualizado para o regex endurecido aplicado em file_history pelo
--   fix-pack #145 F1 (migration 20260503150000). Drift entre 2 CHECKs que
--   deveriam ser idênticos:
--     - file_history (pós fix-pack #145): `(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])`
--       (datas válidas mês/dia)
--     - file_history_dead_letter (atual): `[0-9]{4}-[0-9]{2}-[0-9]{2}` (aceita
--       9999-99-99, defesa em profundidade quebrada)
--
--   @reviewer cross-check confirmou SEGUNDO drift: original_filename em
--   file_history (#145 fix-pack linha 53) inclui `\x7F` (DEL); fhdl atual
--   NÃO inclui. Inconsistência defensiva.
--
-- Comentário inline na migration 20260518120100 L102 AFIRMA "MESMO regex de
-- file_history (defesa em profundidade)" — documentação mentia.
--
-- Tabela está VAZIA em prod (Card #146 está em F5 pré-go-live, HISTORY_FEATURE_ENABLED=false).
-- ACCESS EXCLUSIVE lock no DROP+ADD CONSTRAINT é no-op porque sem rows.
--
-- Pattern: append-only migration (projeto padrão). NÃO rebase migration anterior.
-- =============================================================================

-- ===========================================
-- FIX 1: fhdl original_filename — incluir \x7F (DEL char)
-- ===========================================
-- Alinha com file_history pós fix-pack #145. Sem \x7F, filename com DEL passa
-- pela CHECK e pode causar confusão em log/display.

ALTER TABLE "file_history_dead_letter"
  DROP CONSTRAINT "fhdl_original_filename_check";

ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_original_filename_check"
  CHECK (
    length("original_filename") > 0
    AND "original_filename" !~ '[\x00-\x1F\x7F]'
  );

-- ===========================================
-- FIX 2: fhdl storage_path — endurecer regex de date pra month/day válidos
-- ===========================================
-- Alinha com file_history pós fix-pack #145. Sem isso, dead-letter aceita
-- paths com data `9999-99-99` (vindas de bug futuro no upload ou DB corrompido)
-- — defesa em profundidade quebrada.

ALTER TABLE "file_history_dead_letter"
  DROP CONSTRAINT "fhdl_storage_path_format_check";

ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_storage_path_format_check"
  CHECK (
    "storage_path" ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])/[a-z0-9]{7,64}\.(csv|xlsx|xls)$'
  );

-- ===========================================
-- FIX 3: COMMENT storage_path — alinhar com file_history
-- ===========================================

COMMENT ON COLUMN "file_history_dead_letter"."storage_path" IS
  'UserScopedPath: {userId-uuidv4}/{yyyy-mm-dd UTC com mes/dia validos}/{jobId-cuid 7-64 chars [a-z0-9]}.{ext: csv|xlsx|xls}. CRU (nao hash) - necessario pro retry weekly. Regex IDENTICO ao file_history (fix-pack alinhamento). Mitigacao PII: REDACT logs/Sentry + RLS DENY ALL.';

-- =============================================================================
-- ROLLBACK PLAN (improvável; tabela vazia + fix é endurecimento, nunca degrada)
-- =============================================================================
-- ALTER TABLE "file_history_dead_letter"
--   DROP CONSTRAINT "fhdl_storage_path_format_check";
-- ALTER TABLE "file_history_dead_letter"
--   ADD CONSTRAINT "fhdl_storage_path_format_check"
--   CHECK ("storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-z0-9]{7,64}\.(csv|xlsx|xls)$');
-- (idem para original_filename rollback)
