-- =============================================================================
-- Card 5.1 — Adapter de storage (Fase 5 — Storage)
-- =============================================================================
-- Cria bucket privado `tablix-history-staging` + 4 RLS policies user-scoped.
-- Registrado em arquivo versionado (fix-pack @devops MÉDIO `missing-iac`)
-- pra:
--   1. Documentar o estado real do Supabase Storage no repo
--   2. Permitir reaplicar em ambiente novo (DR, novo dev local) sem MCP
--   3. Permitir drift detection futura
--
-- Aplicação real foi via MCP supabase em 2026-04-26 (apply_migration pro
-- bucket; execute_sql pras policies — apply_migration falhou pras policies
-- por ownership de storage.objects). Este arquivo é a SSOT versionada;
-- idempotente por construção (ON CONFLICT DO NOTHING + IF NOT EXISTS).
--
-- Bucket prod (`tablix-history-prod`) será criado na Fase 7 — Infra & Deploy.
--
-- Hard requirements cobertos (auditoria @security pré-implementação):
--   #1 bucket privado (public=false)
--   #2 path scope user (RLS policies usam storage.foldername(name)[1])
--   #3 RLS ativa mesmo com bypass do backend (defense in depth contra
--      anon key uso futuro)
--   #5 file_size_limit 10MB + allowed_mime_types whitelist (csv/xlsx/xls)
-- =============================================================================

-- 1) Bucket privado com limites — idempotente
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tablix-history-staging',
  'tablix-history-staging',
  false,
  10485760, -- 10 MB
  ARRAY[
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

-- 2) RLS policies — defense in depth user-scoped
-- Pattern: usuário lê/escreve apenas no prefixo {auth.uid()}/*
-- Backend usa service_role e bypassa RLS por design.
--
-- DROP IF EXISTS + CREATE garante idempotência (PG não tem CREATE POLICY
-- IF NOT EXISTS antes de PG 15; pattern conservador funciona em qualquer
-- versão e re-aplica config atualizada).

DROP POLICY IF EXISTS "tablix_history_staging_select_own_folder"
  ON storage.objects;
CREATE POLICY "tablix_history_staging_select_own_folder"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'tablix-history-staging'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "tablix_history_staging_insert_own_folder"
  ON storage.objects;
CREATE POLICY "tablix_history_staging_insert_own_folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'tablix-history-staging'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "tablix_history_staging_update_own_folder"
  ON storage.objects;
CREATE POLICY "tablix_history_staging_update_own_folder"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'tablix-history-staging'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'tablix-history-staging'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "tablix_history_staging_delete_own_folder"
  ON storage.objects;
CREATE POLICY "tablix_history_staging_delete_own_folder"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'tablix-history-staging'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- =============================================================================
-- ROLLBACK plan (manual, não automatizado)
-- =============================================================================
-- DROP POLICY tablix_history_staging_{select,insert,update,delete}_own_folder
--   ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'tablix-history-staging';
-- (objetos deletados em cascade)
-- =============================================================================
