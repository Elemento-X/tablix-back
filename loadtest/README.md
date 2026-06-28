# Load test — /process/sync (Fase 7.5 / Card #229)

Calibra `PROCESS_SYNC_MAX_CONCURRENCY` (#219) ↔ `maxInputCells` (#225) por **RSS p95 real** em staging. **NÃO-DESTRUTIVO** (#218 / WV-2026-010): store dev/test COMPARTILHADO → janela coordenada pelo dono + cleanup escopado. Plano: `.claude/plans/2026-06-28-fase-7-5-load-test-process-sync-staging.md`.

## Artefatos
- `bin/k6.exe` — binário k6 v0.49 (baixado; `.gitignore`).
- `seed.ts` — cria pool de 8 PRO sintéticos + minta JWTs (`.jwts.json`). **GATED** (toca DB).
- `cleanup.ts` — dry-run/`--apply` da purga escopada. **GATED** (review @dba).
- `make-fixtures.ts` — gera as fixtures.
- `sync.k6.js` — cenários k6 (smoke/ramp/sustained/burst/adversarial) + canary-ping.

## Pré-condições (gate do dono)
1. **Janela coordenada** (avisar consumidores do dev/test).
2. **`flyctl scale count web=1 --app tablix-back-staging`** nas ondas de calibração (R-4).
3. Review do @dba + @security nos `seed.ts`/`cleanup.ts` (já dispatchado).

## Execução (na janela)
```bash
cd /c/programming/tablix-back
# 0) Baseline counts (Task 0.3) — ANTES de qualquer write:
#    via Supabase MCP/psql: SELECT count(*) FROM usage; SELECT count(*) FROM audit_log;
# 0.1) Gerar fixtures (local, não toca store):
npx tsx loadtest/make-fixtures.ts
# 0.2) Seed do pool (GATED — janela + review):
npx tsx loadtest/seed.ts
# 1) Smoke / S-1 gate (Fase 2): provar que a carga CHEGA no parse
bin/k6 run -e SCENARIO=smoke -e FIXTURE=fixtures/dense.xlsx -e FIXTURE_NAME=dense.xlsx -e FIXTURE_TYPE=xlsx loadtest/sync.k6.js
#    Em paralelo: fly logs | grep "process/sync heap usage"  → confirma parse + rssAfterMB
#    Confirmar R-8: rejeitos = concurrency.rejected (#219), NÃO rateLimited (per-IP) nem limitExceeded (quota)
# 2) scale web=1, depois ramp/sustained (Fase 3):
fly scale count web=1 --app tablix-back-staging --yes
bin/k6 run -e SCENARIO=ramp ... loadtest/sync.k6.js
bin/k6 run -e SCENARIO=sustained -e VUS=5 -e DURATION=8m ... loadtest/sync.k6.js
#    Coletar: rssAfterMB p95 (logs) + fly machine status RSS + canary_ping_ms p95
#    Se RSS p95 ≥ 410MB: repetir com fly secrets set PROCESS_SYNC_MAX_CONCURRENCY=2
# 3) burst (Fase 4): forçar 503 + Retry-After + recuperação + zero OOM
bin/k6 run -e SCENARIO=burst -e VUS=25 ... loadtest/sync.k6.js
# 4) adversarial (Fase 5): pico XLSX.read
bin/k6 run -e SCENARIO=adversarial -e FIXTURE=fixtures/wide.xlsx -e FIXTURE_NAME=wide.xlsx -e FIXTURE_TYPE=xlsx loadtest/sync.k6.js
#    cap-hit do maxInputCells (multi-file >1.5M): curl com 4× -F files=@fixtures/dense.xlsx → espera 400 LIMIT_EXCEEDED
```

## Watch durante (kill criteria)
`fly logs --app tablix-back-staging | grep -iE "out of memory|oom|killed"` + `fly status` (restart de máquina) = abortar a onda.

## Teardown (Fase 6) — obrigatório
```bash
fly secrets set PROCESS_SYNC_MAX_CONCURRENCY=<valor calibrado> --app tablix-back-staging  # registrar p/ 7.6
fly scale count web=2 --app tablix-back-staging --yes      # restaurar redundância (R-7)
npx tsx loadtest/cleanup.ts                                # DRY-RUN — validar counts c/ @dba
npx tsx loadtest/cleanup.ts --apply                        # purga escopada
#   verificar: counts == baseline da Task 0.3
```

## Critérios de sucesso (go/no-go 7.6)
- RSS p95 (FIX-LEGIT-MAX, valor escolhido) **< ~410MB** (80% de 512MB), triangulado.
- **Zero OOM kill** em qualquer onda.
- Valor final de concorrência por evidência, aplicado via secret, replicável no 7.6.
- 503 só sob burst, `Retry-After` ∈ [2,5]s, recuperação limpa.
- Cleanup verificado (counts == baseline); staging restaurado (web=2 + secrets corretos).

## NUNCA
- Tocar `audit_log_legal` (#150, retenção legal 5 anos).
- Commitar `.jwts.json` / `fixtures/` / `bin/` (`.gitignore`).
- Rodar `cleanup --apply` sem o dry-run revisado pelo @dba.
- Rodar fora da janela coordenada.
