-- =============================================================================
-- Migration: card_145_f1_fix_pack_findings
-- Version: 20260503150000
-- Card: #145 (DtBkVtVY) — Fase 5 — Storage (5.2a) — F1 fix-pack
--
-- Origem: Pipeline QA F1.1 (2026-05-03) — fix-pack atomic dos findings BAIXO
-- de @security + @dba antes de mergear F1.
--
-- Findings cobertos:
--
-- @security F-LOW-01 (BAIXO, fingerprint 8c91ad27e441):
--   CHECK original_filename rejeita \x00-\x1F mas NÃO 0x7F (DEL).
--   Inconsistência com key-builder Card 5.1 que rejeita 0x7F.
--   Fix: ampliar regex pra '[\x00-\x1F\x7F]'.
--
-- @security F-LOW-02 (BAIXO, fingerprint 2e7a4f0cd9b1):
--   CHECK storage_path regex aceita data inválida tipo 9999-99-99.
--   Fix: endurecer regex pra YYYY-(01-12)-(01-31).
--   (Calendar-correct dates tipo 2026-02-29 não-bissexto NÃO são bloqueados —
--   regex 100% calendar-aware seria monstrosa; key-builder usa Date.UTC*
--   nativos que nunca emitem inválido por construção. Trade-off aceito.)
--
-- @dba F-LOW-01 (BAIXO, fingerprint dba:schema-design:storage_path:jobid):
--   COMMENT ON COLUMN storage_path desatualizado (cita "jobId-uuid" mas
--   regex aceita cuid). Fix: alinhar comment com formato real.
--
-- DECISÃO: APPEND-ONLY migration pattern (mesmo de fix-packs anteriores —
--   ver memory project_lgpd_fixpack_done, project_sidequest_pack_done).
--   Não editar migration original (já aplicada). DROP CHECK + ADD CHECK
--   é instantâneo em tabela vazia (acquire ACCESS EXCLUSIVE no-op).
--
-- Findings NÃO endereçados aqui (vão pra cards descoberta no Backlog):
--   - @security F-MED-01: cap por user em rows (aceito por design — depende
--     do cron #146 + monitoring em Sentry; vira card discovery)
--   - @dba F-LOW-02: FK Cascade chunked delete pós-go-live (vira runbook
--     pre-Fase 9 em card discovery)
--   - @tester F-MED-01: rollback untested (vira card discovery)
--
-- @owner: @dba + @security
-- =============================================================================

-- ===========================================
-- FIX 1: original_filename — incluir 0x7F (DEL) na blacklist
-- ===========================================

ALTER TABLE "file_history"
  DROP CONSTRAINT "file_history_original_filename_check";

ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_original_filename_check"
  CHECK (
    length("original_filename") > 0
    AND "original_filename" !~ '[\x00-\x1F\x7F]'
  );

-- ===========================================
-- FIX 2: storage_path — endurecer regex de date pra month/day válidos
-- ===========================================

ALTER TABLE "file_history"
  DROP CONSTRAINT "file_history_storage_path_format_check";

ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_storage_path_format_check"
  CHECK ("storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])/[a-z0-9]{7,64}\.(csv|xlsx|xls)$');

-- ===========================================
-- FIX 3: COMMENT storage_path — alinhar com formato real (jobId é cuid, não UUID)
-- ===========================================

COMMENT ON COLUMN "file_history"."storage_path" IS
  'UserScopedPath: {userId-uuidv4}/{yyyy-mm-dd UTC}/{jobId-cuid 7-64 chars [a-z0-9]}.{ext: csv|xlsx|xls}. UNIQUE bloqueia overwrite silencioso. Format CHECK valida regex.';

-- =============================================================================
-- ROLLBACK PLAN
-- =============================================================================
-- Reverso instantâneo (tabela vazia):
--
--   ALTER TABLE "file_history"
--     DROP CONSTRAINT "file_history_original_filename_check";
--   ALTER TABLE "file_history"
--     ADD CONSTRAINT "file_history_original_filename_check"
--     CHECK (length("original_filename") > 0 AND "original_filename" !~ '[\x00-\x1F]');
--
--   ALTER TABLE "file_history"
--     DROP CONSTRAINT "file_history_storage_path_format_check";
--   ALTER TABLE "file_history"
--     ADD CONSTRAINT "file_history_storage_path_format_check"
--     CHECK ("storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-z0-9]{7,64}\.(csv|xlsx|xls)$');
--
--   COMMENT ON COLUMN "file_history"."storage_path" IS
--     'UserScopedPath: <userId-uuid>/<jobId-uuid>.<ext>. UNIQUE bloqueia overwrite silencioso no Supabase Storage. Format check via regex.';
-- =============================================================================
