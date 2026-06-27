-- =============================================================================
-- ROLLBACK (down) — Card 5.1 storage bucket history
-- Par do up: ../20260426000001_card_5_1_storage_bucket_history.sql
-- Card 7.14 — rollback script automatizado pras storage migrations
-- =============================================================================
--
-- ⚠ DESTRUTIVO E IRREVERSÍVEL. LER docs/runbooks/storage-rollback.md ANTES.
--
-- IMPORTANTE — ESTE SCRIPT SÓ LIMPA METADATA + BUCKET + POLICIES.
-- Os BINÁRIOS dos objetos vivem no object store do Supabase Storage e NÃO são
-- removidos por `DELETE FROM storage.objects` (isso apaga só a linha de metadata).
-- O bucket DEVE ser esvaziado ANTES pela Storage API (Passo 0 do runbook:
-- `supabase storage rm --recursive` / endpoint DELETE). Rodar só este SQL deixa
-- blobs órfãos consumindo storage E não cumpre apagamento LGPD.
-- (A FK storage.objects.bucket_id → storage.buckets é NO ACTION, não CASCADE —
--  por isso objetos saem antes do bucket; não há cascade.)
--
-- SAFE-BY-DEFAULT (psql variables — NÃO se edita o arquivo):
--   DRY-RUN (default, não deleta):  psql "$DIRECT_URL" -f <este>
--   REAL (destrutivo):              psql "$DIRECT_URL" \
--                                     -v dry_run=false -v backup_confirmed=true -f <este>
--
-- `-v bucket=` parametriza só os DELETE de objetos/bucket. Os DROP POLICY abaixo
-- têm nomes FIXOS do bucket staging. NÃO rode este arquivo com -v bucket=prod —
-- o bucket de prod (7.13) tem seu PRÓPRIO down gêmeo (prefixo de policy
-- tablix_history_prod_*). Aqui o -v bucket existe só pra assertir o alvo staging.
--
-- Rodar com role que gerencia storage.objects. O `postgres` do DIRECT_URL
-- consegue (as 4 policies da up foram criadas como postgres) e tem DELETE em
-- storage.objects — pré-flight no runbook confirma. NÃO usar o pooler (DDL).
-- =============================================================================

\set ON_ERROR_STOP on

-- Defaults seguros — só aplicados se o operador NÃO passar via -v (o -v vence).
\if :{?dry_run}
\else
  \set dry_run true
\endif
\if :{?backup_confirmed}
\else
  \set backup_confirmed false
\endif
\if :{?bucket}
\else
  \set bucket tablix-history-staging
\endif

\echo '=== storage-rollback — bucket alvo:' :'bucket' '==='

-- Blast radius (metadata; os blobs já devem ter saído pela Storage API no Passo 0).
SELECT :'bucket' AS bucket, count(*) AS object_metadata_rows
FROM storage.objects WHERE bucket_id = :'bucket';

-- Freio 1 — DRY-RUN é o default. Sai aqui sem tocar em nada.
\if :dry_run
  \echo 'DRY-RUN (default): nada deletado. Para executar de verdade:'
  \echo '  -v dry_run=false -v backup_confirmed=true'
  \q
\endif

-- Freio 2 — rollback real exige atestação consciente de backup (Passo 0).
\if :backup_confirmed
\else
  \echo 'ABORT: rollback real exige -v backup_confirmed=true.'
  \echo 'Confirme backup dos objetos + esvaziamento via Storage API (runbook Passo 0).'
  \q
\endif

-- Execução real — transação única (tudo ou nada).
BEGIN;
DELETE FROM storage.objects WHERE bucket_id = :'bucket';
DELETE FROM storage.buckets WHERE id = :'bucket';
-- Policies user-scoped da up (nomes fixos do bucket staging; o twin de prod do
-- Card 7.13 ajusta o prefixo). Idempotente (IF EXISTS).
DROP POLICY IF EXISTS "tablix_history_staging_select_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "tablix_history_staging_insert_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "tablix_history_staging_update_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "tablix_history_staging_delete_own_folder" ON storage.objects;
COMMIT;

-- Verificação pós-rollback (pg_policies usa `policyname`, não `polname`).
\echo '=== verificação (esperado: 0, 0, 0 linhas) ==='
SELECT count(*) AS buckets_remaining     FROM storage.buckets WHERE id = :'bucket';
SELECT count(*) AS object_rows_remaining FROM storage.objects WHERE bucket_id = :'bucket';
SELECT policyname FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname LIKE 'tablix_history_staging_%';
