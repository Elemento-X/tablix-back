# Runbook — Database Rollback

Decision tree e procedimentos para reverter migrations em caso de falha. Use junto com `database-migration.md`.

> **Princípio:** rollback é UM dos caminhos. Os outros são "rolar pra frente" (corrigir e seguir) ou "restaurar snapshot". Escolha errada custa mais que migration errada.

---

## Decision tree

```
Migration falhou?
├─ Falhou DENTRO da transação (BEGIN/COMMIT)?
│  └─ PG fez ROLLBACK automático. Estado intacto. Investigue erro, corrija SQL, re-execute.
│
├─ Falhou ENTRE statements (ex: timeout do MCP, conexão dropou)?
│  ├─ Verifique estado atual via smoke tests.
│  ├─ Se schema está consistente → "rolar pra frente": completar passos faltantes.
│  └─ Se schema está inconsistente → restaurar snapshot.
│
├─ Migration COMPLETOU mas smoke tests detectaram regressão?
│  ├─ Bug de aplicação esperando tipo antigo → corrigir app, NÃO rollback do DB.
│  ├─ Performance degradou (faltou índice) → CREATE INDEX CONCURRENTLY corretivo.
│  └─ Dados corrompidos → restaurar snapshot.
│
└─ Stripe webhook ou audit_log com erro durante a janela?
   └─ Verifique se webhook foi desabilitado. Re-processar via Stripe Dashboard.
```

---

## Rollback SQL por migration (Fase 3)

### Migration A — TIMESTAMPTZ → TIMESTAMP

Reversível. Em UTC puro preserva valores.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL TIME ZONE 'UTC';

-- Replicar simétrico ao SQL original, trocando tipo
ALTER TABLE "users"
  ALTER COLUMN "created_at" TYPE timestamp(3) USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" TYPE timestamp(3) USING ("updated_at" AT TIME ZONE 'UTC');

-- ... (repetir para sessions, tokens, usage, jobs)
COMMIT;
```

**Quando rollar A:** raríssimo. Aplicação esperando `timestamp without time zone` é bug do código (Prisma client lida com TIMESTAMPTZ transparentemente). Corrija o app, mantenha o DB.

### Migration B — UUID → TEXT

Tecnicamente reversível, mas perde semântica nativa.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Drop FKs
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey";
ALTER TABLE "tokens"   DROP CONSTRAINT "tokens_user_id_fkey";
ALTER TABLE "usage"    DROP CONSTRAINT "usage_user_id_fkey";
ALTER TABLE "jobs"     DROP CONSTRAINT "jobs_user_id_fkey";

-- 2. Reverter PK pai
ALTER TABLE "users"
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE text USING "id"::text,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- 3. Reverter user_id filhos
ALTER TABLE "sessions" ALTER COLUMN "user_id" TYPE text USING "user_id"::text;
ALTER TABLE "tokens"   ALTER COLUMN "user_id" TYPE text USING "user_id"::text;
ALTER TABLE "usage"    ALTER COLUMN "user_id" TYPE text USING "user_id"::text;
ALTER TABLE "jobs"     ALTER COLUMN "user_id" TYPE text USING "user_id"::text;

-- 4. Reverter PKs filhas
ALTER TABLE "sessions" ALTER COLUMN "id" DROP DEFAULT,
                       ALTER COLUMN "id" TYPE text USING "id"::text,
                       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
-- ... (tokens, usage, jobs)

-- 5. Recriar FKs
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
-- ... (tokens RESTRICT, usage RESTRICT, jobs CASCADE)
COMMIT;
```

**Quando rollar B:** se Migration B completou e schema Prisma NÃO foi atualizado, app pode falhar tentando enviar TEXT UUID em coluna que espera UUID nativo (cast implícito normalmente funciona, mas em formato canônico exato). **Solução preferida:** mergear schema Prisma atualizado + redeploy. Rollback do DB é último recurso.

### Migration C — Recriar índices órfãos

Trivial.

```sql
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY "tokens_token_idx" ON "tokens"("token");
CREATE INDEX CONCURRENTLY "idx_usage_token_period" ON "usage"("user_id", "period");
```

**Quando rollar C:** quase nunca. Os 2 índices eram redundantes e nunca foram usados (idx_scan=0 confirmado). Único cenário: query nova futura escolhe um deles e drop quebrou.

---

## Restauração de snapshot (último recurso)

### Cenário A — Pro tier com PITR

Supabase Dashboard → Database → Backups → "Restore to point in time" → escolher timestamp pré-migration.

⚠️ PITR **substitui** o banco inteiro. Eventos pós-migration (audit_log, webhooks Stripe) **se perdem**. Anote o que foi perdido para reprocessar manualmente.

### Cenário B — Free tier sem PITR (caso atual)

Restauração via `pg_dump` arquivado pré-migration:

```bash
# 1. Validar checksum do dump pré-migration
sha256sum -c backup-pre-migration-<card>.sql.sha256

# 2. Conectar via DIRECT_URL (não pooler — DROP TABLE é DDL pesado)
psql "$DIRECT_URL"

# 3. Truncar tabelas afetadas (ordem reversa de FK)
TRUNCATE jobs, usage, tokens, sessions, users CASCADE;

# 4. Restaurar dados
\i backup-pre-migration-<card>.sql

# 5. Validar contagem pós-restauração
SELECT
  (SELECT count(*) FROM users) AS users_count,
  -- ... etc
```

⚠️ **Backup não testado é esperança, não plano.** Antes da janela, restaurar o dump em DB local de teste para validar que o procedimento funciona.

---

## Checklist pós-rollback

1. **Audit log** — registrar evento:

```sql
INSERT INTO audit_log (action, actor, success, metadata)
VALUES ('MIGRATION_ROLLBACK', '<handle>', true,
        jsonb_build_object(
          'reason', '<descrição>',
          'rolled_back', '<lista>',
          'restoration_method', 'sql_revert | pitr | pg_dump_restore'
        ));
```

2. **Postmortem em 48h** — `.claude/metrics/postmortems/PM-YYYY-NNN.md`. Categoria: pipeline-miss se houve aprovação anterior, ou migration-failure caso contrário.

3. **Schema Prisma** — reverter via `git revert` do commit do `schema.prisma` (se já mergeado).

4. **Fixture de testes** — regenerar `tests/fixtures/schema.sql` para refletir estado pós-rollback.

5. **Webhook Stripe** — confirmar que está re-habilitado.

6. **Sentry** — verificar se erros durante a janela foram capturados; reprocessar se necessário.
