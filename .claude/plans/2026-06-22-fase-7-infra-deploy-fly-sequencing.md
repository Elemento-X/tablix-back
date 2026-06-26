# Plano @planner — Fase 7 (Infra & Deploy / Fly.io) — Sequenciamento

> Gerado por @planner em 2026-06-22. Plano de SEQUENCIAMENTO (não implementação).
> Referenciar nos cards #45–#50, #61, #63, #84, #85, #89, #95, #143, #144, #149.

## Achados que comandam o sequenciamento

- `env.ts` com `NODE_ENV=production` exige ~16 grupos de vars (6 price IDs, 2 Upstash REST + 1 TCP host distinto, trio Supabase, Sentry, FRONTEND_URL https, e — se `HISTORY_FEATURE_ENABLED` — `ADMIN_USER_IDS` + `ADMIN_STEPUP_SECRET`). **Sem os 6 price IDs, o boot em prod falha.**
- Os crons rodam no processo **API** (`server.ts`), não no worker.
- Schema Prisma já está majoritariamente em `Timestamptz(3)` → 7.10 é quase residual (verificação).
- `docs/runbooks/async-cleanup.md` foi escrito nesta sessão (gate do binding #4 fechado).

## Decisões a fechar antes de tocar Fly
- **D-STAGING-ENV:** staging com `NODE_ENV=production` (twin fiel, exige os 6 price IDs) vs `development` (boot frouxo). Recomendação: **production** (twin fiel).
- **D-HISTORY-PROD:** `HISTORY_FEATURE_ENABLED` no go-live? Se sim, `ADMIN_USER_IDS` + `ADMIN_STEPUP_SECRET` viram obrigatórios. Recomendação: manter **false** se history não entra agora.
- **D-API-SCALE:** API `min_machines=1` (crons + webhook vivos) vs scale-to-zero. Recomendação: **min_machines=1** até migração pra Fly scheduled machines (#149) — senão R-7 (crons/webhook morrem em cold start).

## DAG / Caminho crítico
```
price IDs → 7.1 → 7.2 → 7.3 → 7.4 → 7.5 (staging GREEN gate) → 7.6 → 7.7 → go-live
```
Paralelizável fora do fio: 7.8/7.9/7.10/7.11/7.12/7.13/7.14.
**Gates de qualidade antes de 7.6 (migrate prod): 7.11 (RLS) + 7.14 (rollback).**

## Ondas

### ONDA A — Prep (sem Fly, sem Cloudflare) — COMEÇA AGORA
- **7.11 RLS audit** [@dba ‖ @security] — gate de prod.
- **7.14 rollback-script storage migrations** [@devops] — antes de qualquer migrate.
- **7.1 Dockerfile + fly.toml (AUTHORING + build local)** [@devops ‖ @performance] — carrega bindings #1/#2/#3/#6; prova local (imagem cabe em 256MB? worker acha parse-worker.thread.js?) com custo Fly zero.
- **7.12 audit_log partial index** [@dba].
- **7.10 TIMESTAMPTZ** [@dba] — rebaixar a verificação.
- **7.8 multi-currency pipeline fixes** [core + @security].
- **7.9 Stripe CLI + webhook secret dev** [BAIXO].
- **Prep não-card (dono):** 6 price IDs (test) + 2º DB Upstash TCP (rediss://, host≠REST, noeviction) + bucket staging Supabase.

### ONDA B — Conta Fly + segredos (serial no fio crítico)
1. 7.1 deploy → 2. 7.2 secrets → 3. 7.3 migrate staging → 4. 7.4 webhook+redis → 5. 7.5 smoke E2E (gate de promoção).

### ONDA C — Prod + go-live
- 7.6 prod twin [CRÍTICO] ‖ 7.13 bucket prod + parity → 7.7 multi-currency Cloudflare [SEGURADO, WV-2026-004 vivo até 2026-09-15].

### ONDA D — Pós go-live
- #149 [FUTURO] crons → Fly scheduled machines (resolve R-7).

## Bindings herdados (Fase 6) → onde encaixam
| Binding | Card |
|---|---|
| #1 worker kill_timeout≥20s + min=max=1 | 7.1 (fly.toml) |
| #2 dist inclui parse-worker.thread.js | 7.1 (Dockerfile) — provar local na Onda A |
| #3 pool Postgres dedicado worker | 7.2 (secrets) + 7.3 (DIRECT_URL) |
| #4 crons flag+GATE+runbook+dry-run | 7.2 (flags off) + runbook (FEITO). CRON_DRY_RUN é GLOBAL |
| #5 npm audit gate | Onda A manual pré-deploy. axios HIGH vs WV-2026-005 (exp 2026-07-23) |
| #6 budget alert Upstash + liveness worker | 7.1 (healthcheck) |
| #7 re-instrumentar pipeline.jsonl | tratado nesta sessão |

## Pre-mortem (ordem de probabilidade)
1. env.ts boot-fail por var faltando (price ID, host Upstash colidindo, Supabase, ADMIN_*). **Altíssima.**
2. OOM 256MB no worker (xlsx descomprime). **Alta.** Mitig: concurrency=1, resourceLimits (96+32), heartbeat rss, máquina dedicada/512MB.
3. worker não acha parse-worker.thread.js em prod. **Média-alta.** Mitig: provar local + smoke 7.5.
4. Pool Postgres esgotado (API+worker+crons). **Média-alta.** Mitig: binding #3.
5. Cold start mata webhook/cron (scale-to-zero). **Média.** Mitig: D-API-SCALE.

## Recomendação — por onde COMEÇAR
**Card primário: 7.1 — Dockerfile + fly.toml em modo AUTHORING + build local (sem conta Fly).** Carrega 4 dos 7 bindings e os 2 itens de maior incerteza (cabe em 256MB? worker acha o .js?). Falhar local é barato; falhar no `fly deploy` é caro.
**Em paralelo:** 7.11 RLS (autorizado) + 7.14 rollback + prep não-card (price IDs + 2º DB Upstash).
**Não começar por:** 7.2–7.6 (esperam Fly) nem 7.7 (Cloudflare segurado).

## Path-matrix (agentes por card)
7.1 @devops+@performance · 7.2 @devops+@security · 7.3 @dba+@devops · 7.4 @dba+@devops+@security · 7.5 @devops+@security+@performance · 7.6 pré-release full · 7.7 @security+@dba (api-contract) · 7.8 @security · 7.10 @dba · 7.11 @dba+@security · 7.12 @dba · 7.13 @dba+@devops · 7.14 @devops.
