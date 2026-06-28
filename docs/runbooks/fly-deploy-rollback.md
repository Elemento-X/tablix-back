# Runbook — Fly.io Deploy Rollback

Como reverter um deploy ruim do backend no Fly.io de forma rápida e segura, voltando para uma imagem (release) anterior conhecida como boa. Use junto com `database-rollback.md` quando o deploy ruim também tiver rodado migration.

> **ESCOPO: STAGING (`tablix-back-staging`).** Para produção (Card 7.6) **NÃO copie os comandos verbatim** — veja a seção "Deltas de produção (7.6)" no fim. App de prod tem nome próprio, possivelmente `strategy=bluegreen` e `min_machines_running ≥ 2`, o que muda a mecânica.

> **Parametrize.** Defina o app uma vez e use `$APP` nos comandos:
> ```bash
> APP=tablix-back-staging   # produção: trocar pelo app de 7.6
> ```

> **Princípio:** rollback de deploy reverte **código (imagem)**, NUNCA banco. Migration é forward-only (expand-contract). Se o deploy ruim aplicou DDL, rollback de imagem + schema novo tem que ser COMPATÍVEL (é por isso que expand-contract existe). Ver "Interação com migrations".

> **Drill validado:** 2026-06-28 (Card #217) em `tablix-back-staging`. Evidência ao fim do doc.

---

## Quando usar

- Deploy novo subiu, health check passou, mas há **regressão funcional** (bug que o health não pega: erro de contrato, 500 em rota, comportamento errado).
- Deploy novo está com **erro de boot intermitente** ou **performance degradada** sob carga.
- Você precisa voltar AGORA e investigar depois (mean-time-to-recovery > mean-time-to-debug).

**NÃO use rollback se:** o problema é dado/migration (use `database-rollback.md`), ou se "rolar pra frente" (hotfix via fast-path) é mais rápido e seguro. Rollback é UM caminho, não o único.

---

## Pré-condições

### 1. Autenticação — token de deploy NÃO-INTERATIVO (caminho primário de incidente)

`fly auth login` abre navegador. Às 3h da manhã, no celular ou numa sessão SSH headless, isso **trava a recuperação**. Tenha um token de deploy gerado ANTES do incidente, guardado no gerenciador de senhas do on-call:

```bash
# Gerar UMA VEZ (com sessão boa), guardar no 1Password/secret manager do on-call:
fly tokens create deploy --app "$APP"

# No incidente, exportar e seguir — sem navegador.
# `read -rs` evita o token cair no history do shell (sem eco):
read -rs FLY_API_TOKEN && export FLY_API_TOKEN
fly status --app "$APP"   # confirma que o token funciona
```

- **Fallback** (estou no meu desktop, com browser): `fly auth login` (interativo). Sessões longas expiram — se a API começar a dar `unauthorized` no meio de uma sessão, é o token; re-autentique.
- Para PROD (7.6): token de deploy não-interativo é **requisito**, não conveniência. Sem ele, não há recovery confiável fora do horário comercial.

### 2. Saber qual release é a última boa (e ter como reconstruí-la)

```bash
fly releases --image --app "$APP"
```

Saída (exemplo do drill):

```
VERSION  STATUS    DESCRIPTION  DATE        DOCKER IMAGE
v2       complete  Release      15m ago     registry.fly.io/tablix-back-staging:deployment-01KW5TA478...  ← atual (ruim)
v1       complete  Release      3h ago      registry.fly.io/tablix-back-staging:deployment-01KW5EZTW...  ← última boa
```

Anote o **DOCKER IMAGE** completo da release-alvo.

> As imagens de deployment ficam retidas no `registry.fly.io` por bastante tempo, **mas não há garantia eterna** (podem ser coletadas por GC). Se a imagem-alvo não existir mais, `fly deploy --image` falha — caia no **fallback de rebuild por SHA**:
> ```bash
> # Reconstrói a imagem boa a partir do commit conhecido.
> # Garanta árvore limpa antes do checkout (git stash se houver alteração local):
> git stash --include-untracked   # se necessário; senão pule
> git checkout <sha-da-release-boa>
> fly deploy --process-groups web --strategy rolling --app "$APP" --remote-only
> git checkout -   # volta pro branch anterior
> ```
> Recomendado: ao marcar uma release como "boa", anote o git SHA junto da version (ex.: no Trello/CHANGELOG) pra rebuild determinístico.

---

## Procedimento

> **CRÍTICO — escopo `--process-groups web`:** este app tem dois process groups (`web` + `worker`). O `worker` roda em **count=0** (dark launch) em operação normal. Um `fly deploy` SEM escopo recria uma máquina para CADA process group — incluindo um `worker` da imagem-alvo. Se a imagem-alvo for **anterior** ao fix do idle-block (Card #216), esse worker sai com `exit 0` e o `fly deploy` dá **timeout** esperando ele atingir "started". Por isso, rollback que toca só o HTTP deve ser escopado ao `web`.

### 1. Confirme o estado atual (baseline)

```bash
fly status --app "$APP"                                                  # quantas web? (importa no step 2)
fly image show --app "$APP" | grep -oE "deployment-[A-Z0-9]+" | sort -u  # imagem rodando AGORA
# + um smoke do sintoma (ex.: curl da rota que está com bug) pra ter o "antes"
```

### 2. Rollback do `web` para a imagem boa

```bash
fly deploy \
  --image registry.fly.io/tablix-back-staging:deployment-<REF_DA_RELEASE_BOA> \
  --process-groups web \
  --strategy rolling \
  --app "$APP"
```

- `--image` pula o build (a imagem já existe no registry) → rollback é rápido (segundos, não minutos). **Não** passe `--remote-only` aqui: é flag de build e vira no-op quando há `--image` (só confunde).
- **Downtime depende da contagem de web:**
  - **≥ 2 máquinas web** → `--strategy rolling` atualiza uma por vez; a outra segura o tráfego ⇒ quase-zero-downtime. (Confirme com o `fly status` do step 1.)
  - **1 máquina web** (`min_machines_running = 1`) → rolling para/atualiza/sobe a única instância ⇒ **blip real de ~15-25s** (grace_period + cold boot do Firecracker). Se downtime é inaceitável, escale pra 2 antes (`fly scale count web=2 --app "$APP"`) ou use `--strategy bluegreen`.
- `--process-groups web` NÃO toca o `worker` (continua em count=0).

### 3. Verifique que reverteu (com janela de observação)

Não declare "recuperado" com 1 request OK. Sequência:

```bash
# (a) Espere o rolling TERMINAR — todas as web na release nova:
fly status --app "$APP"   # repita até TODAS as máquinas web mostrarem a mesma version nova
                          # (durante o rolling o `image show` pode listar 2 refs — é transiente)

# (b) Imagem efetivamente rodando = a REF boa, única:
fly image show --app "$APP" | grep -oE "deployment-[A-Z0-9]+" | sort -u

# (c) Saúde + smoke do sintoma:
curl -s -o /dev/null -w "%{http_code}\n" https://"$APP".fly.dev/health/ready   # 200
# + repita o smoke do sintoma: o comportamento ruim sumiu?

# (d) JANELA DE OBSERVAÇÃO (5-10 min) — recuperação real é sob tráfego, não 1 curl:
fly logs --app "$APP"     # tail; taxa de erro deve cair ao baseline
#   + conferir no Sentry (SENTRY_ENVIRONMENT) os eventos pararem de chegar
#   + se houver métricas RED expostas, p95/erro voltando ao baseline
```

Critério de sucesso = erro de volta ao baseline **por N minutos**, não um único 200. Se o sintoma persistir mesmo na imagem boa → o problema NÃO era o deploy (provável: dado, dependência externa, config/secret). Pare e investigue antes de mexer mais.

### 4. Roll-forward (quando o fix estiver pronto)

Mesma mecânica, apontando para a imagem nova/corrigida:

```bash
fly deploy --image registry.fly.io/tablix-back-staging:deployment-<REF_NOVA> \
  --process-groups web --strategy rolling --app "$APP"
```

Ou, para a próxima correção de código, um `fly deploy --remote-only` normal (com build) a partir da branch corrigida.

---

## Rollback do `worker` (async ligado)

Em operação normal o worker está em count=0 e rollback de worker não se aplica. Quando o async estiver **ligado** (`ASYNC_PROCESSING_ENABLED=true`, `fly scale count worker=1`):

1. **Drene primeiro:** `fly scale count worker=0 --app "$APP"` para o worker parar de puxar jobs (o job em voo é recuperado pela idempotência do claim no próximo run — B-6.4.2).
2. Rollback do worker: `fly deploy --image <ref boa> --process-groups worker --app "$APP"`. Com count=0 isso atualiza a CONFIG do grupo, mas não há máquina ainda. A imagem-alvo PRECISA ter o idle-block (Card #216) OU async ligado, senão o worker sai exit-0 quando subir.
3. Reescale: `fly scale count worker=1 --app "$APP"` (exatamente 1 — sem dois workers na mesma fila no free). É o scale que materializa a imagem-alvo.

> Nota: num app de imagem única, deploy só do worker cria SKEW temporário web(nova)/worker(alvo). Aceitável, mas valide esse caminho em staging com async ligado antes de confiar nele em prod.

---

## Interação com migrations (LEIA antes de rollback)

Rollback de imagem **não reverte banco**. A disciplina expand-contract garante que:

- **Expand** (migration aditiva: coluna/índice/tabela novos) roda ANTES do deploy do código que usa. Rollback do código para uma versão que não conhece o novo objeto → **seguro** — DESDE QUE o expand seja aditivo de verdade: coluna nullable ou com default, sem constraint/trigger nova que o código velho viole. Um expand com `NOT NULL` sem default (ou check novo) quebra o INSERT do código antigo no rollback.
- **Contract** (drop de coluna/constraint antiga) só roda DEPOIS que nenhum código em produção usa mais. Rollback para uma versão que ainda usava o objeto dropado → **QUEBRA**.

Regra: **nunca faça contract no mesmo deploy do código que o consome.** Se precisar reverter schema, é outro procedimento → `database-rollback.md` (não este runbook). Em dúvida sobre se a release-alvo é compatível com o schema atual: role pra frente com hotfix em vez de rollback.

---

## Deltas de produção (Card 7.6)

Este runbook foi exercido em **staging**. Antes de usar em PROD, ajuste:

- **App name:** use o app de prod (não `tablix-back-staging`). Defina `APP=<app-prod>` no topo — todos os comandos já usam `$APP`.
- **Estratégia de deploy:** se prod usar `strategy = "bluegreen"` (fly.toml de 7.6), `fly deploy --image` se comporta diferente — cria um conjunto "green" paralelo e faz cutover, em vez de substituir in-place. A mecânica de verificação muda (validar o green antes do cutover). Reexercite o drill no app de prod.
- **min_machines_running ≥ 2:** prod deve ter ≥2 web pra rolling ser de fato zero-downtime (ver step 2).
- **Stores isolados (#218 / WV-2026-010):** staging e prod NÃO compartilham DB/Redis/Storage. Confirme que está operando no app certo antes de qualquer comando — rollback no app errado é incidente novo.
- **Observabilidade obrigatória:** em prod a janela de observação (step 3d) é mandatória — Sentry (`SENTRY_ENVIRONMENT=production`) + métricas + alertas. On-call ciente do rollback em andamento.
- **Auth:** token de deploy não-interativo provisionado e no secret manager do on-call (ver Pré-condições #1).

---

## Drill executado — evidência (2026-06-28, staging)

Ciclo completo validado em `tablix-back-staging` (escopo `web`, worker intocado em count=0, 2 máquinas web):

| Etapa | Imagem | `POST /webhooks/stripe` (sig forjada) | `/health/ready` |
|---|---|---|---|
| Baseline | v2 (fix-pack #215) | `400 WEBHOOK_SIGNATURE_INVALID` | 200 |
| Rollback → v1 | v1 (pré-fix) | `500 WEBHOOK_FAILED` (bug revertido) | 200 |
| Restaurar → v2 | v2 | `400 WEBHOOK_SIGNATURE_INVALID` (fix de volta) | 200 |

A mudança de `400 → 500 → 400` no mesmo input prova que o rollback efetivamente troca o código em runtime e que o roll-forward restaura. `--process-groups web` manteve o deploy robusto (sem o trap do worker v1 exit-0). Tempo por troca: segundos (imagem já no registry, sem rebuild).

> Não exercitado no drill (validar antes de confiar em prod): downtime de rolling com **web=1**; `fly deploy --process-groups worker` com async ligado; fallback de rebuild por SHA quando a imagem sumiu do registry.

---

## Comandos de referência

```bash
APP=tablix-back-staging                      # parametrize (prod: trocar)
fly tokens create deploy --app "$APP"        # token não-interativo (gerar ANTES do incidente)
read -rs FLY_API_TOKEN && export FLY_API_TOKEN  # auth headless, sem token no shell history
fly releases --image --app "$APP"            # histórico + image refs
fly image show --app "$APP"                  # imagem em runtime AGORA
fly status --app "$APP"                       # estado das máquinas + health + contagem web
fly deploy --image <ref> --process-groups web --strategy rolling --app "$APP"
fly logs --app "$APP"                         # janela de observação pós-rollback
fly auth login                               # fallback interativo (desktop com browser)
```

> flyctl v0.4.19 NÃO tem `fly releases rollback`. O caminho canônico aqui é `fly deploy --image <ref>` (controle explícito da imagem + escopo de process group).
