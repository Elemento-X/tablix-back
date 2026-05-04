# Baseline pré-Fase 3 — Snapshot 2026-04-24T14:42:42Z

Captura forense do estado do banco IMEDIATAMENTE antes da aplicação das 3 migrations da Fase 3 (TIMESTAMPTZ + UUID native + drop orphan indexes). Serve como ponto de comparação pós-migration e evidência de pré-requisitos para auditoria de pipeline.

> **Tabelas vazias** — pré-go-live, sem dados de produção. Isso simplifica drasticamente a operação: ALTER COLUMN TYPE em tabela vazia é metadata-only (rápido, lock por milissegundos), pg_dump trivial, baseline EXPLAIN irrelevante (planner usa seq scan em qualquer tabela vazia).

---

## Volume das tabelas

| Tabela | Linhas |
|---|---|
| users | 0 |
| sessions | 0 |
| tokens | 0 |
| usage | 0 |
| jobs | 0 |
| stripe_events | 0 |
| audit_log | 0 |

**Implicações:**
- ALTER COLUMN TYPE = metadata-only operation. Sem rewrite pesado. Lock ACCESS EXCLUSIVE adquirido por <100ms.
- pg_dump das tabelas afetadas = 0 bytes de dados. Estrutura preservada via SQL files versionados.
- Baseline EXPLAIN ANALYZE ignorável (plan = seq scan trivial em tudo).
- Risco de timeout do MCP = praticamente nulo.

---

## Configuração do servidor

| Setting | Valor |
|---|---|
| `current_setting('timezone')` | `UTC` |
| `pg_database_size(current_database())` | `11 MB` (overhead Supabase) |
| `current_database()` | `postgres` |
| Snapshot timestamp | `2026-04-24T14:42:42.957Z` |

**TZ=UTC valida estratégia da Migration A:** `ALTER COLUMN ... TYPE timestamptz(3) USING (col AT TIME ZONE 'UTC')` é semanticamente correto sem ambiguidade. Aplicação SEMPRE escreveu em UTC.

---

## Conexões ativas (pg_stat_activity)

Snapshot pré-migration mostrou apenas conexões internas Supabase:

| PID | Application | Estado | Wait |
|---|---|---|---|
| 4539 | `pg_net 0.19.5` | (extension) | Extension |
| 4540 | `pg_cron scheduler` | (extension) | Extension |
| 4556 | `postgrest` | idle | ClientRead |
| 4946 | `postgres_exporter` | idle | ClientRead |
| 7206 | (anônimo, observer) | idle | ClientRead |

**Zero conexões da aplicação Tablix.** Não há necessidade de drenar/terminar conexões antes da janela.

---

## Validação empírica de índices órfãos

`pg_stat_user_indexes` confirma que os 2 índices marcados como redundantes nunca foram usados:

| Índice | idx_scan | idx_tup_read | Tamanho |
|---|---|---|---|
| `tokens_token_idx` | 0 | 0 | 8192 bytes |
| `tokens_token_key` | 0 | 0 | 8192 bytes |
| `idx_usage_token_period` | 0 | 0 | 8192 bytes |
| `usage_user_id_period_key` | 0 | 0 | 8192 bytes |

`idx_scan = 0` em todos. DROP de `tokens_token_idx` e `idx_usage_token_period` (Migration C) não afeta query existente — não há query existente.

Quando o tráfego começar (Fase 8+), o planner escolherá os UNIQUE remanescentes (`tokens_token_key`, `usage_user_id_period_key`).

---

## Foreign keys em users.id (a serem dropadas/recriadas na Migration B)

| Constraint | Tabela | Definição |
|---|---|---|
| `jobs_user_id_fkey` | jobs | `FK (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE` |
| `sessions_user_id_fkey` | sessions | `FK (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE` |
| `tokens_user_id_fkey` | tokens | `FK (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT` |
| `usage_user_id_fkey` | usage | `FK (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT` |

Migration B preserva semântica `ON UPDATE/DELETE` exata na recriação.

---

## Estado dos tipos antes da migration

Confirmado via `information_schema.columns`:

- **PKs (id) e FKs (user_id)** em users/sessions/tokens/usage/jobs: todos `text` com `udt_name='text'` e `column_default='gen_random_uuid()'` (PKs).
- **Colunas de tempo** (`*_at`): todas `timestamp without time zone`, `udt_name='timestamp'`, com `column_default='CURRENT_TIMESTAMP'` onde aplicável.
- **stripe_events.processed_at** e **audit_log.created_at**: já `timestamp with time zone` (corrigidos em cards anteriores).
- **audit_log.id**: já `uuid` nativo (corrigido em Card 2.4).

Estado pós-migration esperado documentado em cada arquivo `supabase/migrations/20260424120{0,1,2}00_*.sql`.

---

## Procedimentos não-aplicáveis nesta janela

- **pg_dump das tabelas afetadas** — desnecessário, todas vazias. Estrutura preservada via SQL versionado em `supabase/migrations/`.
- **PITR snapshot** — Free tier não suporta. Para Fase 8+ com dados reais, considerar upgrade temporário Pro tier antes de migrations destrutivas.
- **Drenagem de conexões da app** — nenhuma conexão de app ativa.
- **Webhook Stripe disable** — recomendado por padrão, mas tabelas afetadas (users/sessions/tokens/usage/jobs) não recebem inserts de webhook em momento algum (webhook só toca stripe_events e audit_log). Manter habilitado é seguro.

---

## Comandos para reproduzir snapshot pós-migration

```sql
-- Volume + setup
SELECT
  (SELECT count(*) FROM users) AS users_count,
  (SELECT count(*) FROM sessions) AS sessions_count,
  (SELECT count(*) FROM tokens) AS tokens_count,
  (SELECT count(*) FROM usage) AS usage_count,
  (SELECT count(*) FROM jobs) AS jobs_count,
  current_setting('timezone') AS server_timezone,
  pg_size_pretty(pg_database_size(current_database())) AS db_size,
  now() AS snapshot_taken_at;

-- Tipos pós-migration (esperado: uuid + timestamptz)
SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('users','sessions','tokens','usage','jobs')
  AND (column_name IN ('id','user_id') OR column_name LIKE '%_at%')
ORDER BY table_name, column_name;

-- FKs preservadas
SELECT conname, conrelid::regclass, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'f' AND confrelid = 'public.users'::regclass;

-- Índices pós-DROP (esperado: tokens_token_idx e idx_usage_token_period AUSENTES)
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('tokens','usage')
ORDER BY tablename, indexname;
```
