# Runbook — quota-alert cron stuck/degraded

**Job:** `quota-alert`
**Schedule:** `'0 11 * * *'` UTC = 08:00 BRT daily
**Owner:** @devops + @planner
**Card:** #147 (5.2c) F3

Cron de alerta de quota PRO (70%/90%) com email Resend + dedupe mensal. Disparado uma vez por dia. Dedupe via UNIQUE(user_id, threshold, period) em `quota_alerts_sent`.

## Sintomas (quando este runbook se aplica)

- Métrica `users_above_threshold{threshold=70}` ou `{threshold=90}` com `lastUpdatedAt > 25h` no snapshot do scheduler (`GET /admin/jobs/list`)
- Sentry issue `cron.run.failure` com tag `scheduler_job=quota-alert`
- Sentry issue `cron.quota_alert.email_failed` warning frequente (>10/dia)
- Sentry issue `cron.quota_alert.dry_run.start` em prod (dry-run esquecido)
- Reclamação de usuário PRO: "atingi 100% sem aviso prévio"
- Coluna `quota_alerts_sent.sent_at` mais recente > 48h

## Diagnóstico (10 min)

### 1. Job está rodando?

Procurar logs nas últimas 24h:
```
fly logs --app tablix-back | grep 'quota-alert'
```

Esperado:
- 1 entrada `scheduler.bootstrap.cron_jobs_registered` com `jobsRegistered: 4` no boot
- 1 entrada `quota-alert.completed` por dia às 11:00 UTC (08:00 BRT)
- Se não tiver `completed` mas tiver `lock_not_acquired` recorrente → outra instance está consumindo o lock

### 2. Kill-switch desabilitou?

```
fly ssh console --app tablix-back -C 'env | grep -E "HISTORY_FEATURE_ENABLED|CRON_PURGE_ENABLED|CRON_DRY_RUN"'
```

Se `HISTORY_FEATURE_ENABLED=false` OU `CRON_PURGE_ENABLED=false` → kill-switch (compartilhado com os outros 3 jobs) desativou tudo.
Se `CRON_DRY_RUN=true` em prod → dry-run intencional ou esquecido. Verificar timeline de deploys.

### 3. Lock travado?

Conectar ao Upstash Redis console (https://console.upstash.com), executar:
```
GET tablix:cron:lock:quota-alert
```

Se retornar token + TTL alto → lock orphan (handler crashou sem release).
Se retornar `(nil)` → lock OK, job não rodou por outro motivo.

Mitigação se lock orphan:
```
DEL tablix:cron:lock:quota-alert
```

### 4. Resend API health?

Verificar dashboard Resend (https://resend.com/emails) — taxa de bounce/error nas últimas 24h.
Se Resend está down → emails falham mas INSERT em `quota_alerts_sent` acontece MESMO ASSIM (decisão A-8). Próximo run NÃO duplica.

### 5. DB query lenta?

Conectar via Supabase MCP/SQL editor:
```sql
EXPLAIN ANALYZE
SELECT u.id, u.email
FROM users u
INNER JOIN tokens t ON t.user_id = u.id
WHERE t.status = 'ACTIVE'
  AND (t.expires_at IS NULL OR t.expires_at > NOW());
```

Se > 500ms para < 5k users:
- Índice em `tokens(user_id, status, expires_at)` pode estar faltando — ver Card #181 (RLS missing pré-existing)
- Bloat na tabela `tokens` — `VACUUM ANALYZE tokens`

### 6. Volume sanitário

Quantos alertas enviados nas últimas 24h vs 7d?
```sql
SELECT period, threshold, COUNT(*) AS sent
FROM quota_alerts_sent
WHERE sent_at > NOW() - INTERVAL '7 days'
GROUP BY period, threshold
ORDER BY period DESC, threshold DESC;
```

Se 0 emails enviados em 7d mas `users_above_threshold{70} > 0` → bug do envio (Resend down silencioso ou handler skipping).

## Mitigações

### Re-rodar manual (admin endpoint do #145 F4)

```bash
curl -X POST 'https://tablix-back.fly.dev/admin/jobs/run/quota-alert' \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'X-Admin-Confirm: <stepup-hash>' \
  -H 'Idempotency-Key: <uuid>'
```

Resposta esperada: `202 Accepted` com `runId` no body. Acompanhar via `GET /admin/jobs/list`.

### Desabilitar temporariamente (compartilha kill-switch dos outros 3)

```bash
fly secrets set CRON_PURGE_ENABLED=false --app tablix-back
fly deploy
```

**ATENÇÃO**: mesma flag desabilita os 4 jobs (history-purge, cron-runs-cleanup, dead-letter-reprocess, quota-alert). Re-habilitar quando issue resolvido:
```bash
fly secrets set CRON_PURGE_ENABLED=true --app tablix-back
fly deploy
```

### Forçar reenvio de um email específico (DEBUG ONLY)

```sql
-- CUIDADO: dispara email no próximo run às 11:00 UTC
DELETE FROM quota_alerts_sent
WHERE user_id = '<user-uuid>'
  AND threshold = 90
  AND period = '2026-05';
```

NÃO usar em produção sem aprovação operacional — bypass do dedupe pode gerar spam se job rodar várias vezes pelo cron.

### Dry-run pra investigação (sem enviar email real)

```bash
fly secrets set CRON_DRY_RUN=true --app tablix-back
fly deploy
# Re-rodar via admin endpoint → veja logs com `dry_run=true`
# REMOVER FLAG depois (Sentry alerta dry_run em prod)
# Não usar `unset` — alguns ambientes ficam com env undefined em vez de
# aplicar default Zod. Set explícito é idempotente e seguro.
fly secrets set CRON_DRY_RUN=false --app tablix-back
fly deploy
```

## Métricas/dashboards Sentry

Pesquisas estruturadas no Sentry (filtro `tags.scheduler_job:quota-alert`):
- `event:cron.run.failure` — handler crashou
- `event:cron.quota_alert.email_failed` — Resend falhou pra user específico
- `event:cron.lock.heartbeat_lost` — split-brain (>1 worker?)
- `event:cron.run.skipped.lock_not_acquired` — outra instance consumiu lock (esperado em multi-instance)

## Escalation

- Job parado > 24h: warning interno (Slack ops)
- Job parado > 48h: escalation pro usuário (gen.ai@direcional.com.br) — alerta crítico
  - PRO users sem visibilidade de quota = risco de surpresa no limit-exceeded → churn potencial
- Migration F1 (`20260518200000_card_147_f1_add_quota_alerts_sent`) precisa rollback: ver `database-rollback.md`

## Postmortem

Se rodou postmortem (cron parado em prod por > 24h), salvar em `.claude/metrics/postmortems/PM-<id>.md` seguindo template do `audit_log_legal` (Card #150).

Pontos a cobrir:
1. Tempo total de degradação
2. Usuários impactados (count de PRO ativos no período)
3. Root cause (lock orphan, Resend down, kill-switch, DB lento, bug do handler)
4. Detecção (quanto tempo passou até alguém notar)
5. Mitigação aplicada
6. Action items (mudanças no runbook, alertas Sentry novos, métricas novas)

## Decisões de design relevantes (do plano #147)

- **A-8**: Resend falha → INSERT em `quota_alerts_sent` MESMO ASSIM. Justificativa: 1 email perdido > 30 emails duplicados quando Resend voltar. NÃO desfazer esse trade-off sem aprovação @security + @planner.
- **A-9**: Mesmo kill-switch dos outros 3 jobs (`CRON_PURGE_ENABLED`). Discovery card `decouple-cron-kill-switches` pode separar no futuro.
- **A-2**: Dedupe mensal via UNIQUE(user_id, threshold, period). Reset implícito quando muda `period` (YYYY-MM UTC).
- **Sem unsubscribe**: alertas são transacionais (PRO ativo). LGPD/CASL distingue transacional de marketing — não viola consentimento.
