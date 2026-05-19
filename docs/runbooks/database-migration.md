# Runbook — Database Migration

Procedimento padrão para aplicar migrations destrutivas no banco de produção (Supabase Postgres). Cobre o ciclo completo: pré-voo, execução, smoke tests, fechamento.

> **Quando usar este runbook:** toda migration que faz `ALTER TABLE`, `CREATE/DROP INDEX`, `CREATE/DROP CONSTRAINT`, ou qualquer DDL que altere o schema. Para INSERTs/UPDATEs idempotentes (seeds, backfills), use o runbook de data migration (futuro).

---

## Pré-requisitos

Antes de abrir a janela:

1. **Plano SQL aprovado pelo @dba** — todo SQL revisado e versionado em `supabase/migrations/`.
2. **Schema Prisma atualizado em branch dedicada** — sem merge antes da janela. Mudança de tipo no DB exige mudança correspondente no `prisma/schema.prisma` (`@db.Uuid`, `@db.Timestamptz(3)`, etc.) na MESMA branch.
3. **Suíte de testes verde local** — baseline pré-migration.
4. **Baseline de queries críticas** — `EXPLAIN ANALYZE` arquivado em `docs/baselines/<timestamp>-<card>.md`.
5. **Backup verificado** — em Free tier Supabase, `pg_dump` lógico das tabelas afetadas com checksum SHA-256 arquivado fora da máquina; em Pro tier, PITR habilitado e timestamp de "ponto seguro" anotado.
6. **Webhook Stripe desabilitado** (se a migration toca tabelas relacionadas: `users`, `tokens`, `stripe_events`, `audit_log`). Reabilitar pós-smoke.

---

## Pré-voo (T-15min)

```sql
-- 1. Volume + timezone + tamanho do DB
SELECT
  (SELECT count(*) FROM users) AS users_count,
  (SELECT count(*) FROM sessions) AS sessions_count,
  (SELECT count(*) FROM tokens) AS tokens_count,
  (SELECT count(*) FROM usage) AS usage_count,
  (SELECT count(*) FROM jobs) AS jobs_count,
  current_setting('timezone') AS server_timezone,
  pg_size_pretty(pg_database_size(current_database())) AS db_size,
  now() AS snapshot_taken_at;

-- 2. Conexões ativas — tudo da app DEVE estar parado
SELECT pid, application_name, client_addr, state,
       backend_start, query_start, wait_event_type, wait_event,
       left(query, 100) AS current_query
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
ORDER BY backend_start;

-- 3. Locks pendentes
SELECT * FROM pg_locks WHERE granted = false;
```

Se houver conexão de aplicação Tablix (`application_name LIKE '%prisma%'`):

```sql
-- Terminar conexão da app antes de prosseguir
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE application_name LIKE '%prisma%'
  AND datname = current_database();
```

**Critério para prosseguir:** apenas conexões internas Supabase visíveis (`pg_net`, `pg_cron`, `postgrest`, `postgres_exporter`, `realtime`).

---

## Abertura formal da janela

1. Card no Trello na coluna **Validation** com label `change-window-open`.
2. Comentário no card:

```
RELEASE WINDOW OPEN at <timestamp>
Migrations: <lista>
Owner: <você>
Estimated duration: <X> min
Rollback contact: <você>
Backup verified: <link/checksum>
```

3. Inserir audit_log:

```sql
INSERT INTO audit_log (action, actor, success, metadata)
VALUES ('MIGRATION_START', '<seu_handle>', true,
        jsonb_build_object(
          'migrations', jsonb_build_array(
            'card3_a_timestamp_to_timestamptz',
            'card3_b_uuid_native_full',
            'card3_c_drop_orphan_indexes'
          ),
          'pre_check_snapshot', jsonb_build_object(
            'users_count', 0,
            'db_size', '11 MB'
          )
        ));
```

4. **Sessão de monitoramento paralela** — abra outra aba Claude/MCP rodando esta query em loop a cada 2s durante a janela:

```sql
SELECT now(), locktype, mode, granted,
       pid, relation::regclass AS rel,
       left(query, 80) AS q
FROM pg_locks l
LEFT JOIN pg_stat_activity a USING (pid)
WHERE NOT granted
   OR mode IN ('AccessExclusiveLock','ShareRowExclusiveLock','ExclusiveLock')
ORDER BY now();
```

---

## Execução

### Migrations idempotentes (com transação) → MCP `apply_migration`

A maioria dos `ALTER TABLE` cabe aqui. O MCP envolve em transação implícita (`BEGIN/COMMIT`), o que dá atomicidade e rollback automático em falha.

```
mcp__supabase__apply_migration({
  name: "card3_a_timestamp_to_timestamptz",
  query: "<conteúdo do .sql>"
})
```

### Migrations CONCURRENTLY → MCP `execute_sql`

`CREATE/DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `VACUUM`, `ALTER TYPE ENUM ADD VALUE` — não podem rodar em transação. Use `execute_sql` (sem transação implícita) ou `psql` autocommit.

```
mcp__supabase__execute_sql({
  query: "DROP INDEX CONCURRENTLY IF EXISTS public.tokens_token_idx;"
})
```

**Restrição operacional (descoberta em Fase 3, 2026-04-24):** `execute_sql` do MCP Supabase aceita `CONCURRENTLY` **apenas** quando a query é um único statement. Combinar `SET lock_timeout = '5s';` + `DROP INDEX CONCURRENTLY ...;` na mesma chamada resulta em `ERROR 25001: cannot run inside a transaction block`. Para aplicar N comandos `CONCURRENTLY`, são necessárias N chamadas separadas do `execute_sql`, cada uma com exatamente um statement e **sem** `SET` prévio. Se precisar do guardrail de `lock_timeout`, use `psql` direto contra `DIRECT_URL` em modo autocommit.

### Migrations gigantes ou sensíveis → `psql` direto (DIRECT_URL)

Quando precisa controle visual + checkpoint humano em cada passo, ou risco de timeout do MCP. Exige `psql` instalado localmente.

```bash
psql "$DIRECT_URL"
\timing on
\set AUTOCOMMIT off
BEGIN;
-- statements
COMMIT;  -- ou ROLLBACK em caso de problema
```

---

## Smoke tests pós-cada-migration

### Schema-level

```sql
-- Verificar tipos aplicados
SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('users','sessions','tokens','usage','jobs')
  AND column_name IN ('id','user_id','created_at','updated_at',
                      'expires_at','last_activity_at','revoked_at',
                      'activated_at','started_at','completed_at')
ORDER BY table_name, column_name;

-- Verificar FKs intactas
SELECT conname, conrelid::regclass AS tabela, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'f'
  AND conrelid::regclass::text IN ('sessions','tokens','usage','jobs');

-- Verificar índices preservados
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('users','sessions','tokens','usage','jobs')
ORDER BY tablename, indexname;

-- Validar nenhum índice em estado INVALID
SELECT indexrelid::regclass, indisvalid
FROM pg_index
WHERE NOT indisvalid;
-- Esperado: 0 linhas.
```

### Application-level

```bash
# Regenerar fixture de testes
npm run test:schema:verify -- --update

# Suíte unit (rápida)
npm run test:unit

# Suíte integration (testcontainers contra schema novo)
npm run test:integration
```

---

## Fechamento da janela

1. Inserir audit_log:

```sql
INSERT INTO audit_log (action, actor, success, metadata)
VALUES ('MIGRATION_END', '<seu_handle>', true,
        jsonb_build_object(
          'outcome', 'success',
          'migrations_applied', 3,
          'duration_seconds', <medido>
        ));
```

2. Re-habilitar webhook Stripe (Dashboard → Developers → Webhooks).
3. Comentário no Trello:

```
RELEASE WINDOW CLOSED at <timestamp>
Outcome: success | partial | rollback
Smoke results: <link>
Sentry: clean | <link issues>
Lead time: <duração>
```

4. Commit do `prisma/schema.prisma` atualizado + `tests/fixtures/schema.sql` regenerada — MESMO PR das migrations SQL.

---

## T+24h follow-up

```sql
-- Refresh de estatísticas (autovacuum eventualmente faz, mas explícito é mais rápido)
VACUUM (ANALYZE, VERBOSE) public.users;
VACUUM (ANALYZE, VERBOSE) public.sessions;
VACUUM (ANALYZE, VERBOSE) public.tokens;
VACUUM (ANALYZE, VERBOSE) public.usage;
VACUUM (ANALYZE, VERBOSE) public.jobs;
```

- Sentry sem regressão acumulada.
- EXPLAIN das queries críticas vs baseline arquivado.

---

## Quando algo dá errado

→ `database-rollback.md`
