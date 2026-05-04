# Pipeline QA — Obrigatório

Este pipeline é **inegociável**. Toda entrega de código passa por ele, sem exceção. Esta rule é a fonte da verdade do processo: state machine, agentes, severity gating, waivers, métricas e responsabilidades. Toda divergência da prática real e desta rule deve ser tratada como bug do processo (atualizar a rule ou corrigir a prática — nunca ignorar).

## Princípio fundamental

O pipeline existe para garantir que **nenhuma entrega vá pro ar sem validação independente de múltiplos especialistas**. Não somos consultores — somos sócios técnicos responsáveis pelo que vai pra produção. Cada agente é dono do projeto tanto quanto o usuário.

O pipeline é determinístico no fluxo (state machine fixa) e probabilístico no conteúdo (LLM pode variar). Por isso, **rastreabilidade total é obrigatória**: registramos inputs, versões de prompt, findings individuais e decisões. Sem rastreabilidade, debug de "por que isso passou" é impossível.

## Time

### Pipeline core (sempre)

- **@tester** — QA. Escreve testes, valida coverage, edge cases. Roda em paralelo com @security.
- **@security** — Auditor ofensivo. OWASP, injection, validação, headers, rate limit. Roda em paralelo com @tester.
- **@reviewer** — Revisor sênior. Code review direto no código, recebe achados de todos como contexto, emite veredito final consolidado. **Tiebreaker** em conflito entre agentes.

### Pipeline estendido (acionado por path/tipo)

- **@dba** — Schema, índices, migrations, locks, MVCC, RLS, query plan, connection pooling. Acionado em mudança de banco.
- **@devops** — Docker, deploy, CI/CD, SLO, observabilidade, supply chain, secrets, IaC. Acionado em mudança de infra.
- **@design-qa** — Fidelidade visual ao spec do @designer. Acionado em UI nova.
- **@performance** — Bundle, runtime, Core Web Vitals. Acionado em deps, features pesadas, pre-release.
- **@seo** — Meta tags, structured data, semantic HTML, indexação. Acionado em páginas públicas.
- **@copywriter** — Tom de voz, microcopy, qualidade multilíngue, conversão. Acionado em texto novo voltado ao usuário.

### Suporte (sob demanda, fora do fluxo principal)

- **@planner** — Planeja e estrutura cards. **Não** valida.
- **@analyst** — Métricas, padrões, saúde do time. **Consome** o pipeline, não participa.
- **@designer** — Specs visuais. Alimenta o @design-qa.
- **@docs** — Sincronia documentação ↔ código.
- **@refactor** — Refatoração cirúrgica em worktree isolada.

## Detecção automática de agentes (CODEOWNERS-style)

**O operador não decide manualmente quais especialistas chamar.** A regra decide, baseada nos paths tocados pelo card. Esquecimento humano é inaceitável.

```
prisma/schema.prisma                → @dba (mandatório)
prisma/migrations/**                → @dba (mandatório)
src/db/**, src/repositories/**      → @dba (recomendado)
**/*.sql                            → @dba (mandatório)

Dockerfile, .dockerignore           → @devops (mandatório)
fly.toml, vercel.ts, render.yaml    → @devops (mandatório)
.github/workflows/**                → @devops (mandatório)
.env.example                        → @devops (mandatório)
scripts/deploy*, scripts/release*   → @devops (mandatório)

src/http/routes/**, src/api/**      → api-routes rule + api-contract rule + @reviewer carrega ambas
src/http/controllers/**             → api-routes rule + api-contract rule + @reviewer carrega ambas
src/http/middlewares/**             → api-routes rule + security rule + @reviewer carrega ambas
src/modules/**/*.schema.ts          → api-contract rule + @reviewer carrega rule
src/modules/**/*.routes.ts          → api-routes rule + api-contract rule + @reviewer carrega ambas

src/components/**, app/**/page.tsx  → @design-qa (se UI nova) + @copywriter (se texto)
app/**/layout.tsx, app/**/head.tsx  → @seo (se rota pública)

package.json, package-lock.json     → @performance (deps novas) + @devops (supply chain)

CHANGELOG.md, release/**            → pre-release pipeline (todos os core + @performance + @seo + @dba + @devops)
```

A matriz acima é **gate de entrada do pipeline**. Antes de iniciar a validação, o operador roda a checagem de paths e lista os agentes obrigatórios. Esquecer um agente obrigatório = pipeline inválido.

**Manter o glob:** quando criar novo agente ou rule, atualizar esta seção *e* o `CLAUDE.md` do projeto. Ver "Onboarding de novo agente" abaixo.

## Definition of Done — entrada do pipeline

**Código não entra no pipeline antes de cumprir todos os critérios abaixo.** Sem DoD, pipeline roda em código quebrado e gera ruído inútil.

- [ ] Build local passa (`npm run build` ou equivalente)
- [ ] Lint passa sem warnings (`npx eslint .`)
- [ ] TypeScript sem erros (`tsc --noEmit`)
- [ ] Migrations geradas e committadas (se aplicável)
- [ ] Variáveis novas em `.env.example` (se aplicável)
- [ ] Card existe no Trello e está na coluna correta da fase
- [ ] Branch dedicada criada (não commit direto em `main`)
- [ ] Diff revisado pelo próprio operador antes de submeter (auto-review)

Card que não cumpre o DoD volta pro autor com label `dod-failed` — não desperdiça ciclo de pipeline.

## State machine do pipeline

O card percorre estados explícitos. Cada transição tem timestamp registrado em `pipeline.jsonl` (alimenta lead time / MTTR).

```
DRAFT
  ↓ (DoD ok + operador submete)
QUEUED
  ↓ (operador inicia execução)
IN_VALIDATION_CORE       ← @tester + @security em paralelo
  ↓
IN_VALIDATION_EXTENDED   ← agentes estendidos detectados pela path-matrix (paralelo)
  ↓
IN_REVIEW                ← @reviewer consolida + emite veredito
  ↓
DECISION
  ├→ APPROVED → DONE
  ├→ REPROVED_HARD → IN_FIX → (volta pra QUEUED após correção, smart re-run)
  ├→ REPROVED_SOFT → WAIVER_REQUESTED → (decisão do operador)
  └→ ESCALATED → (intervenção humana do usuário)
```

**Estados extras:**
- `BLOCKED_BY_DEPENDENCY` — depende de outro card que ainda não passou
- `STALE` — em validação há mais que SLA (ver abaixo) sem progresso

Cada transição é registrada. `IN_VALIDATION_*` que persistem além do SLA disparam alerta automático.

## SLA por etapa

| Etapa | SLA target | SLA hard limit |
|---|---|---|
| `QUEUED → IN_VALIDATION_CORE` | < 5 min | < 30 min |
| `IN_VALIDATION_CORE` (tester + security paralelo) | < 30 min | < 2h |
| `IN_VALIDATION_EXTENDED` | < 30 min | < 2h |
| `IN_REVIEW` | < 15 min | < 1h |
| `IN_FIX` (após reprovação) | < 4h | < 24h |
| **Lead time total card pequeno (P)** | < 2h | < 8h |
| **Lead time total card médio (M)** | < 1 dia | < 3 dias |
| **Lead time total card grande (G)** | < 3 dias | < 1 semana |

Card que estoura SLA hard vira `STALE`, gera alerta no Trello (label `stale-pipeline`) e o operador deve justificar ou escalar. Sem isso, card pode ficar 2 semanas em validação invisível.

## Severity gating — não toda reprovação bloqueia igual

Cada finding tem `severity` (CRÍTICO | ALTO | MÉDIO | BAIXO). O comportamento de bloqueio é:

| Severity | Comportamento | Exemplo |
|---|---|---|
| **CRÍTICO** | Block hard. Pipeline reprovado. Correção obrigatória antes de qualquer aprovação. | Secret exposto, SQL injection, lost update silencioso |
| **ALTO** | Block hard. Reprovado. Correção obrigatória OU waiver formal com justificativa de @security/@reviewer. | Coverage abaixo de 90%, missing rate limit, ETag ausente em recurso editável |
| **MÉDIO** | Block soft. Reprovado por default, mas operador pode aprovar com waiver simples + criar card de follow-up. | Otimização ausente, log level inadequado, naming inconsistency |
| **BAIXO** | Não-bloqueante. Vira card automático no Backlog com label `pipeline-finding`. Pipeline aprova. | Convenção menor, melhoria incremental, doc faltando |

**Severity default por categoria** vem de `.claude/metrics/categories.json` (campo `default_severity`). Agente pode escalar ou reduzir caso a caso, com justificativa registrada.

**Anti-pattern proibido:** paralisar pipeline em finding BAIXO. Se isso acontece, é bug de calibração — tunar o agente, não fingir que o pipeline está rodando.

## Waiver — exceção formal

Quando um finding ALTO ou MÉDIO é aceito conscientemente (ex: "esse endpoint é interno, sem rate limit é OK"), o caminho é **waiver formal**, nunca "ignorar e seguir".

Estrutura do waiver:

```
WAIVER ID: WV-2026-001
Finding: [categoria] [arquivo:linha] [descrição]
Severity original: ALTO
Justificativa: <por que é aceitável>
Aprovado por: @reviewer ou usuário (em escalation)
Criado em: 2026-04-09
Expira em: 2026-07-09 (90 dias default; máx 180)
Re-review obrigatório: SIM (ao expirar)
Cards afetados: TBL-123, TBL-145
```

Waivers ficam em `.claude/metrics/waivers.jsonl` (append-only). @analyst monitora:
- Waivers vencidos → re-review automático
- Mesmo waiver renovado 3+ vezes → escalation pra correção definitiva (waiver virou dívida)
- Categoria com waivers recorrentes → review da regra (talvez seja desnecessária)

**Waiver não pode cobrir CRÍTICO.** Crítico bloqueia sempre. Se um crítico precisa de waiver, é incidente de processo — discutir com o usuário.

## Pipeline para hotfix / fast-path

Emergência em produção tem **fast-path documentado**, não bypass do pipeline.

```
HOTFIX FAST-PATH
  ├→ DoD reduzido: build + lint OK (sem coverage mínimo)
  ├→ Pipeline core obrigatório (@tester + @security + @reviewer)
  ├→ Pipeline estendido SKIP (mas registrado como skip, não como aprovação)
  ├→ Coverage e edge cases viram waiver auto-expirado em 7 dias
  ├→ Card marcado com label `hotfix-fast-path`
  └→ Postmortem obrigatório em 48h: por que precisou hotfix? root cause?
```

Sem fast-path, time vira refém do pipeline em incidente. Com fast-path mas sem postmortem, vira cultura de bypass — os 7 dias são pra **forçar** que a correção definitiva volte ao pipeline normal.

## Smart re-run — não rodar tudo após reprovação

Hoje a regra ingênua é "ciclo completo". Refinamento: **rodar só o necessário**, registrando o porquê.

```
Reprovação de @security em finding isolado
  → fix aplicado em 2 arquivos
  → re-run: apenas @security (focado nos arquivos do fix) + @reviewer
  → @tester roda novamente APENAS se o fix tocou código testado
  → @dba/@devops/extended roda novamente APENAS se o fix tocou paths que os ativam
```

Critério: re-run de agente X é obrigatório se o fix tocou path no glob de X. Caso contrário, é opcional (decisão do operador, registrada).

**Anti-pattern:** rerodar tudo "por garantia". Custa tempo + tokens (Opus é caro) sem ganho real. Smart re-run é estado-da-arte.

## Diff-aware review

Quando o pipeline reroda em revalidação ou recebe atualização incremental do card, agentes focam no **diff + arquivos relacionados**, não no projeto inteiro.

- "Arquivos relacionados" = arquivos que importam ou são importados pelos arquivos do diff (1 nível de profundidade).
- @security e @dba SEMPRE consideram o blast radius — se o diff toca uma função usada em 50 lugares, todos os 50 são "relacionados".
- @tester roda os testes do diff + testes que importam o código alterado (`--findRelatedTests` no Jest).
- Auditoria de projeto inteiro só em pre-release ou auditoria periódica explícita (não em todo card).

## Escalation path — discordância agente vs operador

Operador acha que o agente reprovou em falso positivo. Caminho formal:

1. **1ª discordância** — re-prompt com contexto adicional. "Veja este detalhe que você não considerou: <X>". Agente reavalia.
2. **2ª discordância** — operador propõe waiver formal com justificativa. @reviewer valida o waiver.
3. **3ª discordância** — escalation pro humano (usuário). Decisão final é do usuário, registrada como `escalation_decision` no `pipeline.jsonl`.

Escalation **não é falha** — é parte do processo maduro. Mas escalation recorrente do mesmo agente na mesma categoria sinaliza desbalanceio (ver Calibração abaixo).

## Conflito entre agentes

Quando dois agentes discordam (ex: @security exige rate limit estrito, @performance reclama de latência adicionada):

- **@reviewer é o tiebreaker.** Lê os dois relatórios + o código + emite decisão consolidada.
- @reviewer pode aprovar **condicionalmente** ("aceita o rate limit, mas exige cache de 10s na request mais comum pra mitigar latência").
- Se @reviewer não consegue resolver, escalation pro usuário.
- Decisão registrada como `tiebreaker_decision` no comentário do Trello e no JSONL.

**Critério geral:** segurança > correção > performance > ergonomia. @security tem peso maior em conflitos de risco; @performance tem peso maior em conflitos de UX.

## Rollback de aprovação — pipeline post-mortem

Se um pipeline aprovou e depois apareceu bug em produção:

1. **Reabrir o card original** com label `pipeline-miss`.
2. **Postmortem blameless do pipeline:**
   - Qual agente deveria ter pego?
   - Por que não pegou? (Categoria não existia, prompt incompleto, finding presente mas classificado como BAIXO, falso negativo do LLM, escopo não considerado, etc.)
   - Qual ajuste no agente / categoria / pipeline previne recorrência?
3. **Action items concretos:**
   - Adicionar categoria nova em `categories.json`
   - Atualizar prompt do agente (com bump de versão)
   - Adicionar caso de teste no agente (sim, agentes podem ter test cases)
   - Atualizar a path-matrix se um path foi ignorado
4. **Postmortem fica em** `.claude/metrics/postmortems/PM-YYYY-NNN.md` — não deletado, alimentado ao @analyst.

Pipeline miss **não é vergonha** — é input do sistema imunológico. O que é vergonha é não aprender.

## Histórico auditável (não só sagrado)

Regra antiga: "histórico no Trello é sagrado, nunca apagar". Refinamento:

- Comentários de pipeline no Trello **NUNCA** são editados ou apagados. Sempre append.
- Se houver erro num comentário (ex: agente rodou versão errada), publica-se **comentário de correção** logo abaixo, referenciando o original. Original fica intacto.
- @analyst consome via `mcp__trello__get_card_comments` em ordem cronológica — confia que a sequência reflete a verdade temporal.
- Comentários que precisam ser corrigidos por bug do operador também recebem comentário de correção, nunca edit.
- Backup automático do histórico relevante em `.claude/metrics/trello_snapshots/` (snapshot semanal) protege contra perda no Trello.

## Findings individuais com fingerprint

Schema antigo só conta agregado (`findings.critical: 2`). **Refinamento:** registrar cada finding individual com fingerprint estável — permite tracking longitudinal e detecção de padrões.

Fingerprint = hash determinístico de:
```
sha1(<agent>:<category>:<file_path>:<line_anchor>:<code_excerpt_normalized>)
```

`line_anchor` é a função/método/bloco contendo a linha (não o número exato — número muda com edits, anchor é estável). `code_excerpt_normalized` remove whitespace e comentários.

Mesmo finding em rerun → mesmo fingerprint. Permite:
- "Esse finding já foi reportado e ignorado/aceito antes"
- "Essa categoria aparece toda semana neste arquivo"
- "Novo finding aparece pela primeira vez"

## Versionamento de prompt dos agentes

Cada agente em `.claude/agents/*.md` tem campo `version` no front matter:

```yaml
---
name: dba
tools: Read, Glob, Grep
model: opus
version: 3.0
last_updated: 2026-04-09
---
```

`version` é semver simplificado:
- **MAJOR** — mudança de escopo/comportamento (rerun de findings históricos pode dar resultado diferente)
- **MINOR** — categoria nova ou hard rule nova
- **PATCH** — typo, clareza

A versão é registrada em cada entrada do `pipeline.jsonl` (`agent_versions: { dba: "3.0", security: "2.1", ... }`). @analyst usa pra:
- Comparar findings só dentro da mesma versão (apples-to-apples)
- Avisar quando uma versão teve "regressão" (achados aumentaram após mudança no prompt)
- Manter changelog dos agentes em `.claude/agents/CHANGELOG.md`

## Drift detection de categorias

Quando um agente reporta finding com categoria `foo-bar` que **não existe** em `categories.json`, isso é **bug do agente** — categoria fora do enum.

- Operador valida o enum antes de postar no Trello.
- Categoria nova pode ser proposta pelo agente, mas exige aprovação explícita do operador + adição em `categories.json` antes de virar finding válido.
- @analyst flagra categorias órfãs (existem no JSON mas nunca foram usadas em 90 dias) — candidatas a remoção.

## Calibração dos agentes via @analyst

@analyst gera relatório periódico (semanal ou pre-release) com:

- **Taxa de reprovação por agente** — se @security aprova 100%, está calibrado errado (frouxo). Se reprova 100%, idem (paranoico).
- **Severity distribution** — se 80% dos findings são CRÍTICOS, ou está em código terrível, ou o agente está inflando severidade.
- **Escalation rate por agente** — escalation alta indica agente em desbalanceio.
- **MTTR de reprovação por agente** — quanto tempo entre reprovação e re-validação.
- **Reincidência** — fingerprint visto antes em waiver vencido = sinal de débito acumulando.

Tunar o prompt do agente é decisão do usuário. @analyst só recomenda.

## Custo do pipeline

Cada execução consome tokens. @security e @dba são Opus (caros). Sem visibilidade, vira gasto invisível.

`pipeline.jsonl` registra (quando disponível):
- `tokens_input` / `tokens_output` por agente
- `cost_usd_estimate` (tabela de preço por modelo)
- `model_used` por agente

@analyst reporta:
- Custo médio por card (P/M/G)
- Custo total por mês
- Custo desperdiçado em re-runs evitáveis (smart re-run economiza)
- Top 5 cards mais caros do mês

Sem essa visibilidade, decisões como "rodar @security em todo commit" são tomadas no escuro.

## Visibility do pipeline em execução

Onde alguém vê "qual agente está rodando agora?".

- **Trello label dinâmico no card:** `pipeline:tester-running`, `pipeline:security-running`, `pipeline:reviewer-running`, `pipeline:approved`, `pipeline:reproved`.
- **Coluna "Validation":** card move pra essa coluna ao entrar no pipeline, sai ao terminar.
- **Comentário parcial:** quando um agente termina sua parte, posta seu trecho do relatório imediatamente — não espera o pipeline inteiro acabar. Operador atualiza o comentário consolidado depois.
- **Snapshot do estado em** `.claude/metrics/pipeline_state.json` — arquivo único atualizado em cada transição. `cat` rápido pra ver o que está rodando.

## Audit trail inter-agente

Quando @security pede ao @reviewer pra olhar algo específico durante a execução, ou @reviewer consulta @dba pra entender uma migration, **isso é registrado**.

```jsonl
{
  "timestamp": "2026-04-09T14:30:00Z",
  "card_id": "TBL-123",
  "type": "inter_agent_query",
  "from": "reviewer",
  "to": "dba",
  "context": "schema migration on subscriptions table — is the expand-contract correct?",
  "response_summary": "approved with note about constraint timing"
}
```

Sem isso, debug de "como o reviewer chegou nessa decisão" é impossível.

## Descobertas novas — lista default e priorização

A regra "descobertas novas viram cards novos" é mantida. Refinamento:

- **Lista default:** `Backlog` (não `Decisões Pendentes`, exceto se a descoberta exige decisão do usuário antes de virar card real).
- **Label padrão:** `pipeline-discovery` + label da categoria que originou (ex: `pipeline-discovery`, `dba`, `slow-query`).
- **Priorização inicial:** baseada na severity do finding original. CRÍTICO/ALTO viram top do backlog; MÉDIO/BAIXO entram na ordem.
- **Linkagem ao card original:** comentário no novo card referenciando o card que originou + finding fingerprint.
- **Operador valida antes de criar** — descoberta pode ser duplicata de card já existente. @analyst também detecta duplicatas via fingerprint.

## Pipeline em PR vs commit direto

**Política:** pipeline DEVE rodar em todo PR. Branch protection deve bloquear merge sem aprovação registrada. Commit direto em `main` é proibido (exceto via fast-path de hotfix com waiver auto-expirado).

CI futura vai aplicar isso automaticamente. Até lá, é regra de operador. Detectar commit direto em main em auditoria do @analyst → finding ALTO de processo.

## Operador principal — release captain

O Claude principal (eu, operador) tem responsabilidades formais. Não é "o que sobra":

**Responsabilidades:**
1. Validar DoD antes de submeter ao pipeline
2. Rodar a path-matrix e listar agentes obrigatórios
3. Disparar @tester + @security em paralelo
4. Disparar agentes estendidos detectados
5. Consolidar relatórios e enviar pro @reviewer
6. Postar comentário consolidado no Trello (1 por execução)
7. Mover card entre colunas conforme state machine
8. Gerenciar waivers: criar, validar, rastrear expiração
9. Detectar conflito entre agentes e acionar @reviewer como tiebreaker
10. Escalar pro usuário quando atingir 3ª discordância
11. Registrar entrada no `pipeline.jsonl` ao fim de cada execução
12. Em hotfix: aplicar fast-path e abrir postmortem em 48h
13. Garantir que findings novos viram cards no Backlog
14. Em pipeline miss: abrir postmortem e criar action items

**Não é responsabilidade do operador:**
- Aprovar tecnicamente (@reviewer faz)
- Calibrar agentes (usuário faz)
- Gerar relatórios de saúde (@analyst faz)
- Editar prompts dos agentes (usuário aprova)

## Onboarding de novo agente

Quando um agente novo (ou rule nova) é criado, **TODOS** os seguintes precisam ser atualizados — operador valida em checklist:

- [ ] `.claude/agents/<nome>.md` criado (com `version: 1.0`, `last_updated`)
- [ ] `.claude/metrics/categories.json` recebe bloco `<nome>` com categorias e `default_severity`
- [ ] `.claude/rules/qa-pipeline.md` (este arquivo) atualizado:
  - [ ] Agente listado em "Time" na seção apropriada
  - [ ] Path-matrix atualizada com globs do agente
  - [ ] Tabela de SLA revisada se o agente afeta lead time
- [ ] `CLAUDE.md` global do usuário (`~/.claude/CLAUDE.md`) atualizado:
  - [ ] Tabela de agentes
  - [ ] Estrutura padrão do `.claude/`
- [ ] `CLAUDE.md` do projeto atualizado:
  - [ ] Pipeline estendido lista o agente
  - [ ] Rules contextuais lista a rule (se houver)
- [ ] `.claude/agents/CHANGELOG.md` recebe entrada de criação
- [ ] Primeira execução piloto registrada em `pipeline.jsonl` com `notes: "first run of <agent>"`

Checklist é executado pelo operador, validado pelo usuário antes do commit.

## Pre-release pipeline

"Pre-release" não é vago. **Definição formal:**

- **Trigger:** card de release criado na coluna de release (ex: `Release v1.5.0`).
- **Disparado por:** operador, instruído pelo usuário.
- **Escopo:** auditoria geral do projeto, não só do diff.
- **Agentes obrigatórios (todos):** @tester, @security, @reviewer, @dba, @devops, @performance, @seo (se há páginas públicas), @copywriter (se há texto novo).
- **Modo diff-aware:** OFF. Auditoria full do projeto.
- **Severity gating mais rígido:** ALTO em pre-release vira CRÍTICO.
- **Waiver:** novos waivers em pre-release exigem aprovação do usuário (não só @reviewer).
- **Saída:** comentário consolidado + relatório de saúde do @analyst + go/no-go decision do usuário.
- **SLA:** card de pre-release pode levar 1-3 dias. Não é P/M/G — é categoria à parte.

Sem essa formalização, "pre-release" vira "@reviewer dá mais uma olhada" — superficial.

## Schema do `pipeline.jsonl` (v2)

Schema v1 está em produção mas não captura tudo necessário pros 28 gaps. Schema v2 (compatível pra leitura — campos novos opcionais):

```json
{
  "v": 2,
  "card_id": "trello-id",
  "card_title": "Título do card",
  "card_size": "P|M|G|RELEASE",
  "card_type": "feature|fix|refactor|security|ui|infra|hotfix|release",
  "phase": "Fase X",
  "files_changed": 4,
  "files_list": ["src/...", "prisma/..."],

  "timestamps": {
    "created_at": "2026-04-09T10:00:00Z",
    "queued_at": "2026-04-09T10:30:00Z",
    "validation_started_at": "2026-04-09T10:35:00Z",
    "review_started_at": "2026-04-09T11:00:00Z",
    "decided_at": "2026-04-09T11:15:00Z",
    "done_at": "2026-04-09T11:20:00Z"
  },

  "lead_time_hours": 1.33,
  "mttr_hours": null,

  "state_transitions": [
    { "from": "DRAFT", "to": "QUEUED", "at": "2026-04-09T10:30:00Z", "by": "operator" },
    { "from": "QUEUED", "to": "IN_VALIDATION_CORE", "at": "2026-04-09T10:35:00Z", "by": "operator" }
  ],

  "agents_invoked": {
    "tester": "approved",
    "security": "approved",
    "reviewer": "approved",
    "dba": "reproved_then_approved"
  },

  "agent_versions": {
    "tester": "2.0",
    "security": "2.1",
    "reviewer": "1.5",
    "dba": "3.0"
  },

  "cycles": 2,

  "findings_aggregate": {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3
  },

  "findings_individual": [
    {
      "fingerprint": "a3f9c2...",
      "agent": "dba",
      "category": "missing-index",
      "severity": "high",
      "file": "prisma/schema.prisma",
      "line_anchor": "model:Subscription",
      "blocked_pipeline": true,
      "fixed_in_cycle": 2,
      "waiver_id": null
    }
  ],

  "waivers_applied": ["WV-2026-001"],

  "tiebreaker_decisions": [],

  "escalations": [],

  "smart_rerun": {
    "enabled": true,
    "skipped_agents": ["tester"],
    "skip_reason": "fix did not touch tested code"
  },

  "diff_aware": true,

  "fast_path": false,

  "cost_estimate": {
    "tokens_input": 45000,
    "tokens_output": 12000,
    "cost_usd": 2.34,
    "by_agent": {
      "security": 1.20,
      "dba": 0.85,
      "reviewer": 0.20,
      "tester": 0.09
    }
  },

  "coverage_delta": 2.3,

  "inter_agent_queries": [],

  "postmortem_link": null,

  "notes": ""
}
```

Schema v1 continua válido em entradas históricas. v2 entra em todas as novas execuções a partir desta data.

## Formato do comentário no Trello

**1 comentário consolidado por execução do pipeline.** Os blocos são fixos; agentes ausentes (não acionados) aparecem como `N/A — não acionado pela path-matrix`.

```
PIPELINE QA — 2026-04-09 — execução #1

CARD: TBL-123 — Add subscription cancellation flow
SIZE: M | TYPE: feature | FILES: 8
AGENTES ACIONADOS: tester, security, reviewer, dba (extended via prisma/schema.prisma)
AGENTES NÃO ACIONADOS: devops, design-qa, performance, seo, copywriter

VALIDAÇÃO @tester (v2.0) — APROVADO
[resumo: coverage 92% no módulo, edge cases X/Y/Z testados]

AUDITORIA @security (v2.1) — APROVADO
[resumo: rate limit OK, validação Zod OK, sem vetor de injection]

DBA @dba (v3.0) — REPROVADO ALTO
- [missing-index] prisma/schema.prisma:model:Subscription — query de cancelamento sem índice em (user_id, status)
- Recomendação: CREATE INDEX CONCURRENTLY ix_sub_user_status ON subscriptions(user_id, status)

REVISÃO @reviewer (v1.5) — REPROVADO (consolidado)
Veredito: REPROVADO. Concordo com @dba — sem o índice, query escala mal. Resto OK.

WAIVERS APLICADOS: nenhum
ESCALATIONS: nenhuma
LEAD TIME ATÉ AGORA: 45min
```

Após correção, **novo comentário** (não edit):

```
PIPELINE QA — 2026-04-09 — execução #2 (re-validação smart re-run)

SMART RE-RUN: SIM. Agentes re-executados: dba, reviewer. Skipped: tester (não tocou código testado), security (não tocou superfície de segurança).

DBA @dba (v3.0) — APROVADO
[índice criado, expand-contract correto]

REVISÃO @reviewer (v1.5) — APROVADO
[finding resolvido, demais áreas inalteradas]

LEAD TIME TOTAL: 1h15min | MTTR: 30min
```

## Organização do Board Trello

Ordem das colunas (esquerda → direita):

```
History | Backlog | Decisões Pendentes | <colunas das fases> | Validation | Done/Completed
```

- **History** — cards consolidados de fases concluídas
- **Backlog** — itens identificados mas não priorizados (inclui findings BAIXO automáticos)
- **Decisões Pendentes** — depende de decisão do usuário
- **Colunas das fases** — trabalho ativo
- **Validation** — cards em pipeline (qualquer estado entre QUEUED e DECISION)
- **Done/Completed** — APPROVED + DONE

Labels dinâmicos durante execução do pipeline:
- `pipeline:queued` | `pipeline:tester-running` | `pipeline:security-running` | `pipeline:dba-running` | `pipeline:devops-running` | `pipeline:reviewer-running` | `pipeline:approved` | `pipeline:reproved-hard` | `pipeline:reproved-soft` | `pipeline:waiver-pending` | `pipeline:escalated` | `pipeline:stale` | `pipeline:hotfix-fast-path`

## Retroatividade

- Pipeline aplica-se retroativamente a fases concluídas. Fase entregue sem pipeline completo: rodar do zero sobre o estado atual.
- Métricas anteriores ao schema v2 (`v: 1`) ficam em ambiente legacy. @analyst trata os dois schemas, mas reporta separadamente.
- Postmortems de pipeline miss criados desde data de adoção desta rule. Antes disso, não temos baseline.

## Mudanças vs versão anterior desta rule

Esta versão fecha 28 gaps identificados em auditoria. Principais adições:

1. Path-matrix de detecção automática de agentes (CODEOWNERS-style)
2. Definition of Done formal antes da entrada
3. State machine explícita com timestamps
4. SLA por etapa + STALE detection
5. Severity gating (CRÍTICO/ALTO bloqueia, MÉDIO soft, BAIXO automático)
6. Waivers formais com expiração
7. Fast-path pra hotfix + postmortem obrigatório
8. Smart re-run após reprovação
9. Diff-aware review
10. Escalation path em 3 níveis
11. Tiebreaker formal entre agentes em conflito
12. Pipeline post-mortem em pipeline miss
13. Histórico append-only auditável
14. Findings individuais com fingerprint estável
15. Lead time / MTTR mensurados
16. Versionamento de prompt dos agentes
17. Drift detection de categorias
18. Calibração via @analyst
19. Custo por execução rastreado
20. Visibility via labels dinâmicos
21. Audit trail inter-agente
22. Descobertas novas com priorização clara
23. Política de PR vs commit direto
24. Responsabilidades formais do operador
25. Onboarding checklist de novo agente
26. Pre-release definition formal
27. Schema v2 do `pipeline.jsonl`
28. Formato do comentário Trello atualizado com versão de agente, smart re-run, lead time
