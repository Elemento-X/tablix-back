-- Migration: card_6_3_jobs_async_expand
-- Version: 20260621190000
-- Card: #6.3 — POST /process/async (LRO): cria Job, persiste inputs no Storage,
--        enfileira no BullMQ (6.2), retorna 202+jobId. Worker (6.4) processa;
--        download (6.6) faz claim atômico de entrega única; cleanup (6.7) purga.
--
-- Fase EXPAND: 100% aditiva e nullable (forward+backward compatível). Async está
-- atrás da flag ASYNC_PROCESSING_ENABLED (default off) e jobs tem ~0 rows pré
-- go-live — toda operação abaixo é metadata-only (sem table rewrite). O caminho
-- síncrono NÃO persiste rows em jobs (confirmado), então toda row aqui é async.
--
-- Design por @dba (review pré-implementação 2026-06-21): bullJobId CORTADO do
-- plano (redundante com a PK — Job.id já é o jobId do BullMQ, dá enqueue
-- idempotente nativo); outputSize em BIGINT (não int4 — foot-gun de byte-count).
--
-- @owner: @dba
-- @card: #6.3
-- Aplicar via Supabase MCP (índice CONCURRENTLY é single-statement, fora de tx).

-- ============================================================================
-- DEPLOY 1 — EXPAND (transacional)
-- ============================================================================

-- output_format: 'xlsx'|'csv' do resultado. NULL ate o worker concluir.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "output_format" VARCHAR(8);

-- output_size: tamanho do output em BYTES. BIGINT (int4 = foot-gun em byte-count).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "output_size" BIGINT;

-- downloaded_at: claim atomico de entrega unica (6.6).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "downloaded_at" TIMESTAMPTZ(3);

-- inputs_purged_at: quando worker/cleanup removeu os inputs do Storage.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "inputs_purged_at" TIMESTAMPTZ(3);

-- expires_at: TTL do job/output pro cleanup (6.7). Setado pelo app no insert
-- (now() + TTL) — sem DEFAULT no banco (regra de negocio fica na app).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(3);

-- CHECK do output_format como NOT VALID (sem full scan sob ACCESS EXCLUSIVE),
-- validado em seguida. Tolera NULL (estado pre-conclusao).
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_output_format_check";
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_output_format_check"
  CHECK ("output_format" IS NULL OR "output_format" IN ('xlsx','csv')) NOT VALID;

-- VALIDATE separado (SHARE UPDATE EXCLUSIVE — permite reads+writes; instant em ~0 rows).
ALTER TABLE "jobs" VALIDATE CONSTRAINT "jobs_output_format_check";

COMMENT ON COLUMN "jobs"."output_size"    IS 'Tamanho do output em bytes (BIGINT). Card #6.3.';
COMMENT ON COLUMN "jobs"."downloaded_at"  IS 'Claim atomico de entrega unica (6.6). Card #6.3.';
COMMENT ON COLUMN "jobs"."expires_at"     IS 'TTL do output pro cleanup (6.7). Setado pela app. Card #6.3.';

-- ============================================================================
-- ÍNDICE PARCIAL idx_jobs_expires_at (cleanup 6.7): movido pra migration
-- DEDICADA `20260621232846_card_6_3_jobs_expires_idx.sql` — CONCURRENTLY não
-- roda em transação e precisa ser aplicado via MCP execute_sql como statement
-- único. Artefato de 1ª classe (M-02) pra DR/CI reconstruírem o índice.
-- ============================================================================

-- ============================================================================
-- EXPAND-CONTRACT: este card e EXPAND PURO. Tudo aditivo+nullable, sem coluna
-- removida/renomeada → NAO ha fase CONTRACT futura. Nada a droppar depois.
--
-- (Opcional, pos-launch com volume) se decidirem expires_at NOT NULL:
--   UPDATE jobs SET expires_at = COALESCE(expires_at, created_at + interval '7 days')
--     WHERE expires_at IS NULL;
--   ALTER TABLE jobs ADD CONSTRAINT jobs_expires_at_nn CHECK (expires_at IS NOT NULL) NOT VALID;
--   ALTER TABLE jobs VALIDATE CONSTRAINT jobs_expires_at_nn;
--   ALTER TABLE jobs ALTER COLUMN expires_at SET NOT NULL;
--   ALTER TABLE jobs DROP CONSTRAINT jobs_expires_at_nn;
-- ============================================================================

-- ============================================================================
-- ROLLBACK (EXPAND e backward-compat: reverter o CODIGO basta; schema expandido
-- nao precisa ser tocado). Down so se necessario, fora de transacao p/ o indice:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_expires_at;
--   ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_output_format_check;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS expires_at;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS inputs_purged_at;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS downloaded_at;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS output_size;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS output_format;
-- ============================================================================
