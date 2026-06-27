-- ============================================================================
-- Schema snapshot — Tablix Backend
-- ============================================================================
-- Origem: introspection de produção (Supabase) via MCP em 2026-04-21,
--         re-sincronizado em 2026-04-24 após Fase 3 DB Hardening (commit
--         43bc1c2) — migrations TIMESTAMPTZ + UUID native + drop orphan
--         indexes aplicadas em prod Supabase em 2026-04-24.
-- Uso: aplicado no Testcontainers (postgres:17-alpine) antes de cada suíte
-- de integração. É a SSOT do schema em ambiente de teste.
--
-- NÃO EDITAR À MÃO. Para regenerar após mudança de schema em prod, rodar:
--   npx tsx scripts/dump-test-schema.ts
--
-- Pareado com: prisma/schema.prisma e supabase/migrations/**.sql (são as
-- fontes canônicas de prod; este arquivo é só o snapshot consolidado).
-- ============================================================================

-- Extensão requerida por gen_random_uuid() (presente em Supabase/PG 17)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- STUB: schema auth + auth.uid() (Supabase compat para Testcontainers)
-- ----------------------------------------------------------------------------
-- Em Supabase, `auth.uid()` retorna o UUID do user autenticado a partir do
-- JWT. Em Testcontainers Postgres puro este schema não existe — RLS policies
-- que referenciam `auth.uid()` falham no apply.
--
-- Stub mínimo: cria schema + função que retorna NULL. Permite que CREATE POLICY
-- valide a definition (smoke test verifica existência via pg_policies). Para
-- testar comportamento RLS runtime real (anon vs authenticated) é necessário
-- ambiente Supabase + JWT real — fora do escopo dos integration tests.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT NULL::UUID $$ LANGUAGE SQL STABLE;
-- Role `authenticated` é criado pelo Supabase em prod. No container, criamos
-- um stub pra permitir que CREATE POLICY ... TO authenticated não falhe.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- ENUMS
-- ----------------------------------------------------------------------------
CREATE TYPE "JobStatus"   AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "Plan"        AS ENUM ('PRO');
CREATE TYPE "Role"        AS ENUM ('FREE', 'PRO');
CREATE TYPE "TokenStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED');

-- ----------------------------------------------------------------------------
-- TABLE: users
-- ----------------------------------------------------------------------------
CREATE TABLE "users" (
  "id"                    UUID            NOT NULL DEFAULT gen_random_uuid(),
  "email"                 VARCHAR(255)    NOT NULL,
  "role"                  "Role"          NOT NULL DEFAULT 'FREE',
  "stripe_customer_id"    VARCHAR(255),
  "history_opt_in"        BOOLEAN         NOT NULL DEFAULT FALSE,
  "history_opt_in_at"     TIMESTAMPTZ(3),
  "history_opt_out_at"    TIMESTAMPTZ(3),
  "created_at"            TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key"              ON "users" ("email");
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users" ("stripe_customer_id");

-- ----------------------------------------------------------------------------
-- TABLE: sessions
-- ----------------------------------------------------------------------------
CREATE TABLE "sessions" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             UUID            NOT NULL,
  "fingerprint"         VARCHAR(64),
  "user_agent"          VARCHAR(512),
  "ip_address"          VARCHAR(45),
  "refresh_token_hash"  VARCHAR(64)     NOT NULL,
  "created_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_activity_at"    TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"          TIMESTAMPTZ(3)  NOT NULL,
  "revoked_at"          TIMESTAMPTZ(3),
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions" ("refresh_token_hash");
CREATE        INDEX "sessions_user_id_idx"            ON "sessions" ("user_id");
CREATE        INDEX "idx_sessions_expires_at"         ON "sessions" ("expires_at");
CREATE        INDEX "idx_sessions_revoked_at"         ON "sessions" ("revoked_at");

-- ----------------------------------------------------------------------------
-- TABLE: tokens
-- ----------------------------------------------------------------------------
-- NOTA: índice `tokens_token_idx` (BTREE em token) era redundante com
-- `tokens_token_key` UNIQUE — droppado em Fase 3 Migration C (2026-04-24).
-- UNIQUE serve queries de leitura tão bem quanto BTREE comum.
CREATE TABLE "tokens" (
  "id"                      UUID            NOT NULL DEFAULT gen_random_uuid(),
  "token"                   VARCHAR(64)     NOT NULL,
  "fingerprint"             VARCHAR(64),
  "stripe_subscription_id"  VARCHAR(255),
  "plan"                    "Plan"          NOT NULL DEFAULT 'PRO',
  "status"                  "TokenStatus"   NOT NULL DEFAULT 'ACTIVE',
  "created_at"              TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at"            TIMESTAMPTZ(3),
  "expires_at"              TIMESTAMPTZ(3),
  "user_id"                 UUID            NOT NULL,
  CONSTRAINT "tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "uq_tokens_user_subscription" UNIQUE ("user_id", "stripe_subscription_id")
);
CREATE UNIQUE INDEX "tokens_token_key"       ON "tokens" ("token");
CREATE        INDEX "tokens_fingerprint_idx" ON "tokens" ("fingerprint");
CREATE        INDEX "idx_tokens_user"        ON "tokens" ("user_id");
-- Card #147 fix-pack ciclo 2 followup: índice parcial pra query hot do cron quota-alert.
CREATE        INDEX "idx_tokens_active_pro"  ON "tokens" ("user_id", "status") WHERE "status" = 'ACTIVE';

-- ----------------------------------------------------------------------------
-- TABLE: usage
-- ----------------------------------------------------------------------------
-- NOTA: índice `idx_usage_token_period` era redundante com a UNIQUE composta
-- `usage_user_id_period_key` — droppado em Fase 3 Migration C (2026-04-24).
CREATE TABLE "usage" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             UUID            NOT NULL,
  "period"              VARCHAR(7)      NOT NULL,
  "unifications_count"  INTEGER         NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "usage_user_id_period_key" ON "usage" ("user_id", "period");

-- ----------------------------------------------------------------------------
-- TABLE: jobs
-- ----------------------------------------------------------------------------
CREATE TABLE "jobs" (
  "id"                UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"           UUID            NOT NULL,
  "status"            "JobStatus"     NOT NULL DEFAULT 'PENDING',
  "input_files"       JSONB           NOT NULL,
  "output_file_url"   VARCHAR(500),
  -- Card 6.3 (migration 20260621190000_card_6_3_jobs_async_expand): colunas
  -- aditivas/nullable do caminho LRO. Mantidas em sync com prisma/schema.prisma
  -- (model Job) e a migration aplicada. @tester Card 6.3 — fixture regen.
  "output_format"     VARCHAR(8),
  "output_size"       BIGINT,
  "error_message"     TEXT,
  "created_at"        TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"        TIMESTAMPTZ(3),
  "completed_at"      TIMESTAMPTZ(3),
  "downloaded_at"     TIMESTAMPTZ(3),
  "inputs_purged_at"  TIMESTAMPTZ(3),
  "expires_at"        TIMESTAMPTZ(3),
  CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jobs_output_format_check"
    CHECK ("output_format" IS NULL OR "output_format" IN ('xlsx','csv')),
  CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX "idx_jobs_user"   ON "jobs" ("user_id");
CREATE INDEX "idx_jobs_status" ON "jobs" ("status");
-- Índice parcial pro cleanup 6.7 (Card 6.3) — espelha o CONCURRENTLY de prod.
CREATE INDEX "idx_jobs_expires_at" ON "jobs" ("expires_at") WHERE ("expires_at" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- TABLE: stripe_events
-- ----------------------------------------------------------------------------
-- Card #189 (EXPAND): idempotent receiver RECEIVED -> PROCESSED.
--   * status: RECEIVED no INSERT (gate de dedup); PROCESSED ao concluir a tx.
--   * received_at / processed_at nullable na fase EXPAND (sem default no DB;
--     setados explicitamente pelo app). Viram NOT NULL DEFAULT now() no CONTRACT.
CREATE TABLE "stripe_events" (
  "id"            VARCHAR(255)    NOT NULL,
  "type"          VARCHAR(255)    NOT NULL,
  "status"        VARCHAR(16)     NOT NULL DEFAULT 'RECEIVED',
  "received_at"   TIMESTAMPTZ(3),
  "processed_at"  TIMESTAMPTZ(3),
  CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id"),
  -- Espelha o CHECK VALIDATED de prod. Sem ele, o container de teste seria mais
  -- frouxo que prod e uma regressão gravando status inválido passaria verde no
  -- CI e estouraria 23514 em prod (@dba MÉDIO drift fixture↔prod, Card #189).
  CONSTRAINT "stripe_events_status_check" CHECK ("status" IN ('RECEIVED', 'PROCESSED'))
);
CREATE INDEX "idx_stripe_events_processed_at" ON "stripe_events" ("processed_at");
-- Índice parcial: varre eventos RECEIVED travados (observabilidade/reconciliação).
CREATE INDEX "idx_stripe_events_pending" ON "stripe_events" ("received_at") WHERE "status" = 'RECEIVED';

-- ----------------------------------------------------------------------------
-- TABLE: audit_log
-- ----------------------------------------------------------------------------
CREATE TABLE "audit_log" (
  "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "action"      VARCHAR(50)     NOT NULL,
  "actor"       VARCHAR(255),
  "ip"          VARCHAR(45),
  "user_agent"  VARCHAR(512),
  "success"     BOOLEAN         NOT NULL,
  "metadata"    JSONB,
  "created_at"  TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_action_format_check" CHECK (
    ((action)::text ~ '^[A-Z_]+$'::text)
    AND (length((action)::text) >= 3)
    AND (length((action)::text) <= 50)
  )
);
ALTER TABLE "audit_log" SET (toast_tuple_target = 4096);
CREATE INDEX "idx_audit_log_action"            ON "audit_log" ("action");
CREATE INDEX "idx_audit_log_actor_created"     ON "audit_log" ("actor", "created_at" DESC) WHERE ("actor" IS NOT NULL);
CREATE INDEX "idx_audit_log_created_at"        ON "audit_log" ("created_at");
CREATE INDEX "idx_audit_log_failures"          ON "audit_log" ("created_at" DESC) WHERE (success = false);

-- ----------------------------------------------------------------------------
-- TABLE: audit_log_legal
-- ----------------------------------------------------------------------------
-- Trilha LGPD com retencao 5 anos. SEPARADA de audit_log (90d).
-- Eventos: purge/consent/dsar. Card #150 (Fase 5).
-- IRREVERSIVEIS: D-1 (await), D-2/D-4 (whitelists), D-3 (tabela separada),
-- D-5 (sem FK userId), R-7 (nao reusar cron 90d), resource_hash FREEZED v1.
-- Plano: .claude/plans/2026-04-28-card-150-audit-log-legal.md
CREATE TABLE "audit_log_legal" (
  "id"                    UUID            NOT NULL DEFAULT gen_random_uuid(),
  "event_id"              UUID            NOT NULL,
  "event_type"            VARCHAR(40)     NOT NULL,
  "timestamp"             TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "user_id"               UUID            NOT NULL,
  "resource_type"         VARCHAR(40)     NOT NULL,
  "resource_id"           VARCHAR(64)     NOT NULL,
  "legal_basis"           VARCHAR(60)     NOT NULL,
  "actor"                 VARCHAR(40)     NOT NULL,
  "expires_at_original"   TIMESTAMPTZ(3),
  "resource_hash"         BYTEA,
  "resource_hash_algo"    VARCHAR(8)      NOT NULL DEFAULT 'sha256v1',
  "outcome"               VARCHAR(16)     NOT NULL,
  "error_code"            VARCHAR(80),
  "metadata"              JSONB,
  CONSTRAINT "audit_log_legal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_legal_event_id_key" UNIQUE ("event_id"),
  CONSTRAINT "audit_log_legal_event_type_check" CHECK (
    "event_type" IN (
      'purge_pending', 'purge_completed', 'purge_failed',
      'consent_given', 'consent_withdrawn',
      'dsar_request', 'dsar_fulfilled'
    )
  ),
  CONSTRAINT "audit_log_legal_actor_check" CHECK (
    "actor" IN ('cron_purge_worker', 'user_self_service', 'admin_panel')
  ),
  CONSTRAINT "audit_log_legal_outcome_check" CHECK (
    "outcome" IN ('success', 'failure')
  ),
  CONSTRAINT "audit_log_legal_legal_basis_format_check" CHECK (
    ("legal_basis"::text ~ '^[a-z_]+$'::text)
    AND (length("legal_basis"::text) >= 3)
    AND (length("legal_basis"::text) <= 60)
  ),
  CONSTRAINT "audit_log_legal_resource_hash_size_check" CHECK (
    "resource_hash" IS NULL OR octet_length("resource_hash") = 32
  ),
  CONSTRAINT "audit_log_legal_error_code_required_check" CHECK (
    ("outcome" = 'success') OR
    ("outcome" = 'failure' AND "error_code" IS NOT NULL)
  )
);
ALTER TABLE "audit_log_legal" SET (toast_tuple_target = 4096);
ALTER TABLE "audit_log_legal" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "idx_audit_log_legal_user_ts"          ON "audit_log_legal" ("user_id", "timestamp" DESC);
CREATE INDEX "idx_audit_log_legal_event_type_ts"    ON "audit_log_legal" ("event_type", "timestamp" DESC);
CREATE INDEX "idx_audit_log_legal_failures"         ON "audit_log_legal" ("timestamp" DESC) WHERE ("outcome" = 'failure');
CREATE INDEX "idx_audit_log_legal_hash_pending"     ON "audit_log_legal" ("resource_hash") WHERE ("event_type" IN ('purge_pending', 'purge_completed', 'purge_failed') AND "resource_hash" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- TRIGGER: audit_log_legal append-only enforcement (Card #150 fix-pack F-MED-01)
-- ----------------------------------------------------------------------------
-- Bloqueia UPDATE/DELETE em audit_log_legal (LGPD prova juridica intacta).
-- Excecao prevista: cron de retencao 5 anos (Card #152 futuro) com role dedicada.
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

CREATE TRIGGER audit_log_legal_block_update
  BEFORE UPDATE ON "audit_log_legal"
  FOR EACH ROW EXECUTE FUNCTION block_audit_log_legal_mutation();
CREATE TRIGGER audit_log_legal_block_delete
  BEFORE DELETE ON "audit_log_legal"
  FOR EACH ROW EXECUTE FUNCTION block_audit_log_legal_mutation();

-- ----------------------------------------------------------------------------
-- TABLE: file_history (Card #145 — 5.2a — Fase 5 Storage)
-- ----------------------------------------------------------------------------
-- Histórico opt-in PRO de arquivos processados. Soft-delete two-phase:
-- deleted_at sentinela + cron #146 hard-delete. Plano:
-- .claude/plans/2026-05-02-card-145-5.2a-history-optin-schema-endpoints-cron-infra.md
--
-- Decisões irreversíveis: D-B (deleted_at NULLABLE), D-C (expires_at em service),
-- FK Cascade (operacional não jurídico — diferente de audit_log_legal RESTRICT),
-- storage_path UNIQUE (defesa em profundidade vs race upload).
--
-- Inclui findings F1 fix-pack (2026-05-03): original_filename rejeita
-- \x00-\x1F\x7F, regex storage_path date stricter month/day válidos.
CREATE TABLE "file_history" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             UUID            NOT NULL,
  "storage_path"        VARCHAR(255)    NOT NULL,
  "original_filename"   VARCHAR(255)    NOT NULL,
  "mime_type"           VARCHAR(127)    NOT NULL,
  "file_size"           INTEGER         NOT NULL,
  "expires_at"          TIMESTAMPTZ(3)  NOT NULL,
  "deleted_at"          TIMESTAMPTZ(3),
  "purge_attempts"      INTEGER         NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_history_storage_path_key" UNIQUE ("storage_path"),
  CONSTRAINT "file_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "file_history_file_size_positive_check" CHECK (
    "file_size" > 0 AND "file_size" <= 104857600
  ),
  CONSTRAINT "file_history_purge_attempts_nonneg_check" CHECK (
    "purge_attempts" >= 0
  ),
  CONSTRAINT "file_history_storage_path_format_check" CHECK (
    "storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])/[a-z0-9]{7,64}\.(csv|xlsx|xls)$'
  ),
  CONSTRAINT "file_history_mime_type_nonempty_check" CHECK (
    length("mime_type") > 0
  ),
  CONSTRAINT "file_history_original_filename_check" CHECK (
    length("original_filename") > 0
    AND "original_filename" !~ '[\x00-\x1F\x7F]'
  ),
  CONSTRAINT "file_history_expires_at_after_created_check" CHECK (
    "expires_at" >= "created_at"
  )
);
ALTER TABLE "file_history" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "idx_filehistory_user_created"    ON "file_history" ("user_id", "created_at" DESC);
CREATE INDEX "idx_filehistory_expires_active"  ON "file_history" ("expires_at") WHERE ("deleted_at" IS NULL);
CREATE INDEX "idx_filehistory_purge_pending"   ON "file_history" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);

-- RLS policies — defense em profundidade. Backend usa service_role (bypass).
-- Nota: auth.uid() vem de extension auth (Supabase). Em Testcontainers Postgres
-- puro, auth.uid() não existe — policies são CRIADAS mas runtime testing requer
-- mock de auth.uid() ou Supabase test environment. Smoke testa só a EXISTÊNCIA
-- e definition (regression detection via pg_policies).
CREATE POLICY "file_history_select_own_active"
  ON "file_history"
  FOR SELECT
  TO authenticated
  USING (auth.uid() = "user_id" AND "deleted_at" IS NULL);

CREATE POLICY "file_history_insert_own"
  ON "file_history"
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = "user_id");

CREATE POLICY "file_history_update_own_active"
  ON "file_history"
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = "user_id" AND "deleted_at" IS NULL)
  WITH CHECK (auth.uid() = "user_id");

-- ----------------------------------------------------------------------------
-- cron_runs (Card #146 F2.5) — telemetria persistente do scheduler.
-- ----------------------------------------------------------------------------
-- 1 row por execução de cron. Status terminal (success/failure/skipped/expired)
-- exige finished_at; status='running' exige finished_at NULL. CHECK garante
-- invariantes consistentes. Retenção 30d via cron-runs-cleanup.job.
CREATE TABLE "cron_runs" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "job_name"       VARCHAR(64)  NOT NULL,
  "started_at"     TIMESTAMPTZ  NOT NULL,
  "finished_at"    TIMESTAMPTZ,
  "status"         VARCHAR(16)  NOT NULL,
  "skip_reason"    VARCHAR(32),
  "duration_ms"    INTEGER,
  "rows_processed" INTEGER,
  "attempts"       SMALLINT     NOT NULL DEFAULT 1,
  "error_code"     VARCHAR(80),
  "error_message"  VARCHAR(500),
  "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cron_runs_status_check"
    CHECK (status IN ('running','success','failure','skipped','expired')),
  CONSTRAINT "cron_runs_terminal_finished_check"
    CHECK (
      (status = 'running' AND finished_at IS NULL)
      OR (status IN ('success','failure','skipped','expired') AND finished_at IS NOT NULL)
    ),
  CONSTRAINT "cron_runs_skip_reason_check"
    CHECK (
      skip_reason IS NULL
      OR skip_reason IN ('feature_disabled','test_env','lock_not_acquired')
    ),
  CONSTRAINT "cron_runs_skip_reason_consistency"
    CHECK (
      (status = 'skipped' AND skip_reason IS NOT NULL)
      OR (status <> 'skipped' AND skip_reason IS NULL)
    ),
  CONSTRAINT "cron_runs_error_consistency"
    CHECK (
      status IN ('failure','expired')
      OR (error_code IS NULL AND error_message IS NULL)
    ),
  CONSTRAINT "cron_runs_attempts_check"     CHECK (attempts BETWEEN 1 AND 10),
  CONSTRAINT "cron_runs_duration_positive_check" CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT "cron_runs_rows_processed_nonneg" CHECK (rows_processed IS NULL OR rows_processed >= 0),
  CONSTRAINT "cron_runs_finished_after_started" CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT "cron_runs_job_name_format_check" CHECK (job_name ~ '^[a-z][a-z0-9-]{2,63}$')
);
CREATE INDEX "idx_cron_runs_created_at"        ON "cron_runs" ("created_at");
CREATE INDEX "idx_cron_runs_failures"          ON "cron_runs" ("started_at" DESC) WHERE status IN ('failure','expired');
CREATE INDEX "idx_cron_runs_job_started_desc"  ON "cron_runs" ("job_name", "started_at" DESC);
CREATE INDEX "idx_cron_runs_running"           ON "cron_runs" ("started_at") WHERE status = 'running';

-- ----------------------------------------------------------------------------
-- file_history_dead_letter (Card #146 F2.5) — fila de quarentena LGPD.
-- ----------------------------------------------------------------------------
-- Rows mortas (purge_attempts >= 5) movidas pra cá pra inspeção manual.
-- UNIQUE PARTIAL impede duplicação ativa por origem. Trigger BEFORE DELETE
-- bloqueia hard-delete (LGPD audit trail). Coluna mime_type, original_filename,
-- storage_path com validações strict pra evitar drift Zod↔SQL.
CREATE TABLE "file_history_dead_letter" (
  "id"                            UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "original_file_history_id"      UUID         NOT NULL,
  "user_id"                       UUID         NOT NULL,
  "storage_path"                  VARCHAR(255) NOT NULL,
  "original_filename"             VARCHAR(255) NOT NULL,
  "mime_type"                     VARCHAR(127) NOT NULL,
  "file_size"                     INTEGER      NOT NULL,
  "expires_at"                    TIMESTAMPTZ  NOT NULL,
  "deleted_at"                    TIMESTAMPTZ  NOT NULL,
  "purge_attempts"                INTEGER      NOT NULL,
  "last_error_code"               VARCHAR(80)  NOT NULL,
  "last_error_message"            VARCHAR(500),
  "moved_to_dead_letter_at"       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reprocess_count"               SMALLINT     NOT NULL DEFAULT 0,
  "last_reprocess_attempt_at"     TIMESTAMPTZ,
  "last_reprocess_error_code"     VARCHAR(80),
  "last_reprocess_error_message"  VARCHAR(500),
  "resolved_at"                   TIMESTAMPTZ,
  "resolution_type"               VARCHAR(32),
  "created_at"                    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fhdl_purge_attempts_threshold_check" CHECK (purge_attempts >= 5),
  CONSTRAINT "fhdl_file_size_positive_check"       CHECK (file_size > 0 AND file_size <= 104857600),
  CONSTRAINT "fhdl_mime_type_nonempty"             CHECK (length(mime_type) > 0),
  CONSTRAINT "fhdl_original_filename_check"
    CHECK (length(original_filename) > 0 AND original_filename !~ '[\x00-\x1F\x7F]'),
  CONSTRAINT "fhdl_storage_path_format_check"
    CHECK (storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])/[a-z0-9]{7,64}\.(csv|xlsx|xls)$'),
  CONSTRAINT "fhdl_reprocess_count_check" CHECK (reprocess_count BETWEEN 0 AND 3),
  CONSTRAINT "fhdl_reprocess_consistency"
    CHECK (
      (reprocess_count = 0 AND last_reprocess_attempt_at IS NULL)
      OR (reprocess_count > 0 AND last_reprocess_attempt_at IS NOT NULL)
    ),
  CONSTRAINT "fhdl_resolution_consistency"
    CHECK (
      (resolved_at IS NULL AND resolution_type IS NULL)
      OR (resolved_at IS NOT NULL AND resolution_type IS NOT NULL)
    ),
  CONSTRAINT "fhdl_resolution_type_check"
    CHECK (
      resolution_type IS NULL
      OR resolution_type IN ('cron_reprocess_success','admin_manual_delete','admin_manual_ignore','storage_already_gone')
    ),
  CONSTRAINT "fhdl_timing_consistency"
    CHECK (
      deleted_at <= moved_to_dead_letter_at
      AND (last_reprocess_attempt_at IS NULL OR last_reprocess_attempt_at >= moved_to_dead_letter_at)
      AND (resolved_at IS NULL OR (last_reprocess_attempt_at IS NOT NULL AND resolved_at >= last_reprocess_attempt_at))
    )
);
CREATE INDEX "idx_fhdl_human_required"        ON "file_history_dead_letter" ("moved_to_dead_letter_at" DESC) WHERE resolved_at IS NULL AND reprocess_count >= 3;
CREATE INDEX "idx_fhdl_reprocess_candidates"  ON "file_history_dead_letter" ("moved_to_dead_letter_at") WHERE resolved_at IS NULL AND reprocess_count < 3;
CREATE INDEX "idx_fhdl_user_moved"            ON "file_history_dead_letter" ("user_id", "moved_to_dead_letter_at" DESC);
CREATE UNIQUE INDEX "uq_fhdl_active_per_origin" ON "file_history_dead_letter" ("original_file_history_id") WHERE resolved_at IS NULL;

-- ----------------------------------------------------------------------------
-- quota_alerts_sent (Card #147 5.2c F1) — dedupe de alertas de quota mensal.
-- ----------------------------------------------------------------------------
-- 1 row = 1 alerta enviado. UNIQUE(user_id, threshold, period) absorve retry e
-- garante 1 email/threshold/mês/user. Cron quota-alert insere via
-- INSERT...ON CONFLICT DO NOTHING (atomic). FK CASCADE pra LGPD purge.
CREATE TABLE "quota_alerts_sent" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "user_id"   UUID         NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "threshold" INTEGER      NOT NULL,
  "period"    VARCHAR(7)   NOT NULL,
  "sent_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT "quota_alerts_threshold_check"
    CHECK (threshold IN (70, 90)),
  CONSTRAINT "quota_alerts_period_format_check"
    CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "quota_alerts_unique_user_threshold_period"
    UNIQUE ("user_id", "threshold", "period")
);
ALTER TABLE "quota_alerts_sent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quota_alerts_service_role_only" ON "quota_alerts_sent"
  FOR ALL TO public USING (false) WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- TRIGGER: file_history_dead_letter delete-protected (Card #146 fix-pack)
-- ----------------------------------------------------------------------------
-- Função + trigger BEFORE DELETE pra preservar trilha forense LGPD.
-- UPDATE permitido (reprocess_count, resolved_at). DELETE só via
-- Card LGPD-AUDIT futuro com role dedicada com bypass explícito.
-- SET search_path = pg_catalog, public — hardening @dba ciclo 1 #146.

CREATE OR REPLACE FUNCTION block_file_history_dead_letter_delete()
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

CREATE TRIGGER fhdl_block_delete
  BEFORE DELETE ON file_history_dead_letter
  FOR EACH ROW EXECUTE FUNCTION block_file_history_dead_letter_delete();
