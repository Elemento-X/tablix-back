# Runbook — Async Cleanup (sweeper #197 + storage-cleanup 6.7)

Procedimento de **ativação, operação e incidente** dos dois crons de cleanup do
processamento assíncrono (Card 6.7 + sweeper #197). Este runbook é o **GATE
obrigatório** do binding #4 da Fase 6: **ler e executar a checklist de ativação
ANTES de setar `CRON_JOBS_CLEANUP_ENABLED=true` em produção.**

> **Princípio:** o sweeper recupera quota de jobs órfãos (cliente pagou e não
> recebeu) e o storage-cleanup purga PII (inputs/outputs de jobs terminais).
> Ligar errado = ou vaza quota silenciosamente (sweeper off), ou deleta dado que
> não devia (storage-cleanup com filtro/TTL errado). A primeira execução SEMPRE
> é validada em `CRON_DRY_RUN=true`.

---

## Os dois crons cobertos

| Cron | Schedule (UTC / BRT) | Handler | Tempo-sensível? | Toca Storage? |
|---|---|---|---|---|
| `async-job-sweeper` | `*/5 * * * *` (a cada 5 min) | `sweepOrphanJobs` | **Sim** (recupera quota) | Não |
| `async-storage-cleanup` | `0 12 * * *` (09:00 BRT) | `purgeAsyncJobStorage` | Não (DB-driven) | **Sim** (purga PII) |

Ambos registrados em `src/scheduler/jobs.bootstrap.ts`; handlers em
`src/jobs/async-cleanup.job.ts`.

**Onde rodam:** no processo **API** (`server.ts` → `bootstrapCronJobs()`), **não**
no worker. Implicação operacional: se a máquina API dormir (scale-to-zero do Fly
free), os crons **não disparam**. Manter `min_machines = 1` no process group da
API até a migração pra Fly scheduled machines (card futuro #149 / 7.x). Ver
`cron-stuck.md`.

### O que cada um faz

**`async-job-sweeper`** (2 fases):
- **a) PENDING órfão da fila (#197):** job que reservou quota no enqueue mas
  nunca entrou na fila BullMQ (crash entre `job.create` e `enqueueProcessJob`).
  Se ainda dentro do TTL + fila ok + metadata válido → **re-enfileira**; senão →
  **FAILED + estorno de quota** (no período do `createdAt`). Idade-limiar:
  `ASYNC_PENDING_SWEEP_MINUTES` (default 10). A segurança vem do limiar, não da
  cadência de 5 min.
- **b) PROCESSING travado (6.7b):** worker morto mid-flight + BullMQ esgotou
  retries → DB preso em PROCESSING. Marca FAILED (**sem** estorno — serviço foi
  tentado), só se o job está ausente/terminal na fila. Idade-limiar:
  `ASYNC_STUCK_PROCESSING_MINUTES` (default 60).

**`async-storage-cleanup`** (2 fases):
- **a) Inputs de terminais (M-03):** jobs COMPLETED/FAILED com
  `inputs_purged_at IS NULL` → remove os inputs individualmente (enumera por
  metadata, não delete-by-prefix). `inputs_purged_at` só seta se **todos** saírem.
- **b) Outputs expirados (A-4):** jobs `expires_at < now()` não baixados
  (`downloaded_at IS NULL`) com output presente → remove output + tombstone
  (`output_file_url = NULL`). TTL controlado por `ASYNC_JOB_TTL_HOURS` (default 24).

---

## Flags & gates

```
Gate efetivo dos DOIS crons = ASYNC_PROCESSING_ENABLED=true && CRON_JOBS_CLEANUP_ENABLED=true
```

| Env var | Default | Papel |
|---|---|---|
| `ASYNC_PROCESSING_ENABLED` | `false` | Liga toda a feature async (rota + fila + worker). Pré-requisito. |
| `CRON_JOBS_CLEANUP_ENABLED` | `false` | Kill-switch **dedicado** dos crons de cleanup async. |
| `CRON_DRY_RUN` | `false` | **GLOBAL** — ver aviso abaixo. Loga o que faria, NÃO toca DB/Storage. |
| `ASYNC_PENDING_SWEEP_MINUTES` | `10` | Idade mínima de PENDING pra ser órfão. Range 5–1440. |
| `ASYNC_STUCK_PROCESSING_MINUTES` | `60` | Idade mínima de PROCESSING pra force-fail. Range 15–1440. |
| `ASYNC_JOB_TTL_HOURS` | `24` | Janela até purgar output+inputs. Range 1–168. |

> ⚠ **`CRON_DRY_RUN` é GLOBAL — afeta TODOS os 6 crons, inclusive os de LGPD
> (`history-purge`, `cron-runs-cleanup`, `dead-letter-reprocess`, `quota-alert`).**
> Ligar `CRON_DRY_RUN=true` pra validar o cleanup async coloca os crons LGPD em
> dry-run junto. **Por isso, valide o cleanup async ANTES de ligar os crons LGPD
> de history** (`HISTORY_FEATURE_ENABLED` + `CRON_PURGE_ENABLED`) — não os ative
> no mesmo run de validação dry-run. Em `NODE_ENV=production` + `CRON_DRY_RUN=true`,
> o boot emite `console.warn` e `observability.ts` dispara evento ALERTABLE
> (`cron.async_cleanup.dry_run.start`) — sinal de "dry-run esquecido".

---

## Checklist de ATIVAÇÃO em produção (o GATE)

Executar **em ordem**. Não pular o dry-run.

### Pré-requisitos (T-0)
- [ ] `ASYNC_PROCESSING_ENABLED=true` já ativo e validado (rota `/process/async`
      funcionando, worker consumindo a fila — smoke E2E do 7.5 verde).
- [ ] Worker no ar (`npm run worker`) com Redis TCP dedicado conectado.
- [ ] Supabase Storage configurado (`SUPABASE_URL`/`STORAGE_KEY`/`STORAGE_BUCKET`).
- [ ] Máquina API com `min_machines = 1` (senão crons não disparam).

### Passo 1 — Ligar em DRY-RUN
```bash
fly secrets set ASYNC_PROCESSING_ENABLED=true CRON_JOBS_CLEANUP_ENABLED=true CRON_DRY_RUN=true --app <APP>
# (deploy/restart conforme o fluxo do Fly)
```
**Garantir que `HISTORY_FEATURE_ENABLED` siga `false`** neste momento (senão os
crons LGPD entram em dry-run junto — ver aviso global acima).

### Passo 2 — Observar o primeiro run (≥ 5 min pro sweeper, próximo 12:00 UTC pro storage)
Logs esperados (pino):
- Sweeper: `[DRY_RUN] sweeper veria N PENDING + M PROCESSING candidatos`
  (`jobName: async-job-sweeper`, `dryRun: true`).
- Storage: `[DRY_RUN] storage cleanup veria X jobs c/ inputs + Y outputs expirados`
  (`jobName: async-storage-cleanup`, `dryRun: true`).

**Critério de sanidade:** os contadores fazem sentido pro volume real? Em ambiente
pré-go-live/baixo volume, esperado é **near-zero**. Número alto inesperado de
`wouldScanPending` = investigar enqueue path ANTES de ligar a recuperação real.

### Passo 3 — Desligar dry-run (ativação real)
```bash
fly secrets set CRON_DRY_RUN=false --app <APP>
```
Confirmar no próximo run que os gauges movem (ver Observabilidade).

---

## Observabilidade

**Gauges** (`setAsyncCleanupCount` → `src/scheduler/metrics.ts`):
- `orphan-reenqueued` — auto-cura: órfãos re-enfileirados (bom).
- `orphan-failed-refunded` — **serviço perdido**: cliente reservou e não recebeu.
- `stuck-processing` — PROCESSING travados forçados a FAILED.
- `storage-purge-pending` — terminais ainda com inputs por purgar (deve convergir a 0).

**Eventos ALERTABLE** (`emitSchedulerEvent` → Sentry):
- `cron.async_cleanup.orphan_failed_refunded` (warning) — **sinal #197 primário**:
  órfão perdido → on-call investiga o enqueue path.
- `cron.async_cleanup.stuck_failed` (warning) — jobs travados recuperados.
- `cron.async_cleanup.purge_pending_overdue` (warning) — `storage-purge-pending > 1000`.
- `cron.async_cleanup.inputfiles_unparseable` (error) — metadata de input ilegível
  (DB corrompido / write divergente) → PII órfã não-enumerável.
- `cron.async_cleanup.dry_run.start` (info, ALERTABLE em prod) — dry-run ativo.

---

## Kill-switch & rollback

Desligar **sem deploy de código** (só secret + restart):
```bash
fly secrets set CRON_JOBS_CLEANUP_ENABLED=false --app <APP>
```
Isso para **ambos** os crons async. Os crons LGPD (gate `HISTORY_FEATURE_ENABLED`)
seguem independentes.

**Rollback suave (sem parar tudo):** `CRON_DRY_RUN=true` mantém os crons rodando
mas inertes (logam, não mutam) — útil pra observar sem desligar. Lembrar do efeito
GLOBAL.

---

## Decision tree — incidente

```
Alerta de async-cleanup disparou?
├─ orphan_failed_refunded > 0 (recorrente)?
│  └─ Enqueue path está perdendo jobs entre job.create e enqueueProcessJob.
│     Investigar: Redis TCP estável? crash do server entre as duas ops?
│     Ver process-async controller + process-queue.ts. NÃO é o cron com bug —
│     o cron é o detector. Job foi FAILED + quota estornada (cliente protegido).
│
├─ purge_pending_overdue (storage-purge-pending > 1000)?
│  └─ Storage cleanup não está vencendo o backlog. Causas: Storage REST lento/erros,
│     metadata unparseable em massa, cron não rodando (ver cron-stuck.md).
│     Checar gauge ao longo do tempo — está subindo ou estável?
│
├─ inputfiles_unparseable > 0?
│  └─ PII órfã: inputs não purgáveis por metadata ilegível. Reconciliação manual
│     bucket-wide necessária. Escalar — risco LGPD (dado de usuário não removível
│     pelo caminho normal).
│
├─ Cron não está rodando (nenhum log no schedule esperado)?
│  └─ Ver cron-stuck.md + lock-stuck.md. Checar min_machines=1 da API (scale-to-zero
│     mata o disparo) e o gate ASYNC_PROCESSING_ENABLED && CRON_JOBS_CLEANUP_ENABLED.
│
└─ Suspeita de purga indevida (deletou output/input que não devia)?
   └─ Diferente do purge LGPD de history — ver purge-overshoot.md pra o fluxo LGPD.
      Aqui: Storage Supabase NÃO tem versioning → delete é irreversível. Conferir
      filtro (expires_at < now AND downloaded_at IS NULL) e ASYNC_JOB_TTL_HOURS.
      Kill-switch primeiro, investigar depois.
```

---

## Garantias de segurança (por que reentry é seguro)

- Ambos `idempotent: true`. Transições status-guarded (`WHERE status=...`,
  `count===1` decide). Re-enqueue idempotente por `Job.id`.
- Sweeper: claim PENDING→FAILED **+ estorno na MESMA transação** (atômico, sem
  janela "FAILED sem estorno"). Nenhuma chamada externa (Redis/Storage) roda
  dentro de transação.
- Storage: `removeByPath` 404-safe; parcial deixa `inputs_purged_at` NULL pro
  próximo run (anti órfão permanente). Tombstone evita re-scan eterno.
- Anti-race com o worker (R-3): lock de linha do Postgres elege 1 vencedor;
  `safeGetJobState` distingue órfão (ausente da fila) de "ainda na fila".

---

## Referências

- Card 6.7 + sweeper #197 — `src/jobs/async-cleanup.job.ts`.
- Plano `.claude/plans/2026-06-22-card-6.7-async-cleanup-e-sweeper-197.md`.
- `src/scheduler/jobs.bootstrap.ts` — registro dos 6 crons + gates.
- Runbooks relacionados: `cron-stuck.md`, `lock-stuck.md`, `dead-letter-purge.md`,
  `quota-alert-stuck.md`, `purge-overshoot.md` (LGPD history, fluxo distinto).
- Binding #4 da Fase 6 ([HIST] #205) — este runbook é o gate de ativação.
