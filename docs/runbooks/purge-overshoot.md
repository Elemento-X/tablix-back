# Runbook — Purge Overshoot (purga deletou mais do que devia)

Procedimento quando o cron de purga (`history-purge`, Card #146 5.2b) deletou rows que NÃO deveriam ter sido deletadas. Este é um **incidente LGPD com impacto direto no titular do dado** — escalation pro usuário é obrigatória.

> **Princípio:** dado deletado de Storage por purge é IRREVERSÍVEL (Supabase Storage não tem versioning). Recovery depende de backup PITR do Postgres + arquivos não terem sido removidos do Storage ainda (janela de 1h entre two-phase). Cada minuto de delay reduz superfície de recuperação.

---

## Detecção

### Sintomas

- Usuário PRO reporta arquivos sumindo do histórico ANTES de 30 dias (PRO_RETENTION_DAYS).
- Métrica `cron_runs_total{job=history-purge,status=success}` com `durationMs` muito acima da baseline (purge tocou rows demais).
- Query SQL: `SELECT COUNT(*) FROM file_history WHERE deleted_at IS NOT NULL AND created_at > now() - interval '15 days'` retorna > 0 (deveria ser zero antes de 30d).
- Audit `audit_log_legal` mostra `purge_pending` em batch grande inesperado.

### Verificação imediata (T-0)

```sql
-- 1. Tamanho do "estrago" — quantas rows foram soft-deletadas recentemente?
SELECT
  user_id,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL AND created_at > now() - interval '30 days') AS overshoot_count,
  MIN(created_at) AS oldest_affected,
  MAX(deleted_at) AS most_recent_purge
FROM file_history
WHERE deleted_at IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY user_id
ORDER BY overshoot_count DESC;

-- 2. Storage delete já rodou? (janela de 1h two-phase)
SELECT
  fh.id,
  fh.user_id,
  fh.storage_path,
  fh.deleted_at,
  fh.purge_attempts,
  CASE
    WHEN fh.deleted_at < now() - interval '1 hour' THEN 'STORAGE_LIKELY_DELETED'
    ELSE 'STORAGE_LIKELY_RECOVERABLE'
  END AS storage_status
FROM file_history fh
WHERE fh.deleted_at IS NOT NULL
  AND fh.created_at > now() - interval '30 days'
LIMIT 50;
```

---

## Containment imediato (T+0 — primeiros 5 min)

### Passo 1 — Parar o cron AGORA

```bash
# Kill-switch desliga purge sem deploy
fly secrets set CRON_PURGE_ENABLED=false --app tablix-back
fly deploy --app tablix-back
```

**Validar**: `GET /admin/jobs/list` mostra `history-purge.enabled: false`.

### Passo 2 — Bloquear segundo passo do two-phase

Se o cenário é "soft-delete já rodou mas Storage delete ainda não" (deleted_at recente, < 1h):

```sql
-- "Desfazer" o soft-delete recente — reverter deleted_at = NULL pra rows
-- da janela suspeita. ISSO bloqueia o storage delete (filtro
-- `deleted_at IS NOT NULL` do passo 2 do two-phase).
BEGIN;
SET LOCAL statement_timeout = '30s';

UPDATE file_history
SET deleted_at = NULL, purge_attempts = 0
WHERE deleted_at IS NOT NULL
  AND created_at > now() - interval '30 days'
  AND deleted_at > now() - interval '1 hour';

-- Verificar contagem ANTES do COMMIT
SELECT count(*) AS reverted_rows FROM file_history
  WHERE created_at > now() - interval '30 days'
    AND deleted_at IS NULL;

COMMIT;
```

⚠ **CUIDADO — trigger append-only de `audit_log_legal` (Card #150) pode bloquear este UPDATE.**

**Pré-check obrigatório (rodar ANTES de tentar o UPDATE):**

```sql
-- Inspecionar definição da trigger que protege audit_log_legal
SELECT pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid = 'audit_log_legal'::regclass
  AND NOT tgisinternal;

-- Confirmar que trigger é SOMENTE sobre audit_log_legal — não sobre file_history
\d+ file_history
```

A trigger append-only do Card #150 protege `audit_log_legal`, **não** `file_history`.
Reverter `file_history.deleted_at = NULL` NÃO é bloqueado por essa trigger.
Confirme via pré-check acima ANTES de prosseguir.

🚫 **PROIBIDO**: desabilitar a trigger `audit_log_legal append-only` por qualquer
caminho (`DISABLE TRIGGER`, `SECURITY DEFINER` bypass, etc.). Essa trigger é
invariante de LGPD 5y do Card #150 — mina o controle se desabilitada. Se em
algum momento a única saída parecer ser desabilitar, **escale ao operador
principal + jurídico/DPO**: a correção correta é via função
`revert_purge_overshoot(reason, approver)` com escrita compensatória ANTES
da reversão (criar como migration controlada, NUNCA ad-hoc em incidente).

### Passo 3 — Comunicar usuário (Mit 5 LGPD)

`audit_log_legal` deve ter eventos `purge_pending` da execução errônea. Listar usuários afetados:

```sql
SELECT DISTINCT user_id, COUNT(*) AS files_affected
FROM audit_log_legal
WHERE event_type = 'purge_pending'
  AND created_at > now() - interval '24 hours'
GROUP BY user_id;
```

Notificar via email (Resend) — template `incident-purge-overshoot`. Decisão do operador principal + jurídico.

---

## Decision tree

```
Purge overshoot detectado?
├─ Cron ainda rodando?
│  └─ STOP: kill-switch primeiro (CRON_PURGE_ENABLED=false + deploy).
│
├─ Soft-delete recente (< 1h, antes do Storage delete)?
│  ├─ SIM → reverter `deleted_at = NULL` (passo 2 acima). Arquivos
│  │        intactos no Storage. Usuários NÃO perdem dados.
│  └─ NÃO → próximo nó.
│
├─ Storage delete já rodou (> 1h após soft-delete)?
│  ├─ SIM → arquivos PERDIDOS. Recovery via:
│  │   1. PITR Postgres (file_history metadata)
│  │   2. Supabase Storage backup (se configurado — Card 9.x)
│  │   3. Reupload pelo usuário (último recurso, comunicar)
│  └─ NÃO → recovery ainda viável.
│
└─ Quantos usuários afetados?
   ├─ < 10 → notificação individual + reembolso/extensão de plano se PRO.
   └─ ≥ 10 → escalation pro operador principal + comunicado público (status page).
```

---

## Investigação root cause

### Hipóteses prováveis

1. **`PRO_RETENTION_DAYS` foi mudado pra valor menor (ex: 1 dia) por engano** — env override. Verificar:
   ```bash
   fly secrets list --app tablix-back | grep PRO_RETENTION_DAYS
   ```
   Se diferente do esperado (30 default), revisar git log do `.env.example` e Trello cards recentes.

2. **Query do batch sem filtro correto** — handler de purge deveria ter:
   ```sql
   WHERE expires_at < now() AND deleted_at IS NULL
   LIMIT 500 FOR UPDATE SKIP LOCKED
   ```
   Se `expires_at` for calculado errado no service (`addDays` com offset errado), batch pega rows ainda válidas. Inspecionar `src/jobs/retention.job.ts` (Card #146).

3. **`expires_at` migrado errado** — migration que setou `expires_at` em rows existentes usou valor errado. Verificar:
   ```sql
   SELECT id, created_at, expires_at, expires_at - created_at AS retention
   FROM file_history
   WHERE deleted_at IS NULL
   LIMIT 100;
   ```
   `retention` deve ser ~30 dias (ou env atual). Se for outro valor (1d, 1h), bug na migration.

4. **Bug do two-phase delete** — `audit_log_legal` commitado mas reconciliação re-executou DELETE em row que não deveria. Verificar `audit_log_legal` por `purge_pending` duplicados pro mesmo `resource_id`.

---

## Action items pós-recovery

- [ ] Postmortem **público** se > 10 usuários afetados (LGPD Art. 48 — comunicação ao titular).
- [ ] Card `purge-pre-commit-dry-run` — adicionar dry-run mode antes de COMMIT do soft-delete (loga rows alvo, comparar com expectativa).
- [ ] Alerta Sentry novo: `purge-batch-size-anomaly` (>2× média histórica = warning, >5× = critical).
- [ ] Revisar `env.PRO_RETENTION_DAYS` superRefine — adicionar guard de "se valor mudou nas últimas 24h, exigir flag explícita pra autorizar primeira execução".
- [ ] Atualizar este runbook com root cause se nova hipótese surgiu.

---

## Referências

- Card #145 (5.2a) — schema FileHistory + opt-in.
- Card #146 (5.2b) — handler `history-purge` (two-phase delete LGPD).
- Card #150 — `audit_log_legal` (retenção 5y, trigger append-only).
- Plano `#145` decisão D-3 — Two-phase delete LGPD.
- LGPD Art. 16, Art. 18, Art. 48 (referência jurídica).
