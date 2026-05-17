# Runbook — Cron Stuck (não rodou na janela esperada)

Procedimento quando um cron job do scheduler (Card #145 5.2a) não executou na janela esperada. Aplica-se a `history-purge` (Card #146), `quota-alert` (Card #147) e qualquer job futuro registrado via `registerCronJob`.

> **Princípio:** cron stuck NÃO é benigno. Job de purga LGPD não executando viola Art. 16 (retenção). Job de alerta não executando degrada UX silenciosamente. Trate como incidente até provar contrário.

---

## Detecção

### Sintomas

- Alerta Sentry: `cron.run.expired` ou `cron.run.failure` há > 1 hora (search query: `scheduler_event:cron.run.*`).
- Métrica `cron_runs_total{job=X,status=success}` parou de incrementar.
- `GET /admin/jobs/list` mostra `lastRun.startedAt` antigo (> schedule period).
- Usuários relatam: arquivos não purgados após 30d (PRO_RETENTION_DAYS), alerta de quota não recebido.

### Verificação rápida (T-0)

```bash
# 1. Snapshot do scheduler — SSOT confiável (lê do process atual)
curl -X GET https://api.tablix.com.br/admin/jobs/list \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "X-Admin-Confirm: <header-stepup-computado-via-scripts/compute-stepup.sh-PENDENTE-CARD-#159>"

# 2. Buscar nos logs eventos do job (pino structured)
fly logs --app tablix-back | grep '"event":"cron'
```

### Detecção de "cron não rodou" — métodos válidos

| Sintoma | Método | Comando |
|---|---|---|
| Nenhum run há > N | `GET /admin/jobs/list` → comparar `lastRun.startedAt` com agora | curl acima |
| Failures recentes (issue) | Sentry Issues (cron.run.failure está em ALERTABLE_EVENTS) | Sentry dashboard `is:unresolved scheduler_event:cron.run.failure` |
| Expired (split-brain) | Sentry Issues | `is:unresolved scheduler_event:cron.run.expired` |
| Heartbeat lost | Sentry Issues | `is:unresolved scheduler_event:cron.lock.heartbeat_lost` |
| Lock contention crescendo | `GET /admin/jobs/list` → campo `metrics.lockContentionTotal` | curl acima |
| Histórico de runs success | `fly logs` (pino events) — Sentry breadcrumb NÃO é searchable via query de tag | `fly logs ... \| grep cron.run.success` |

> **IMPORTANTE — silent failure não dispara alerta por padrão.** "Nenhum run
> nas últimas 36h" exige polling ativo (`/admin/jobs/list` ou external watchdog).
> Sentry NÃO detecta ausência de eventos. Configurar Cron Monitoring no Sentry
> (Issue Rule by absence) ou external healthcheck (Pingdom/UptimeRobot batendo
> em `/admin/jobs/list` + parse de `lastRun.startedAt`) é trabalho da Fase 9.

> **Limitação conhecida das métricas:** counters em `metrics.runsTotal`,
> `lockContentionTotal`, `lockExpiredTotal` são **in-memory por process**.
> Restart do Fly.io machine zera todos. Para histórico longo, consultar
> `fly logs` ou Sentry breadcrumbs (cap 50/processo).

---

## Decision tree

```
Job não rodou na janela?
├─ Container Fly.io reiniciou recentemente?
│  ├─ SIM → cron foi re-registrado no boot, próxima janela cobrirá.
│  │        Se janela > 1h, rodar manualmente (POST /admin/jobs/run/:name).
│  └─ NÃO → próximo nó.
│
├─ `getSchedulerHealth().jobs[X]` está presente?
│  ├─ NÃO → registerCronJob nunca foi chamado. Verificar bootstrap em app.ts.
│  └─ SIM → próximo nó.
│
├─ `enabled: false`?
│  ├─ SIM → kill-switch ativo. Verificar env (HISTORY_FEATURE_ENABLED,
│  │        CRON_PURGE_ENABLED). Pode ter sido desligado por incidente —
│  │        revisar `purge-overshoot.md`.
│  └─ NÃO → próximo nó.
│
├─ Último run terminou em `expired` ou `failure`?
│  ├─ expired → lock perdido durante handler. Ver `lock-stuck.md`.
│  ├─ failure → erro no handler. Sentry tem o stack. Fix forward.
│  └─ success/skipped → próximo nó.
│
├─ Lock contention crescendo?
│  └─ Outro worker (cron desfantasmado, double-deploy) detém lock.
│     Ver `lock-stuck.md` para limpeza.
│
└─ node-cron task viva mas não dispara?
   └─ Investigar timezone do container (`TZ=UTC` esperado).
      `date -u` no container deve bater com clock UTC real.
      Schedule cron usa `timezone: 'UTC'` (cron.ts) — divergência aqui
      é bug do node-cron ou clock skew do host.
```

---

## Mitigação imediata (T+0 a T+30min)

### Opção 1 — Rodar manualmente (recovery rápido)

```bash
# POST /admin/jobs/run/:name — bypassa schedule, respeita lock+kill-switch
curl -X POST https://api.tablix.com.br/admin/jobs/run/history-purge \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "X-Admin-Confirm: <header-stepup-computado-via-scripts/compute-stepup.sh-PENDENTE-CARD-#159>" \
  -H "Idempotency-Key: $(uuidgen)"
```

Resposta:
- `200 { status: 'success' }` → job rodou. Verificar `durationMs` e `runId` no Sentry.
- `200 { status: 'skipped', skipReason: 'lock_not_acquired' }` → outro worker detém. Ver `lock-stuck.md`.
- `200 { status: 'skipped', skipReason: 'feature_disabled' }` → kill-switch ativo, decisão consciente — abrir card pra reativação.
- `503` → audit_log_legal falhou (Mit 5 D#3). Verificar Postgres + `audit_log_legal` table.

### Opção 2 — Reativar kill-switch

Se descobrir que `HISTORY_FEATURE_ENABLED=false` foi setado durante incidente anterior e a causa raiz foi resolvida:

```bash
# Validar com @devops + @security antes de mudar — kill-switch é safety net.
fly secrets set HISTORY_FEATURE_ENABLED=true --app tablix-back
fly deploy --app tablix-back  # secret novo exige restart
```

**Confirmar** após deploy: `GET /admin/jobs/list` mostra `enabled: true`.

---

## Investigação root cause (T+30min a T+4h)

### Coleta de evidência

1. **Sentry**: search `scheduler_event:cron.* age:-7d` — timeline de eventos do job afetado.
2. **Logs Fly.io**: `fly logs --app tablix-back | grep "scheduler_event"` filtrado por janela.
3. **`pipeline.jsonl`**: verificar se houve deploy recente que tocou `src/scheduler/**` ou `src/jobs/**`.
4. **Métricas snapshot**: `GET /admin/jobs/list` → `metrics.runsTotal`, `metrics.lockContentionTotal`, `metrics.lockExpiredTotal` revelam padrão.

### Hipóteses prováveis (ordem de likelihood)

1. **Kill-switch ativado por incidente anterior e ninguém reativou** — verificar env atual + git log do `.env.example`.
2. **Container reiniciou múltiplas vezes** (OOM, deploy, fly autoscale) — `fly status --app tablix-back`. node-cron in-process não sobrevive restart se schedule pegou janela durante downtime.
3. **Handler trava silenciosamente** — handler tem await em chamada externa sem timeout. Heartbeat eventualmente perde lock, status vira `expired`. Adicionar timeout no handler.
4. **Clock skew do host** — `fly ssh console -C "date -u"` e comparar com NTP. Skew > 1min pode pular janela cron de minuto.
5. **node-cron task crashed** — `getSchedulerHealth()` mostra job registrado mas `lastRun` muito antigo + nenhum log. Bug raro do node-cron — workaround: `fly restart`.

---

## Action items pós-recovery

- [ ] Postmortem em `.claude/metrics/postmortems/PM-YYYY-NNN.md` (template em `docs/runbooks/release-window.md`).
- [ ] Se kill-switch ficou off > 24h sem decisão registrada → finding ALTO de processo.
- [ ] Se handler trava sem timeout → criar card `cron-handler-timeout` (correção definitiva).
- [ ] Se clock skew → card `cron-host-ntp-monitor`.
- [ ] Atualizar este runbook se a causa raiz revelou cenário novo.

---

## Referências

- Card #145 (5.2a) F4 — `src/scheduler/cron.ts`, `src/scheduler/lock.ts`.
- Card #145 (5.2a) F5 — `src/scheduler/metrics.ts`, `src/scheduler/observability.ts`.
- Card #146 (5.2b) — handler `history-purge` (depende deste runbook).
- Card #147 (5.2c) — handler `quota-alert` (depende deste runbook).
- Plano: `.claude/plans/2026-05-02-card-145-5.2a-history-optin-schema-endpoints-cron-infra.md`.
