# Runbook — Rollback de Storage migrations (bucket + policies)

Procedimento para **desfazer** as migrations de Supabase Storage (bucket privado
+ RLS policies user-scoped) do Tablix. Par executável das migrations em
`supabase/migrations/rollback/`. Card 7.14.

> ⚠ **DESTRUTIVO E IRREVERSÍVEL.** O Supabase Storage **não** está no PITR
> (point-in-time recovery) do Postgres. Objetos deletados aqui **não voltam** por
> PITR.

> 🔑 **O SQL sozinho NÃO apaga os arquivos.** Em Supabase, `storage.objects` é só
> a **metadata**; o binário do arquivo vive no object store (S3) e só sai pela
> **Storage API**. Por isso o rollback tem 2 fases: **(0) esvaziar o bucket pela
> Storage API** (apaga blobs) e **(1) rodar o down.sql** (limpa metadata residual +
> bucket + policies). Rodar só o SQL deixa **blobs órfãos** consumindo storage e
> **não cumpre apagamento LGPD**. A FK `objects→buckets` é **NO ACTION** (não
> cascade) — objetos saem antes do bucket por isso.

---

## Migrations cobertas

| Migration (up) | Rollback (down) | Bucket | Policies |
|---|---|---|---|
| `20260426000001_card_5_1_storage_bucket_history.sql` | `rollback/20260426000001_card_5_1_storage_bucket_history_down.sql` | `tablix-history-staging` | 4 (select/insert/update/delete own folder) |

> Bucket de **produção** (`tablix-history-prod`) entra no Card 7.13. Ao entrar,
> criar o down gêmeo seguindo este padrão (com prefixo de policy `tablix_history_prod_*`)
> e, pelo volume de prod, aplicar o **batching** da seção "Lock & volume" abaixo.

---

## Quando rodar (e quando NÃO rodar)

**Rodar:** reverter bucket criado em ambiente errado; recriar do zero; teardown de
ambiente efêmero.

**NÃO rodar** em produção com dados reais sem: (1) backup confirmado dos objetos;
(2) janela de manutenção (`release-window.md`); (3) aprovação explícita do dono
(perda de dado do usuário — LGPD).

---

## RPO / Backup (decisão pendente — GATE de go-live, Card 7.6)

Supabase Storage **não tem backup automático nativo** no free. Antes do go-live,
decidir e implementar UMA estratégia (deixar como item bloqueante no Card 7.6):
- **Snapshot manual periódico** pra bucket S3/R2 cross-region (RPO = intervalo).
- **Replicação cross-region** (planos pagos): RPO ~contínuo.
- **Aceitar perda** (só se o histórico é reconstruível pela origem): documentar RPO=∞.

Até a decisão, o **RPO deste rollback é INDEFINIDO** — trate como perda total.

---

## Pré-flight (rodar ANTES de qualquer DELETE)

```sql
-- (a) Quem sou eu e posso mexer em storage.objects?
SELECT current_user,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
       has_table_privilege(current_user, 'storage.objects', 'DELETE')    AS can_delete_objects;
-- esperado: postgres / true / true
```
O `postgres` do `DIRECT_URL` consegue dropar as policies (foram **criadas** como
postgres na up) e deletar objetos. Se `can_delete_objects` vier `false` ou o
`DROP POLICY` falhar com `must be owner of table objects`, rode a fase SQL via
**MCP `execute_sql`** / SQL editor do dashboard (mesmo caminho privilegiado que
criou as policies na up), não via psql direto.

---

## Procedimento

### Passo 0 — Backup + esvaziar o bucket pela Storage API (apaga os blobs)
Sem isto, os arquivos do usuário continuam no object store mesmo após o SQL.
```bash
# 1) Backup (se houver dado real) — baixar os objetos antes de apagar:
supabase storage cp --recursive "ss:///tablix-history-staging" ./backup-tablix-history-$(date +%F)
#    (ou a estratégia de backup fechada no Card 7.6)

# 2) Esvaziar o bucket pela Storage API (REMOVE os blobs + metadata):
supabase storage rm --recursive "ss:///tablix-history-staging"
```
> Sem Supabase CLI, usar o endpoint REST `DELETE /storage/v1/object/...` com a
> `SUPABASE_STORAGE_KEY` (service key). O dashboard (Storage → bucket → Empty
> bucket) também esvazia.

### Passo 1 — DRY-RUN do SQL (default seguro, não deleta nada)
```bash
psql "$DIRECT_URL" -f supabase/migrations/rollback/20260426000001_card_5_1_storage_bucket_history_down.sql
# imprime object_metadata_rows=N e sai (DRY-RUN). N deve ser ~0 após o Passo 0.
```
Use `DIRECT_URL` (conexão direta) — o pgbouncer transaction-mode não serve pra DDL.

### Passo 2 — Rollback real (limpa metadata residual + bucket + policies)
Safe-by-default: o real exige DUAS flags explícitas (sem editar o arquivo):
```bash
psql "$DIRECT_URL" \
  -v dry_run=false -v backup_confirmed=true \
  -f supabase/migrations/rollback/20260426000001_card_5_1_storage_bucket_history_down.sql \
  | tee "rollback-storage-$(date +%FT%H%M%S).log"
```
Tudo numa transação (`BEGIN`/`COMMIT`). O `tee` guarda a trilha (ver Audit trail).
Para o bucket de **prod** (7.13): use o **down gêmeo** dele (não este arquivo com
`-v bucket=prod` — os `DROP POLICY` aqui têm nomes fixos de staging).

### Passo 3 — Verificação (o próprio script imprime; esperado tudo 0)
```sql
SELECT count(*) FROM storage.buckets  WHERE id = 'tablix-history-staging';         -- 0
SELECT count(*) FROM storage.objects  WHERE bucket_id = 'tablix-history-staging';  -- 0
SELECT policyname FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND policyname LIKE 'tablix_history_staging_%';                                -- 0 linhas
```

---

## Audit trail (operação LGPD-sensível)
- Guardar o `.log` do `tee` (Passo 2) no ticket da operação.
- Registrar no ticket: operador, timestamp, aprovador, `object_metadata_rows`
  deletados, e confirmação do backup do Passo 0.

---

## Lock & volume (relevante pro bucket de prod, Card 7.13)
- `storage.objects` é **tabela única** compartilhada por todos os buckets do projeto.
- `DELETE ... WHERE bucket_id` em bucket grande = transação longa (segura xmin
  horizon, impede autovacuum, gera bloat) + `DROP POLICY` pega ACCESS EXCLUSIVE
  bloqueando todo o Storage durante a transação.
- Para `tablix-history-staging` (poucos objetos) é desprezível. Para **prod**:
  deletar metadata em **batches** (`DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT 5000)`
  em loop, FORA da transação do DROP POLICY) e separar o DROP POLICY do mass DELETE.

---

## Janela de risco
- **Sem dual-key grace**: o bucket some no `COMMIT`. O backend (StorageAdapter)
  passa a falhar todo upload/download de histórico **imediatamente**. Coordene com
  a feature de history desligada ou rode em janela de manutenção.
- URLs assinadas pré-emitidas antes do rollback devem falhar após o bucket sumir
  (cross-ref `signed-url-survives-delete.md`).

---

## GATE de confiabilidade (antes de confiar no rollback em incidente)
Executar **1× em staging** o ciclo completo e registrar evidência:
Storage-API rm (Passo 0) → DRY-RUN → real → verificação → re-apply. Isso valida na
prática o privilégio do role e a remoção real dos blobs. **Rollback nunca exercido
não é rollback.** Marcar como gate de go-live (Card 7.6).

---

## Re-apply (refazer o bucket após rollback)
```bash
psql "$DIRECT_URL" -f supabase/migrations/20260426000001_card_5_1_storage_bucket_history.sql
```
A up é idempotente (recria bucket vazio + 4 policies). Os **objetos não voltam** —
restaurar do backup do Passo 0, se houver.

---

## Referências
- Up: `supabase/migrations/20260426000001_card_5_1_storage_bucket_history.sql`
- Down: `supabase/migrations/rollback/20260426000001_card_5_1_storage_bucket_history_down.sql`
- Relacionados: `database-rollback.md`, `database-migration.md`, `release-window.md`, `signed-url-survives-delete.md`.
- Card 5.1 (StorageAdapter) + Card 7.13 (bucket prod — adicionar down gêmeo + batching).
