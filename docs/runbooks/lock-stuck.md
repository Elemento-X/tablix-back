# Runbook — Lock Stuck (Redis lock travado)

Procedimento quando o lock distribuído de um cron job (Redis SET NX PX com fencing token UUID) está bloqueando execução indevidamente. Aplica-se ao scheduler do Card #145 (5.2a) F4.

> **Princípio:** lock no Redis é a primary defense contra split-brain (Card #145 plano A-5). Nunca deletar lock manualmente sem entender quem o detém — risco de duplicação de write LGPD em job de purga.

---

## Detecção

### Sintomas

- Cron job consistentemente em `skipReason: 'lock_not_acquired'`.
- Métrica `cron_lock_contention_total{job=X}` crescendo sem que `cron_runs_total{status=success}` cresça.
- Alerta Sentry: `cron.lock.expired_without_release` (R-8 — handler lento + heartbeat falhou).
- Alerta Sentry: `cron.lock.heartbeat_lost` (split-brain — outro worker pegou o lock).
- `GET /admin/jobs/list` retorna `lastRun.skipReason='lock_not_acquired'` repetidamente.

### Verificação rápida (T-0)

```bash
# 1. Snapshot do scheduler — quem é o último runId que pegou o lock?
curl -X GET https://api.tablix.com.br/admin/jobs/list \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "X-Admin-Confirm: <header-stepup-computado-via-scripts/compute-stepup.sh-PENDENTE-CARD-#159>"

# 2. Inspecionar a key no Redis (Upstash REST API — Upstash NÃO tem CLI próprio)
# Key pattern: tablix:cron:lock:<jobName>
curl -X POST "$UPSTASH_REDIS_REST_URL/get/tablix:cron:lock:history-purge" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

curl -X POST "$UPSTASH_REDIS_REST_URL/pttl/tablix:cron:lock:history-purge" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# Alternativa visual: Upstash Dashboard → Database → Data Browser → digitar
# a key. Não usar nenhum binário `upstash` — não existe.

# 3. Quantos containers Fly.io estão rodando?
fly status --app tablix-back  # esperar 1 (single-machine, plano A-5)
```

> **Limitação conhecida das métricas:** counters `runsTotal`, `lockContentionTotal`,
> `lockExpiredTotal` são **in-memory por process** (`src/scheduler/metrics.ts`).
> Restart do Fly.io machine **zera** todos. Para histórico de longo prazo,
> consultar Sentry breadcrumbs (cap 50/processo) ou `fly logs` (retenção curta).
> Persistência em Redis é follow-up da Fase 9 (Go-live & Docs).

---

## Decision tree

```
Lock parece travado?
├─ PTTL retorna -2 (não existe)?
│  └─ Não há lock travado. Job deveria estar rodando. Ver `cron-stuck.md`.
│
├─ PTTL retorna -1 (sem expiração — BUG)?
│  └─ Lock criado sem PX = bug do acquireLock. Investigar código.
│     Workaround: DEL manual + redeploy. Reportar como ALTO.
│
├─ PTTL > 0 (lock ativo, TTL restando)?
│  ├─ TTL > 5min E último heartbeat_ok no Sentry há > 2min?
│  │  └─ Handler está rodando. Esperar. NÃO mexer.
│  │
│  ├─ TTL > 5min E nenhum heartbeat_ok recente?
│  │  └─ Handler abandonado (container restart, OOM kill, deploy).
│  │     Lock vai expirar pelo TTL. Aceitar wait (max 15min default)
│  │     OU release manual com extrema cautela (próxima seção).
│  │
│  └─ TTL próximo de 0 e sem heartbeat?
│     └─ Esperar expirar. Próxima janela cron vai pegar lock limpo.
│
└─ Múltiplos containers Fly.io ativos (split deploy, rollback parcial)?
   └─ Cada container tem seu node-cron — concorrência esperada. Lock
      distribuído está fazendo o trabalho (1 ganha, outros skip).
      Reduzir pra 1 instance se A-5 do plano ainda vale:
      `fly scale count 1 --app tablix-back`.
```

---

## Mitigação imediata

### Opção 1 — Esperar TTL natural (PREFERIDO)

```bash
# TTL default é 15min. Recovery automático sem risco.
# Monitorar via:
watch -n 30 "upstash redis-cli PTTL 'tablix:cron:lock:history-purge'"
```

Quando PTTL = -2, próxima janela cron (ou run manual) vai adquirir o lock.

### Opção 2 — Release manual (RISCO — exige aprovação)

**APENAS** quando:
- Handler claramente abandonado (sem heartbeat há > 5min).
- TTL restante > 5min E urgência operacional (LGPD purge atrasado).
- Aprovação do operador principal documentada no card.

```bash
# Lê o token atual ANTES de deletar (forense). Upstash REST API.
TOKEN=$(curl -sX POST "$UPSTASH_REDIS_REST_URL/get/tablix:cron:lock:history-purge" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" | jq -r '.result')
echo "Token forense: $TOKEN" >> postmortem-notes.txt

# CAS — só deleta se o token bate (mesma garantia do release CAS Lua).
# Upstash REST: EVAL com KEYS+ARGV positional.
curl -X POST "$UPSTASH_REDIS_REST_URL/eval" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"script\":\"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end\",\"keys\":[\"tablix:cron:lock:history-purge\"],\"args\":[\"$TOKEN\"]}"
```

**Pós-release manual:**
- [ ] Comentário no card `pipeline-incident-lock-released` com token forense.
- [ ] Postmortem em 48h (template `release-window.md`).
- [ ] Verificar se handler abandonado completou write parcial (idempotência declarada em `CronJobDefinition.idempotent` — se `true`, próximo run reconcilia; se `false`, exige inspeção manual).

### Opção 3 — Reduzir TTL pra recovery rápido (proativo)

Se TTL default de 15min é excessivo pro job, reduzir via `CronJobDefinition.lockTtlMs`:

```ts
registerCronJob({
  name: 'quota-alert',
  schedule: '0 8 * * *',
  enabled: env.CRON_PURGE_ENABLED,
  handler: scanUsageAndAlert,
  lockTtlMs: 5 * 60 * 1000,  // 5min — job é rápido (<2min típico)
  idempotent: true,
})
```

Heartbeat (60s) ainda renova durante execução longa — TTL só importa pra cenário de crash.

---

## Investigação root cause

### Coleta de evidência

1. **Sentry**: `scheduler_event:cron.lock.* scheduler_job:X age:-7d`.
2. **Redis**: histórico de SETs (Upstash não retém log; usar Sentry breadcrumbs de `cron.lock.acquired`).
3. **`pipeline_state.json`**: deploy/rollback recente?
4. **`fly logs --app tablix-back | grep "cron.lock"`** filtrado.

### Hipóteses prováveis

1. **Container OOM kill mid-handler** → handler abandonou sem release. Lock expira pelo TTL.
   - Mitigação: aumentar memória Fly.io OU reduzir batch size do handler.
2. **Heartbeat falhou (Redis blip)** → status `expired` no run. Outro worker pode pegar paralelo (split-brain).
   - Mitigação: handler DEVE ser idempotente (`CronJobDefinition.idempotent: true`).
3. **Double deploy (rollback parcial)** → 2 containers, 1 ganha lock cada janela.
   - Mitigação: `fly scale count 1` ou aceitar (lock distribuído resolve).
4. **Bug do release CAS** → lock detectado como "released" mas Redis ainda tem a key.
   - Mitigação: investigar código `releaseLock` em `src/scheduler/lock.ts`. Reportar como CRÍTICO.

---

## Action items pós-recovery

- [ ] Postmortem se houve release manual ou se lock travou > 30min.
- [ ] Se OOM → card `scheduler-container-memory-tuning`.
- [ ] Se split-brain consistente e A-5 inviável → revisitar plano de scaling (migração pra C — Fly scheduled — Card #149).
- [ ] Validar `CronJobDefinition.idempotent === true` em TODOS os jobs registrados (proteção contra split-brain).

---

## Referências

- Card #145 F4 — `src/scheduler/lock.ts` (acquire/release/heartbeat CAS).
- Card #145 F5 — `src/scheduler/observability.ts` (alertas).
- Card #145 A-5 — single-machine Fly.io (posponed até Fase 7).
- Card #149 — migração futura A→C (Fly scheduled).
