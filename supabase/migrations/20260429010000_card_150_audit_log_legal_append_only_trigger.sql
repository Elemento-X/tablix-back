-- =============================================================================
-- Migration: card_150_audit_log_legal_append_only_trigger
-- Version: 20260429010000
-- Card: #150 (pVasIL6l) — Fase 5 — Storage (fix-pack pos-pipeline)
--
-- Contexto:
--   @security pipeline ciclo 1 (2026-04-28) finding F-MED-01:
--   audit_log_legal eh append-only por DESIGN (audit forense, prova LGPD)
--   mas nada no DB enforça isso. RLS + zero policies bloqueia non-superuser,
--   mas service_role tem permissao total. Bug em cron #152 (DELETE WHERE
--   timestamp < ?) com calculo errado de "5 anos" apaga prova juridica
--   silenciosamente. Compromisso de service_role permite ataque destrutivo.
--
--   Baseline LGPD: NIST 800-53 AU-9 + ISO 27001 A.12.4.2 — audit trail
--   protegido contra modificacao nao-autorizada.
--
-- Design:
--   Trigger BEFORE UPDATE OR DELETE bloqueia em SQL, fazendo RAISE EXCEPTION
--   com mensagem clara. Service role NAO bypassa triggers (so RLS).
--
--   Excecao prevista: cron de retencao 5 anos (Card #152) que precisara de
--   DELETE legitimo. Solucao: role dedicada `audit_legal_purge_role` com
--   permissao via `SET LOCAL session_authorization` no proprio cron, ou
--   via funcao SECURITY DEFINER. NAO escopo deste card — Card #152 implementa
--   o caminho de purga 5 anos com a barreira correta. Ate la, append-only
--   absoluto eh a postura mais segura.
--
-- @owner: @security + @dba
-- =============================================================================

-- ===========================================
-- TRIGGER append-only enforcement
-- ===========================================

CREATE OR REPLACE FUNCTION block_audit_log_legal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log_legal is append-only (LGPD prova juridica). UPDATE/DELETE proibidos. Cron de retencao 5 anos (Card #152) usa role dedicada com bypass explicito.'
    USING
      ERRCODE = 'insufficient_privilege',
      HINT = 'Para deletar registros expirados, use o cron #152 com role audit_legal_purge_role.';
END;
$$ LANGUAGE plpgsql;

-- Idempotente: DROP IF EXISTS + CREATE
DROP TRIGGER IF EXISTS audit_log_legal_block_update ON "audit_log_legal";
CREATE TRIGGER audit_log_legal_block_update
  BEFORE UPDATE ON "audit_log_legal"
  FOR EACH ROW
  EXECUTE FUNCTION block_audit_log_legal_mutation();

DROP TRIGGER IF EXISTS audit_log_legal_block_delete ON "audit_log_legal";
CREATE TRIGGER audit_log_legal_block_delete
  BEFORE DELETE ON "audit_log_legal"
  FOR EACH ROW
  EXECUTE FUNCTION block_audit_log_legal_mutation();

COMMENT ON FUNCTION block_audit_log_legal_mutation() IS
  'Card #150 fix-pack: enforça append-only em audit_log_legal (LGPD/NIST AU-9). Bypass legitimo via role dedicada do cron #152 (futuro).';

-- =============================================================================
-- ROLLBACK PLAN (manual)
-- =============================================================================
--   DROP TRIGGER IF EXISTS audit_log_legal_block_update ON "audit_log_legal";
--   DROP TRIGGER IF EXISTS audit_log_legal_block_delete ON "audit_log_legal";
--   DROP FUNCTION IF EXISTS block_audit_log_legal_mutation();
-- =============================================================================
