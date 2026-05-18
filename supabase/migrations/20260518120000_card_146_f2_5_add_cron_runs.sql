-- =============================================================================
-- Migration: card_146_f2_5_add_cron_runs
-- Version: 20260518120000
-- Card: #146 (DtBkVtVY equivalente: FK94hRBQ) — Fase 5 — Storage
--
-- Contexto:
--   Tabela `cron_runs` substitui o histórico in-memory (Map cap-10/job em
--   src/scheduler/cron.ts) por persistência forte. AMB-3 = A escolhida pelo
--   operador em 2026-05-18 (override da recomendação @planner C).
--
--   Persiste lifecycle completo de cada execução do scheduler:
--   - history-purge (Card #146 daily 03:00 BRT)
--   - cron-runs-cleanup (Card #146 F4.5 daily — purga rows > 30d)
--   - dead-letter-reprocess (Card #146 F4.7 weekly)
--
--   Cleanup operacional 30d via cron `cron-runs-cleanup`. NÃO confundir com
--   retenção LGPD (forense via audit_log_legal 5y já existe).
--
-- Plano completo: .claude/plans/2026-05-18-card-146-5.2b-cron-purge-two-phase.md
--
-- DECISÕES IRREVERSÍVEIS (consultar plano + relatório @dba antes de mudar):
--
-- (Trade-off 1) id é UUID DB-side via gen_random_uuid(). NÃO reutiliza
--       LockHandle.token do Redis (fencing secret operacional). Token vaza
--       via SELECT = ataque CAS no lock distribuído. App passa runId
--       (randomUUID() separado) explícito no INSERT; JobRunMeta.runId ===
--       cron_runs.id; LockHandle.token vive APENAS na memória + Lua script.
--
-- (Trade-off enum) status/skip_reason são VARCHAR + CHECK whitelist, NÃO
--       ENUM Postgres. Razão: ENUM exige migration pra ADD VALUE (e o bug
--       `redis_unavailable` removido em F5 fix-pack mostra que enum values
--       saem da lista). VARCHAR + CHECK permite remover/adicionar trivial.
--
-- (skip_reason whitelist) Espelha enum em src/scheduler/types.ts. Atenção:
--       'redis_unavailable' foi REMOVIDO em F5 fix-pack (era dead code —
--       runner sempre seta 'lock_not_acquired' mesmo quando Redis offline).
--       Distinção fica em `event` do log scheduler (`cron.lock.redis_unavailable`
--       vs `cron.lock.not_acquired`), não em skip_reason.
--
-- (FK) job_name SEM FK física. Jobs são definidos em código (CronJobDefinition);
--       não há tabela de jobs. CHECK regex valida formato kebab-case.
--
-- (duration_ms) NÃO usar GENERATED ALWAYS AS — subtração timestamptz não é
--       IMMUTABLE em Postgres (DST/TZ shift teórico). App computa em
--       src/scheduler/cron.ts (Date.now() - startedAt.getTime()).
--
-- (CONCURRENTLY) Não usado: tabela nasce vazia, build instantâneo.
--       Índices novos pós-MVP em tabela populada DEVEM usar CONCURRENTLY
--       em migration separada (single-statement, via psql direto — MCP gera
--       erro 25001 com SET prévio, ver feedback_execute_sql_concurrently).
--
-- Hard requirements consolidados (relatório @dba 2026-05-18):
--   - 10 CHECK constraints (defesa em profundidade contra bug app-side)
--   - 4 índices (2 hot path + 2 partial)
--   - RLS service-role only (sem policies — DENY ALL implícito)
-- =============================================================================

CREATE TABLE "cron_runs" (
  "id"              UUID            NOT NULL DEFAULT gen_random_uuid(),
  "job_name"        VARCHAR(64)     NOT NULL,
  "started_at"      TIMESTAMPTZ(3)  NOT NULL,
  "finished_at"     TIMESTAMPTZ(3),
  "status"          VARCHAR(16)     NOT NULL,
  "skip_reason"     VARCHAR(32),
  "duration_ms"     INTEGER,
  "rows_processed" INTEGER,
  "attempts"        SMALLINT        NOT NULL DEFAULT 1,
  "error_code"      VARCHAR(80),
  "error_message"   VARCHAR(500),
  "created_at"      TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "cron_runs" IS
  'Histórico persistente de execuções do scheduler (Card #146 F2.5). Retenção operacional 30d via cron cron-runs-cleanup.';
COMMENT ON COLUMN "cron_runs"."id" IS
  'UUID DB-side. NÃO reutiliza LockHandle.token (fencing secret operacional). App passa randomUUID() separado.';
COMMENT ON COLUMN "cron_runs"."skip_reason" IS
  'WHITELIST: feature_disabled, test_env, lock_not_acquired. Atenção: redis_unavailable foi REMOVIDO em F5 fix-pack (era dead value).';
COMMENT ON COLUMN "cron_runs"."duration_ms" IS
  'Computado app-side (Date.now() diff). NÃO usar GENERATED — subtração timestamptz não é IMMUTABLE em Postgres.';

-- ===== CHECK constraints =====

-- (1) Whitelist status (mantida em sync com JobRunMeta.status no app).
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_status_check"
  CHECK ("status" IN ('running','success','failure','skipped','expired'));

-- (2) Whitelist skip_reason. NULL exceto quando status='skipped'.
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_skip_reason_check"
  CHECK ("skip_reason" IS NULL OR "skip_reason" IN
    ('feature_disabled','test_env','lock_not_acquired'));

-- (3) Invariante terminal: status terminal → finished_at NOT NULL.
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_terminal_finished_check"
  CHECK (
    ("status" = 'running' AND "finished_at" IS NULL) OR
    ("status" IN ('success','failure','skipped','expired') AND "finished_at" IS NOT NULL)
  );

-- (4) Invariante temporal: finished_at >= started_at (se preenchido).
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_finished_after_started_check"
  CHECK ("finished_at" IS NULL OR "finished_at" >= "started_at");

-- (5) skip_reason consistency: só preenchido com status='skipped'.
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_skip_reason_consistency_check"
  CHECK (
    ("status" = 'skipped' AND "skip_reason" IS NOT NULL) OR
    ("status" != 'skipped' AND "skip_reason" IS NULL)
  );

-- (6) error consistency: só preenchido com status='failure' ou 'expired'.
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_error_consistency_check"
  CHECK (
    ("status" IN ('failure','expired')) OR
    ("error_code" IS NULL AND "error_message" IS NULL)
  );

-- (7) duration positivo (defesa contra bug de relógio).
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_duration_positive_check"
  CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0);

-- (8) rows_processed não-negativo.
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_rows_processed_nonneg_check"
  CHECK ("rows_processed" IS NULL OR "rows_processed" >= 0);

-- (9) attempts: positivo, máx 10 (sanity — retry escalada além disso vira incident).
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_attempts_check"
  CHECK ("attempts" BETWEEN 1 AND 10);

-- (10) job_name kebab-case, length 3-64.
ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_job_name_format_check"
  CHECK ("job_name" ~ '^[a-z][a-z0-9-]{2,63}$');

-- ===== Índices =====

-- (1) Hot path: "últimos N runs do job X" (admin endpoint + dashboard futuro).
--     Espelha JobRunMeta cap-10 do in-memory. DESC permite Index-Only-Scan se LIMIT.
CREATE INDEX "idx_cron_runs_job_started_desc"
  ON "cron_runs" ("job_name", "started_at" DESC);

-- (2) Hot path do cleanup cron: "DELETE WHERE created_at < NOW() - 30d".
--     Sem este índice, cleanup é seq scan = bloqueio cumulativo.
CREATE INDEX "idx_cron_runs_created_at"
  ON "cron_runs" ("created_at");

-- (3) PARTIAL: failures/expired pra alerting/forensics. <5% volume esperado.
CREATE INDEX "idx_cron_runs_failures"
  ON "cron_runs" ("started_at" DESC)
  WHERE "status" IN ('failure','expired');

-- (4) PARTIAL: running runs (sempre ~3 jobs ativos max).
--     Hot path de "está algum job travado há > 15min?" alerta operacional.
CREATE INDEX "idx_cron_runs_running"
  ON "cron_runs" ("started_at")
  WHERE "status" = 'running';

-- ===== RLS =====

-- Service-role only (sem policies — DENY ALL implícito). Pattern Card #150.
-- Backend usa service_role e bypassa RLS por design (mesmo audit_log_legal +
-- audit_log Card 2.4). End user nunca lê cron_runs (admin-only via
-- /admin/jobs/list futuro endpoint).
ALTER TABLE "cron_runs" ENABLE ROW LEVEL SECURITY;
