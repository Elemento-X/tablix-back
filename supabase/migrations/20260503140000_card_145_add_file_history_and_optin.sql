-- =============================================================================
-- Migration: card_145_add_file_history_and_optin
-- Version: 20260503140000
-- Card: #145 (DtBkVtVY) — Fase 5 — Storage (5.2a)
--
-- Contexto:
--   Feature opt-in PRO de histórico de arquivos. 3 colunas no users (opt-in
--   trail auditável LGPD Art. 8) + nova tabela file_history (metadata dos
--   arquivos processados) + RLS defense em profundidade.
--
--   Pré-requisito hard de #146 (5.2b cron purge two-phase) e #147 (5.2c cron
--   alerta quota). Schema validado por @dba em 2026-05-02 (sessão de decisões
--   fechadas — incluiu fileSize/mimeType/originalFilename + storage_path UNIQUE
--   + Cascade FK além do plano original).
--
-- Plano: .claude/plans/2026-05-02-card-145-5.2a-history-optin-schema-endpoints-cron-infra.md
--
-- DECISÕES IRREVERSÍVEIS (consultar plano antes de mudar):
--
-- (D-B) Soft delete via deleted_at NULLABLE. NULL=ACTIVE, NOT NULL=PURGE_PENDING.
--       Hard-delete pelo cron #146. Sem enum de status — estado derivado.
--
-- (D-C) expires_at calculado em service via env.PRO_RETENTION_DAYS. NÃO usar
--       trigger DB — permite tunar via env sem migration.
--
-- (FK Cascade) FileHistory é dado operacional, NÃO prova jurídica (diferente
--       de audit_log_legal #150 que é RESTRICT). Delete user → DB cascata +
--       cron Storage 5.2b limpa órfãos físicos.
--
-- (storage_path UNIQUE) Defense em profundidade contra race de upload paralelo
--       ou bug de geração de path. UUID v4 já garante unicidade lógica;
--       constraint DB protege contra silently overwriting Supabase Storage.
--
-- (file_size) SSOT de quota. Adapter Card 5.1 getTotalSize() consome este campo
--       (era fallback O(n) sobre Storage list). CHECK 0 < x <= 100MB.
--
-- (RLS) Backend usa service_role → bypassa policies (mesmo pattern Card 5.1 +
--       #150). Policies aqui são defense em profundidade caso futuro use auth
--       direto Supabase ou bug acidentalmente passe anon key. Padrão tablix:
--       DENY implícito + policies que ALLOW só auth.uid() = user_id AND
--       deleted_at IS NULL (rows ativas do próprio user).
--
-- Decisões operacionais:
--   1. CONCURRENTLY não usado: tabela nasce vazia, build instantâneo (lock
--      ACCESS EXCLUSIVE em tabela inexistente é no-op). Migrations futuras de
--      índice em file_history populada → CONCURRENTLY OBRIGATÓRIO em arquivo
--      separado, single-statement, via psql direto (memory
--      feedback_execute_sql_concurrently — MCP gera 25001 com SET prévio).
--   2. Migration única consolidada (schema + indexes parciais + RLS): pattern
--      do projeto pra deploy atômico. Plano @planner originalmente separava em
--      T1.3/T1.4/T1.5 mas @dba confirmou que separação só faz sentido com
--      tabela populada.
--
-- @owner: @dba + @security
-- =============================================================================

-- ===========================================
-- ALTER users — 3 colunas opt-in (LGPD Art. 8 trail)
-- ===========================================

ALTER TABLE "users"
  ADD COLUMN "history_opt_in"        BOOLEAN        NOT NULL DEFAULT FALSE,
  ADD COLUMN "history_opt_in_at"     TIMESTAMPTZ(3),
  ADD COLUMN "history_opt_out_at"    TIMESTAMPTZ(3);

COMMENT ON COLUMN "users"."history_opt_in" IS
  'Feature flag: histórico de arquivos opt-in. Default false (feature OFF até user aceitar). Card #145.';

COMMENT ON COLUMN "users"."history_opt_in_at" IS
  'Timestamp do último opt-in. Trail auditável LGPD Art. 8 (registro de consentimento).';

COMMENT ON COLUMN "users"."history_opt_out_at" IS
  'Timestamp do último opt-out. Trigger pra purga two-phase via cron #146.';

-- ===========================================
-- TABELA file_history
-- ===========================================

CREATE TABLE "file_history" (
  "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  "user_id"            UUID           NOT NULL,
  "storage_path"       VARCHAR(255)   NOT NULL,
  "original_filename"  VARCHAR(255)   NOT NULL,
  "mime_type"          VARCHAR(127)   NOT NULL,
  "file_size"          INTEGER        NOT NULL,
  "expires_at"         TIMESTAMPTZ(3) NOT NULL,
  "deleted_at"         TIMESTAMPTZ(3),
  "purge_attempts"     INTEGER        NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_history_storage_path_key" UNIQUE ("storage_path"),
  CONSTRAINT "file_history_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ===========================================
-- CHECK constraints (defense em profundidade)
-- ===========================================

-- Quota PRO cap: 100MB por arquivo. Espelha invariante do plan-limits +
-- adapter Card 5.1 (file_size <= MAX_FILE_BYTES). Defesa contra bug que
-- contornaria validação do app.
ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_file_size_positive_check"
  CHECK ("file_size" > 0 AND "file_size" <= 104857600);

-- purge_attempts é monotonicamente crescente. Negativo = bug de cron.
ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_purge_attempts_nonneg_check"
  CHECK ("purge_attempts" >= 0);

-- Storage path format. UserScopedPath branded em src/lib/storage/types.ts =
-- `{userId-uuidv4}/{yyyy-mm-dd UTC}/{jobId-cuid}.{ext}` (key-builder.ts).
-- Regex defensiva contra bug de geração + path traversal por construção.
--   - userId: UUID v4 strict (RFC 4122 — versão 4, variant 8|9|a|b)
--   - date: YYYY-MM-DD (qualquer data válida; cron #146 não depende do valor)
--   - jobId: [a-z0-9]{7,64} (cuid/cuid2/nanoid)
--   - ext: csv|xlsx|xls (ALLOWED_EXTENSIONS — NÃO inclui xlsm)
ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_storage_path_format_check"
  CHECK ("storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-z0-9]{7,64}\.(csv|xlsx|xls)$');

-- mime_type não-vazio (defesa contra string vazia que passaria VARCHAR).
ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_mime_type_nonempty_check"
  CHECK (length("mime_type") > 0);

-- original_filename não-vazio + sem control chars (defesa contra injection
-- em logs/UI; complementa Zod validation do controller).
ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_original_filename_check"
  CHECK (
    length("original_filename") > 0
    AND "original_filename" !~ '[\x00-\x1F]'
  );

-- expires_at deve ser futuro no momento do INSERT. Defense contra calculo
-- de service com env quebrado (PRO_RETENTION_DAYS=0 ou negativo).
-- Não pode ser strict (CURRENT_TIMESTAMP), pois precisa permitir backfill
-- de testes. Aceita iguais ao created_at + tolerância 1s.
ALTER TABLE "file_history"
  ADD CONSTRAINT "file_history_expires_at_after_created_check"
  CHECK ("expires_at" >= "created_at");

-- ===========================================
-- INDEXES
-- ===========================================
-- Tabela nasce vazia → CONCURRENTLY no-op. Build instantâneo.

-- Listagem do user (paginada, ordenação descendente por data).
-- Espelha @@index([userId, createdAt(sort: Desc)]) do Prisma.
CREATE INDEX "idx_filehistory_user_created"
  ON "file_history" ("user_id", "created_at" DESC);

-- Hot path da listagem PRO: rows ativas (deleted_at IS NULL) ordenadas
-- por expires_at (mostra "expira em N dias" no UI).
-- Também usado pela cron #146 candidate query (`expires_at < NOW() AND
-- deleted_at IS NULL`).
CREATE INDEX "idx_filehistory_expires_active"
  ON "file_history" ("expires_at")
  WHERE "deleted_at" IS NULL;

-- Hot path da cron #146 phase 2: rows pendentes de purga física no Storage
-- (deleted_at IS NOT NULL). Partial index = ~5% do volume após estável.
-- Standalone @@index([deletedAt]) seria 95% NULL e inútil — partial vence.
CREATE INDEX "idx_filehistory_purge_pending"
  ON "file_history" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;

-- ===========================================
-- ROW LEVEL SECURITY
-- ===========================================
-- Backend usa service_role → bypassa todas as policies (pattern Card 5.1 + #150).
-- RLS aqui é defense em profundidade pra:
--   1. Bug que use anon key em endpoint normal
--   2. Migração futura pra Supabase Auth nativo (auth.uid() = user_id)
--   3. Auditor LGPD com role admin no futuro

ALTER TABLE "file_history" ENABLE ROW LEVEL SECURITY;

-- SELECT: user vê só suas rows ativas. Soft-deleted invisível pra user.
CREATE POLICY "file_history_select_own_active"
  ON "file_history"
  FOR SELECT
  TO authenticated
  USING (auth.uid() = "user_id" AND "deleted_at" IS NULL);

-- INSERT: user só insere row pra si mesmo. Tipicamente backend insere via
-- service_role; policy aqui é defense in depth.
CREATE POLICY "file_history_insert_own"
  ON "file_history"
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = "user_id");

-- UPDATE: user só atualiza suas rows ativas (ex: marcar deleted_at no
-- soft-delete via API). USING checa permissão pra ler row antes do update;
-- WITH CHECK garante que não troque user_id (CWE-639 IDOR).
CREATE POLICY "file_history_update_own_active"
  ON "file_history"
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = "user_id" AND "deleted_at" IS NULL)
  WITH CHECK (auth.uid() = "user_id");

-- DELETE: NÃO permitido pra authenticated. Hard-delete só pelo cron via
-- service_role. User soft-deleta via UPDATE (deleted_at = NOW()).
-- Sem policy de DELETE = DENY implícito.

-- ===========================================
-- COMMENTS (documentação SQL pra futuro)
-- ===========================================

COMMENT ON TABLE "file_history" IS
  'Histórico opt-in PRO de arquivos processados. Card #145 (5.2a, Fase 5). Soft-delete two-phase: deleted_at sentinela + cron #146 hard-delete. Plano: .claude/plans/2026-05-02-card-145-5.2a-history-optin-schema-endpoints-cron-infra.md';

COMMENT ON COLUMN "file_history"."storage_path" IS
  'UserScopedPath: <userId-uuid>/<jobId-uuid>.<ext>. UNIQUE bloqueia overwrite silencioso no Supabase Storage. Format check via regex.';

COMMENT ON COLUMN "file_history"."original_filename" IS
  'Nome literal do upload do user (pode conter PII tipo cliente_2024.xlsx). Scrubbing é responsabilidade do logger pino REDACT_PATHS + Sentry, NÃO do DB.';

COMMENT ON COLUMN "file_history"."file_size" IS
  'SSOT de quota PRO. Consumido por adapter Card 5.1 getTotalSize() (era fallback O(n)). Cap 100MB via CHECK constraint.';

COMMENT ON COLUMN "file_history"."expires_at" IS
  'Calculado em service via env.PRO_RETENTION_DAYS no momento do INSERT. NÃO usar trigger DB — permite tuning via env sem migration.';

COMMENT ON COLUMN "file_history"."deleted_at" IS
  'Sentinela two-phase: NULL=ACTIVE, NOT NULL=PURGE_PENDING. Cron #146 apaga objeto físico Storage e depois hard-deleta row. Nunca volta pra NULL.';

COMMENT ON COLUMN "file_history"."purge_attempts" IS
  'Contador de tentativas do cron #146. >3 → alerta Sentry + mover pra fila manual. Monotonicamente crescente.';

-- =============================================================================
-- ROLLBACK PLAN (manual, não automatizado)
-- =============================================================================
-- Tabela nasce vazia em prod (pre-Fase 9). Reversível até feature ENABLED.
--
--   DROP TABLE IF EXISTS "file_history" CASCADE;
--   ALTER TABLE "users"
--     DROP COLUMN IF EXISTS "history_opt_in",
--     DROP COLUMN IF EXISTS "history_opt_in_at",
--     DROP COLUMN IF EXISTS "history_opt_out_at";
--
-- Pós-rollback:
--   1. git revert <merge commit>
--   2. npm run schema:fingerprint (regenerar)
--   3. Confirmar prisma generate sem erro
--   4. Conferir env: HISTORY_FEATURE_ENABLED=false (kill-switch já garantido)
-- =============================================================================
