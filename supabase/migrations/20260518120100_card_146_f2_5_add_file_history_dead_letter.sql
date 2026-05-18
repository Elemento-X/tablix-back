-- =============================================================================
-- Migration: card_146_f2_5_add_file_history_dead_letter
-- Version: 20260518120100
-- Card: #146 (FK94hRBQ) — Fase 5 — Storage
--
-- Contexto:
--   Tabela `file_history_dead_letter` recebe rows de `file_history` cujo
--   `purge_attempts >= 5` (Storage delete falhou 5x). Cron weekly
--   `dead-letter-reprocess` tenta novamente até 3x; após isso requer
--   intervenção humana via alerta Sentry CRITICAL.
--
--   AMB-4 = C escolhida pelo operador em 2026-05-18 (override da recomendação
--   @planner B). Separa fluxo degradado da tabela operacional file_history.
--
-- Plano completo: .claude/plans/2026-05-18-card-146-5.2b-cron-purge-two-phase.md
--
-- DECISÕES IRREVERSÍVEIS (consultar plano + relatório @dba antes de mudar):
--
-- (Trade-off 2) id próprio UUID (NÃO reutiliza file_history.id). file_history.id
--       pode ter sido cascateado e desaparecido após move. UNIQUE PARTIAL em
--       original_file_history_id WHERE resolved_at IS NULL preserva
--       invariante "1 row ATIVO por origem". Reuse poderia colidir em
--       cenários edge (admin marca ignore + cron tenta mover de novo).
--
-- (Trade-off 3) user_id SEM FK física. INTENCIONAL. Pattern audit_log_legal
--       D-5: dead-letter é prova jurídica de tentativa de purga e DEVE
--       sobreviver ao delete do user. Mitigação LGPD: job
--       `dead-letter-anonymization-on-user-delete` (Card #178 Backlog, Fase 7)
--       atualizará original_filename pra '[anonymized-after-user-delete]'
--       quando trigger AFTER DELETE em users disparar.
--
-- (Trade-off 4) storage_path armazenado CRU (não hash). Necessário pro retry
--       (cron weekly precisa do path literal pra chamar Supabase delete).
--       Mitigação: REDACT no logger pino + RLS DENY ALL + CHECK regex strict.
--
-- (Trade-off 5) Retenção 5 ANOS alinhado com audit_log_legal. Dead-letter é
--       prova juridica de tentativa de purga (Art. 16 cumprimento de
--       obrigação). Job de purga futuro via Card LGPD-AUDIT com role dedicada
--       (mesmo pattern Card #152 audit_legal_purge_role).
--
-- (Trade-off 6) Trigger BEFORE DELETE bloqueando hard-delete (pattern
--       Card #150 audit_log_legal). Service_role bypassa RLS — DELETE rogue
--       elimina trail forense. UPDATE permitido (cron weekly precisa
--       atualizar reprocess_count + resolved_at).
--
-- Hard requirements consolidados (relatório @dba 2026-05-18):
--   - 10 CHECK constraints (regex storage_path espelhado de file_history)
--   - 4 índices (2 partial + 1 audit + 1 UNIQUE partial)
--   - RLS service-role only
--   - Trigger BEFORE DELETE raise exception
-- =============================================================================

CREATE TABLE "file_history_dead_letter" (
  "id"                            UUID            NOT NULL DEFAULT gen_random_uuid(),
  "original_file_history_id"      UUID            NOT NULL,
  "user_id"                       UUID            NOT NULL,
  "storage_path"                  VARCHAR(255)    NOT NULL,
  "original_filename"             VARCHAR(255)    NOT NULL,
  "mime_type"                     VARCHAR(127)    NOT NULL,
  "file_size"                     INTEGER         NOT NULL,
  "expires_at"                    TIMESTAMPTZ(3)  NOT NULL,
  "deleted_at"                    TIMESTAMPTZ(3)  NOT NULL,
  "purge_attempts"                INTEGER         NOT NULL,
  "last_error_code"               VARCHAR(80)     NOT NULL,
  "last_error_message"            VARCHAR(500),
  "moved_to_dead_letter_at"       TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reprocess_count"               SMALLINT        NOT NULL DEFAULT 0,
  "last_reprocess_attempt_at"     TIMESTAMPTZ(3),
  "last_reprocess_error_code"     VARCHAR(80),
  "last_reprocess_error_message"  VARCHAR(500),
  "resolved_at"                   TIMESTAMPTZ(3),
  "resolution_type"               VARCHAR(32),
  "created_at"                    TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "file_history_dead_letter_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "file_history_dead_letter" SET (toast_tuple_target = 4096);

COMMENT ON TABLE "file_history_dead_letter" IS
  'Quarentena de rows file_history que falharam purge 5x (Card #146 F2.5). Retenção 5 anos alinhado audit_log_legal. DELETE bloqueado via trigger.';
COMMENT ON COLUMN "file_history_dead_letter"."user_id" IS
  'SEM FK pra users.id (D-5 audit_log_legal). Dead-letter sobrevive ao delete do user — prova jurídica. Anonimização via Card #178 (Fase 7).';
COMMENT ON COLUMN "file_history_dead_letter"."storage_path" IS
  'Path CRU (não hash) — necessário pro retry. Mitigação: REDACT em logs/Sentry + RLS DENY ALL + CHECK regex strict.';
COMMENT ON COLUMN "file_history_dead_letter"."original_file_history_id" IS
  'FK lógica sem física (file_history.id pode ter sido hard-deletado). UNIQUE PARTIAL em (original_file_history_id) WHERE resolved_at IS NULL garante 1 ativo/origem.';

-- ===== CHECK constraints =====

-- (1) file_size > 0 AND <= 100MB (espelha file_history).
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_file_size_positive_check"
  CHECK ("file_size" > 0 AND "file_size" <= 104857600);

-- (2) purge_attempts >= 5 (entrou aqui = atingiu threshold).
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_purge_attempts_threshold_check"
  CHECK ("purge_attempts" >= 5);

-- (3) storage_path: MESMO regex de file_history (defesa em profundidade).
--     Pattern Tablix: {userId-uuid-v4}/{yyyy-mm-dd}/{cuid 7-64}.{csv|xlsx|xls}
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_storage_path_format_check"
  CHECK ("storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-z0-9]{7,64}\.(csv|xlsx|xls)$');

-- (4) mime_type não vazio.
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_mime_type_nonempty_check"
  CHECK (length("mime_type") > 0);

-- (5) original_filename não vazio + sem control chars.
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_original_filename_check"
  CHECK (
    length("original_filename") > 0
    AND "original_filename" !~ '[\x00-\x1F]'
  );

-- (6) reprocess_count: 0-3. Após 3, alerta Sentry CRITICAL + intervenção humana.
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_reprocess_count_check"
  CHECK ("reprocess_count" BETWEEN 0 AND 3);

-- (7) Invariante temporal: deleted_at <= moved_to_dead_letter_at <= last_reprocess_attempt_at <= resolved_at.
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_timing_consistency_check"
  CHECK (
    "deleted_at" <= "moved_to_dead_letter_at"
    AND ("last_reprocess_attempt_at" IS NULL OR "last_reprocess_attempt_at" >= "moved_to_dead_letter_at")
    AND ("resolved_at" IS NULL OR ("last_reprocess_attempt_at" IS NOT NULL AND "resolved_at" >= "last_reprocess_attempt_at"))
  );

-- (8) reprocess consistency: reprocess_count > 0 → last_reprocess_attempt_at NOT NULL.
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_reprocess_consistency_check"
  CHECK (
    ("reprocess_count" = 0 AND "last_reprocess_attempt_at" IS NULL) OR
    ("reprocess_count" > 0 AND "last_reprocess_attempt_at" IS NOT NULL)
  );

-- (9) resolution_type só com resolved_at NOT NULL (e vice-versa).
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_resolution_consistency_check"
  CHECK (
    ("resolved_at" IS NULL AND "resolution_type" IS NULL) OR
    ("resolved_at" IS NOT NULL AND "resolution_type" IS NOT NULL)
  );

-- (10) Whitelist resolution_type.
ALTER TABLE "file_history_dead_letter"
  ADD CONSTRAINT "fhdl_resolution_type_check"
  CHECK ("resolution_type" IS NULL OR "resolution_type" IN (
    'cron_reprocess_success',     -- cron weekly conseguiu deletar
    'admin_manual_delete',        -- admin via runbook
    'admin_manual_ignore',        -- admin marcou como "objeto inexistente, OK"
    'storage_already_gone'        -- 404 confirmado, idempotência
  ));

-- ===== Índices =====

-- (1) Hot path do cron weekly dead-letter-reprocess:
--     SELECT ... WHERE resolved_at IS NULL AND reprocess_count < 3
--     ORDER BY moved_to_dead_letter_at ASC LIMIT 100
--     PARTIAL = volume só dos "ativos".
CREATE INDEX "idx_fhdl_reprocess_candidates"
  ON "file_history_dead_letter" ("moved_to_dead_letter_at" ASC)
  WHERE "resolved_at" IS NULL AND "reprocess_count" < 3;

-- (2) PARTIAL: "investigação humana obrigatória" (reprocess_count >= 3).
--     Alerta Sentry CRITICAL aponta pra esse índice via admin endpoint futuro.
CREATE INDEX "idx_fhdl_human_required"
  ON "file_history_dead_letter" ("moved_to_dead_letter_at" DESC)
  WHERE "resolved_at" IS NULL AND "reprocess_count" >= 3;

-- (3) Audit/forense: "quais arquivos do user X foram dead-lettered?"
--     Query LGPD em resposta a DSAR. Volume pequeno mas crítico em compliance.
CREATE INDEX "idx_fhdl_user_moved"
  ON "file_history_dead_letter" ("user_id", "moved_to_dead_letter_at" DESC);

-- (4) UNIQUE PARTIAL: defesa contra duplicação de move pela mesma origem.
--     Se cron tenta inserir dead-letter de row já dead-lettered ativo,
--     recebe P2002 e log warning (não erra execução inteira).
CREATE UNIQUE INDEX "uq_fhdl_active_per_origin"
  ON "file_history_dead_letter" ("original_file_history_id")
  WHERE "resolved_at" IS NULL;

-- ===== RLS =====

-- Service-role only (sem policies — DENY ALL implícito). Pattern Card #150.
-- User NÃO deve ver "seu arquivo está em dead-letter" (UX ruim + confusão).
-- Admin lê via /admin/dead-letter futuro endpoint (service_role bypass).
ALTER TABLE "file_history_dead_letter" ENABLE ROW LEVEL SECURITY;

-- ===== Trigger BEFORE DELETE — defesa contra hard-delete (Trade-off 6) =====

-- Service_role bypassa RLS — qualquer DELETE rogue elimina prova forense.
-- Trigger BEFORE DELETE bloqueia explicitamente. Hard-delete só via job
-- de purga 5y futuro (Card LGPD-AUDIT) com role dedicada que faz
-- ALTER TABLE DISABLE TRIGGER em transação OU SECURITY DEFINER bypass.
-- UPDATE permitido (cron weekly atualiza reprocess_count + resolved_at).
CREATE OR REPLACE FUNCTION "block_file_history_dead_letter_delete"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'file_history_dead_letter is delete-protected (prova jurídica LGPD). Use cron de retenção 5 anos com role dedicada (Card LGPD-AUDIT futuro).'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION "block_file_history_dead_letter_delete"() IS
  'Pattern Card #150 (block_audit_log_legal_mutation). UPDATE permitido (cron weekly precisa atualizar reprocess_count + resolved_at). DELETE só via role dedicada futura.';

CREATE TRIGGER "fhdl_block_delete"
  BEFORE DELETE ON "file_history_dead_letter"
  FOR EACH ROW
  EXECUTE FUNCTION "block_file_history_dead_letter_delete"();
