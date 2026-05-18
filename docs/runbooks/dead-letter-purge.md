# Runbook — Dead-Letter Purge (intervenção humana obrigatória)

Procedimento quando um arquivo do `file_history` chega à tabela de quarentena `file_history_dead_letter` E o cron weekly `dead-letter-reprocess` falhou 3 vezes (reprocess_count = 3) — alerta Sentry CRITICAL dispara `cron.purge.dead_letter` + `cron.dead_letter_reprocess.human_required`.

> **Princípio:** uma row na dead-letter com `reprocess_count >= 3` = sistema esgotou todas as opções automáticas. **Sempre exige análise humana de root cause** antes de qualquer ação. Resolver no escuro corrompe trail forense LGPD.

---

## Detecção

### Sinais

- Sentry Issue: `cron.dead_letter_reprocess.human_required` (level=error, tag scheduler_job=dead-letter-reprocess)
- Sentry Issue: `cron.purge.dead_letter` (level=error, context.escalatedToHuman > 0)
- Query: `SELECT COUNT(*) FROM file_history_dead_letter WHERE resolved_at IS NULL AND reprocess_count >= 3`
- Métrica (futuro): admin endpoint `/admin/dead-letter/critical` ou Grafana dashboard

### Severity

**ALTA-CRÍTICA** (LGPD). Cada row representa:
- Arquivo PRO que o sistema PROMETEU apagar (audit_log_legal tem `purge_pending`)
- Storage delete falhou 5x + cron retry falhou 3x = 8 tentativas no total
- Se for cron weekly, esperar 7d significa janela aberta de exposure

---

## Investigação root cause (T+0 a T+30min)

### Passo 1 — Listar todos os candidatos

```sql
SELECT
  id,
  original_file_history_id,
  user_id,
  storage_path,                       -- PII risk: redact em logs
  reprocess_count,
  last_reprocess_attempt_at,
  last_reprocess_error_code,
  last_reprocess_error_message,
  moved_to_dead_letter_at,
  (NOW() - moved_to_dead_letter_at) AS age
FROM file_history_dead_letter
WHERE resolved_at IS NULL
  AND reprocess_count >= 3
ORDER BY moved_to_dead_letter_at ASC;
```

### Passo 2 — Categorizar last_reprocess_error_code

Padrões comuns + diagnóstico:

| error_code | Provável causa | Próximo passo |
|---|---|---|
| `Error` (genérico) com message "Storage 5xx" | Supabase Storage outage transitório/regional | Esperar e re-tentar (Passo 4) |
| `Error` com message "Network timeout" / "ECONNRESET" | Conectividade Fly.io ↔ Supabase | Validar Cloudflare/Fly logs |
| `Error` com message "OBJECT_NOT_FOUND" | Bug do removeByPath (404 deveria ser idempotente!) | Bug crítico — investigar adapter |
| `Error` com message "INVALID_USER_ID" / "PATH_TRAVERSAL_REJECTED" | DB corrompido (path malformado em file_history original) | Auditoria manual + correção SQL |
| `STORAGE_DELETE_THRESHOLD_REACHED` | Vem do MOVE pra dead-letter (não do reprocess) | Verificar last_error_message anterior |

### Passo 3 — Checar Sentry full breadcrumb

Sentry Issue tem stack trace + breadcrumbs do cron.run.failure que precederam. Buscar:
- `scheduler_event:cron.lock.heartbeat_lost` (split-brain)
- `scheduler_event:cron.purge.dead_letter` (move histórico)
- Outras issues do mesmo jobName na janela

### Passo 4 — Decisão por categoria

**Causa transitória resolvida (Supabase voltou)**
→ Reset `reprocess_count = 0` pra cron weekly retomar:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE file_history_dead_letter
SET reprocess_count = 0,
    last_reprocess_error_code = NULL,
    last_reprocess_error_message = NULL
WHERE id IN ('<id1>', '<id2>', ...);
-- VERIFICAR contagem antes de COMMIT
SELECT count(*) FROM file_history_dead_letter
  WHERE id IN ('<id1>', '<id2>', ...) AND reprocess_count = 0;
COMMIT;
```

**Audit obrigatório pós-reset** (LGPD trail):
```sql
-- Pra cada row resetada, inserir audit_log_legal manual:
INSERT INTO audit_log_legal (
  event_id, event_type, user_id, resource_type, resource_id,
  legal_basis, actor, outcome, error_code,
  metadata, resource_hash, resource_hash_algo
) VALUES (
  gen_random_uuid(), 'purge_pending', '<user_id>', 'file_history_dead_letter',
  '<dead_letter_id>', 'retention_expired', 'admin_panel', 'success', NULL,
  jsonb_build_object('phase', 'manual_reset_after_outage', 'reset_by', 'admin_username',
                     'original_reprocess_count', 3, 'reason', '<descrição da causa>'),
  '\x' || encode(sha256('<user_id>:<storage_path>'::bytea), 'hex')::bytea, 'sha256v1'
);
```

**Arquivo realmente desapareceu do Storage (deletado por outro caminho)**
→ Marcar como `admin_manual_ignore` com prova:

```sql
BEGIN;
UPDATE file_history_dead_letter
SET resolved_at = NOW(),
    resolution_type = 'admin_manual_ignore',
    last_reprocess_attempt_at = NOW(),
    last_reprocess_error_code = NULL,
    last_reprocess_error_message = 'admin verified absent: <evidence>'
WHERE id = '<id>';
COMMIT;
```

**Path corrompido (CHECK regex violaria, mas escapou)**
→ Bug do file_history validation. Reportar como CRÍTICO ao @security + investigar todas as rows com paths similares ANTES de fix manual.

**Sistema realmente não consegue deletar (Storage offline definitivo, key revoked, etc)**
→ Escalation pro operador principal. NÃO marcar resolved sem confirmação jurídica de que o objeto deletado é IRRELEVANTE em compliance.

---

## ⚠️ PROIBIÇÕES

### NÃO fazer DELETE direto

```sql
-- ❌ PROIBIDO — trigger BEFORE DELETE bloqueia (Card #150 pattern)
DELETE FROM file_history_dead_letter WHERE id = '<id>';
```

A trigger `fhdl_block_delete` levanta exception com `ERRCODE = insufficient_privilege`. Hard-delete só via role dedicada `audit_legal_purge_role` (futuro Card LGPD-AUDIT).

### NÃO disable a trigger

```sql
-- ❌ PROIBIDO — desabilita prova forense LGPD
ALTER TABLE file_history_dead_letter DISABLE TRIGGER fhdl_block_delete;
```

Mesmo em incidente. A invariante "row em dead-letter NUNCA é deletada" é o que protege o sistema juridicamente. Se algum cenário PARECER exigir disable, **escale ao operador principal + jurídico/DPO**.

### NÃO resetar `reprocess_count` em massa sem investigação

A causa pode ser sistêmica (Storage bug, env var errada, etc). Reset em massa sem análise mascara o problema e gera ciclo infinito.

---

## Comunicação ao usuário

Se a row reflete arquivo identificável de um user específico:

- **LGPD Art. 48** exige comunicação ao titular sobre incidentes com seus dados. Avaliar com jurídico/DPO se delay > 30 dias dispara obrigação de notificação.
- Email padronizado pelo DPO (TBD em Card 9.x).

---

## Action items pós-recovery

- [ ] Postmortem em 48h se a causa foi sistêmica (vs row isolada).
- [ ] Atualizar `last_reprocess_error_code` enum (CHECK constraint) se um código novo apareceu.
- [ ] Avaliar se cron weekly `dead-letter-reprocess` deveria ser daily em situações específicas (Card discovery).
- [ ] Revisar este runbook se categoria nova de error_code surgiu.

---

## Pendência operador (referência cruzada)

- **Card #178** `dead-letter-anonymization-on-user-delete` (Backlog MÉDIA Fase 7): trigger AFTER DELETE em users que anonimiza `original_filename` (LGPD Art. 18 mitigation).
- **Card LGPD-AUDIT** (futuro): job de retenção 5y + role dedicada com bypass do trigger BEFORE DELETE.
- **Card discovery futuro**: admin endpoint `POST /admin/dead-letter/:id/reset-reprocess` pra automação do Passo 4 caso "causa transitória" (evita SQL manual).

---

## Refs

- Card #146 F4.7 — `src/jobs/dead-letter-reprocess.job.ts`
- Card #146 F2.5 — `supabase/migrations/20260518120100_card_146_f2_5_add_file_history_dead_letter.sql` (trigger BEFORE DELETE + CHECK constraints)
- Card #150 — `audit_log_legal` (5y retention, pattern de prova jurídica)
- LGPD Art. 16 (cumprimento obrigação), Art. 18 (direito eliminação), Art. 48 (comunicação titular)
- `docs/runbooks/cron-stuck.md` — debug de cron geral
- `docs/runbooks/purge-overshoot.md` — cenário oposto (purga deletou demais)
