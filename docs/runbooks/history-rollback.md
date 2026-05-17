# Runbook — History Feature Rollback

Procedimento de rollback completo ou parcial da feature de histórico de arquivos (Card #145 5.2a + 5.2b + 5.2c). Cobre 3 níveis: rollback de runtime (zero deploy), rollback de schema (com deploy), restore from backup.

> **Princípio:** rollback é **um** dos caminhos. Os outros são "rolar pra frente" (corrigir e seguir) e "restore from snapshot". Histórico opt-in nasceu com kill-switches no boot exatamente pra zero-deploy rollback ser a primeira opção.

---

## Detecção (quando rollback é necessário)

### Triggers válidos pra rollback

- Bug funcional grave na rota `/user/history/*` reportado por usuários PRO.
- Vazamento de PII descoberto (LGPD Art. 46 — segurança).
- Performance regression mensurável (P95 > 2× baseline) bloqueando outras features.
- Custo Supabase Storage explodiu inesperadamente (pricing anomaly).
- Decisão de produto pra remover feature.

### NÃO é trigger válido (use forward-fix)

- Findings do pipeline pós-merge (rodar smart re-run + fix-pack).
- Bug de UX no front (Card CROSS-REPO `tablix-front`, não rollback do back).
- Edge case isolado num user específico (debug + waiver).

---

## Decision tree

```
Rollback necessário?
├─ Tudo OK exceto cron de purga?
│  └─ NÍVEL 1: kill-switch CRON_PURGE_ENABLED=false. Zero deploy.
│
├─ Endpoint /user/history/* problemático mas schema OK?
│  └─ NÍVEL 2: kill-switch HISTORY_FEATURE_ENABLED=false. Zero deploy.
│     Rotas retornam 403 FEATURE_DISABLED (D#4 do plano).
│
├─ Schema novo (`file_history` table) precisa ser revertido?
│  └─ NÍVEL 3: rollback de migration com deploy. Ver passos abaixo.
│
└─ Dados purgados que precisam voltar?
   └─ NÍVEL 4: restore PITR Postgres + Storage backup. Ver `purge-overshoot.md`.
```

---

## NÍVEL 1 — Kill-switch cron de purga (recovery rápido)

```bash
fly secrets set CRON_PURGE_ENABLED=false --app tablix-back
fly deploy --app tablix-back  # secret novo exige restart
```

**Efeito**: cron `history-purge` registra `enabled: false` no boot. Próxima janela cron emite `cron.run.skipped.feature_disabled` (info, sem alerta). Soft-deletes existentes ficam intactos (NÃO viram hard-delete).

**Validação**: `GET /admin/jobs/list` → `jobs[history-purge].enabled: false`.

**Reverter**: `fly secrets set CRON_PURGE_ENABLED=true && fly deploy`.

---

## NÍVEL 2 — Kill-switch feature completa

```bash
fly secrets set HISTORY_FEATURE_ENABLED=false --app tablix-back
fly deploy --app tablix-back
```

**Efeito**:
- Endpoints `POST /user/history/enable`, `POST /user/history/disable` retornam `403 FEATURE_DISABLED`.
- `GET /user/history`, `GET /user/history/:id` retornam `403 FEATURE_DISABLED` (invariante D#4 do plano #145).
- `DELETE /user/history/:id`, `DELETE /user/history` retornam `403 FEATURE_DISABLED`.
- Cron `history-purge` permanece registrado mas pode ser desligado em paralelo (NÍVEL 1).
- Dados existentes na tabela `file_history` permanecem inalterados.

**Validação**: smoke test
```bash
curl -X GET https://api.tablix.com.br/user/history \
  -H "Authorization: Bearer $USER_JWT"
# Esperar: 403 { error: { code: "FEATURE_DISABLED", ... } }
```

**Comunicação**: usuários PRO precisam saber que histórico foi desabilitado temporariamente. Email (Resend) + status page.

---

## NÍVEL 3 — Rollback de schema (com deploy)

Aplicar **APENAS** se NÍVEL 1+2 não forem suficientes. Schema `file_history` é additive (expand-only) — drop é seguro mas IRREVERSÍVEL sem backup.

### Pré-checks

- [ ] Backup PITR do Postgres confirmado (Supabase Dashboard → Database → Backups).
- [ ] Snapshot da tabela `file_history` exportado: `pg_dump --table=file_history $DATABASE_URL > backup-file-history-$(date +%Y%m%d-%H%M).sql`.
- [ ] **Validar backup positivo (NÃO ASSUMIR)**:
  ```bash
  wc -c backup-file-history-*.sql              # esperar > 1000 bytes
  psql -d $STAGING_DB_URL < backup-file-history-*.sql
  psql -d $STAGING_DB_URL -c "\d file_history"  # esperar listar tabela
  ```
  Se qualquer um dos 3 comandos falhar/retornar vazio: **NÃO prosseguir com DROP**.
- [ ] Kill-switches NÍVEL 1+2 já aplicados (zero requests novos).
- [ ] Janela de release aberta (`change-window-standard` no Trello).
- [ ] @dba + operador principal aprovaram.

### Migration de rollback

**ORDEM OBRIGATÓRIA**: `DROP INDEX CONCURRENTLY` PRIMEIRO (fora da transação),
depois `BEGIN/COMMIT` com policies/tabela/colunas. `CONCURRENTLY` aborta
qualquer transação enclosing com `ERROR: DROP INDEX CONCURRENTLY cannot run
inside a transaction block`.

**Passo 1 — DROP INDEX CONCURRENTLY (statements separados, fora de tx)**

```sql
-- Cada statement roda em sua própria implicit transaction. NÃO envolver
-- em BEGIN/COMMIT — Postgres rejeita CONCURRENTLY dentro de bloco tx.
DROP INDEX CONCURRENTLY IF EXISTS ix_filehistory_expires_active;
DROP INDEX CONCURRENTLY IF EXISTS ix_filehistory_purge_pending;
```

**Passo 2 — DROP policies + tabela + colunas (em transação única)**

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- (1) Drop policies RLS
DROP POLICY IF EXISTS "file_history_owner_select" ON file_history;
DROP POLICY IF EXISTS "file_history_owner_insert" ON file_history;
DROP POLICY IF EXISTS "file_history_owner_update" ON file_history;
DROP POLICY IF EXISTS "file_history_owner_delete" ON file_history;

-- (2) Drop tabela. CASCADE removeria índices remanescentes (caso passo 1
-- tenha falhado parcialmente — fail-safe).
DROP TABLE IF EXISTS file_history CASCADE;

-- (3) Drop colunas opt-in do User
ALTER TABLE users
  DROP COLUMN IF EXISTS history_opt_in,
  DROP COLUMN IF EXISTS history_opt_in_at,
  DROP COLUMN IF EXISTS history_opt_out_at;

COMMIT;
```

### Deploy do código antigo

```bash
# Identificar commit anterior à F1 do Card #145 (schema FileHistory)
git log --oneline | grep -B1 "2df9426"  # F1 commit
# Commit anterior: 67b1113 (snapshot Card #150)

# Branch de rollback
git checkout -b rollback/card-145-file-history 67b1113

# Deploy
fly deploy --app tablix-back

# Quando confirmar rollback OK, merge na main via PR de emergência.
```

### Validação pós-rollback

```bash
# 1. Verificar schema
psql $DATABASE_URL -c "\d users"  # NÃO deve ter history_opt_in
psql $DATABASE_URL -c "\d file_history"  # deve retornar erro "relation does not exist"

# 2. Smoke test endpoints
curl -X GET https://api.tablix.com.br/user/history \
  -H "Authorization: Bearer $USER_JWT"
# Esperar: 404 (rota não existe mais) ou 502/503 se app não rebooted

# 3. Cron jobs
curl -X GET https://api.tablix.com.br/admin/jobs/list \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "X-Admin-Confirm: $(scripts/compute-stepup.sh)"
# Esperar: lista vazia (jobs não registrados no boot)
```

---

## NÍVEL 4 — Restore from backup

Cobertura em `purge-overshoot.md` (cenário mais comum) e `database-rollback.md` (procedimentos PITR).

### Resumo

1. **Postgres**: PITR via Supabase Dashboard → janela de até 7 dias (plano atual).
2. **Storage**: Supabase Storage **não tem versioning nativo**. Backup automático = decisão da Fase 9 (#150 + Card 9.x). Pré-go-live: assumir IRREVERSÍVEL.
3. **Reupload pelo usuário**: último recurso. Email com instruções + extensão de plano como compensação.

---

## Action items pós-rollback

- [ ] Postmortem **obrigatório em 48h** (template em `release-window.md`).
- [ ] Comunicação ao usuário final (email + status page) se NÍVEL ≥ 2.
- [ ] Decisão registrada no Trello: "rollback foi correto vs poderia ter sido forward-fix?".
- [ ] Se rollback recorrente da feature → bloquear re-deploy até root cause resolvido.
- [ ] Atualizar este runbook com lições aprendidas.

---

## Referências

- Card #145 (5.2a) — F1 schema + F2 env + F3 service/controller + F4 scheduler + F5 observability.
- Card #146 (5.2b) — cron purge two-phase.
- Card #147 (5.2c) — cron alerta quota.
- `docs/runbooks/database-rollback.md` — procedimentos PITR.
- `docs/runbooks/release-window.md` — template postmortem + janela formal.
