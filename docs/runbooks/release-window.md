# Runbook — Release Window

Padrão formal para abrir/fechar janelas de mudança em produção. Vale para migrations, deploys de infra (Fase 8+), e qualquer operação que não seja idempotente.

> **Por que existir mesmo pré-go-live:** institucionalizar hábito antes de ter usuários custa zero e elimina classe inteira de incidentes. "Tráfego baixo" não é desculpa para informalidade.

---

## Tipos de janela

| Tipo | Quando | Duração típica | Quem aprova |
|---|---|---|---|
| **Standard** | Migration de schema, deploy idempotente | < 30 min | @reviewer |
| **Long-running** | Migration com rewrite pesado, restauração de backup | 30 min – 4h | @reviewer + usuário |
| **Emergency / hotfix** | Incidente em produção (Fase 8+) | < 1h | usuário |

---

## Ciclo da janela

### 1. Abertura (T-15min)

Card no Trello com:

- Coluna: `Validation`
- Label: `change-window-open` + tipo (`change-window-standard|long|emergency`)
- Label dinâmico: `pipeline:devops-running` (se for deploy/migration)

Comentário formal:

```
RELEASE WINDOW OPEN at <ISO timestamp>
Type: standard | long-running | emergency
Migrations/deploys: <lista>
Owner: <handle>
Co-owner: <handle ou "none">
Estimated duration: <X> min
Rollback contact: <handle>
Pre-flight checklist:
  [x] Backup verificado (link/checksum)
  [x] Schema Prisma em branch dedicada
  [x] Suíte verde local
  [x] Baseline EXPLAIN arquivado
  [x] Webhook Stripe desabilitado (se aplicável)
  [x] Conexões drenadas
```

### 2. Acordo

Durante a janela:

- **Ninguém** roda `npm run dev`, scripts ou commits no banco compartilhado.
- **Ninguém** mergeia PRs que alteram schema.
- Operador secundário avisado (ou "solo" anotado).
- Aba paralela monitorando `pg_locks` ativa (ver `database-migration.md`).

### 3. Execução

Cada passo significativo gera um comentário no card:

```
[T+0:00] Migration A applied — duration 1.2s, smoke OK
[T+0:05] Migration B applied — duration 3.4s, smoke OK
[T+0:08] Migration C applied — duration 0.8s, smoke OK
```

### 4. Fechamento

Comentário formal:

```
RELEASE WINDOW CLOSED at <ISO timestamp>
Outcome: success | partial | rollback
Lead time: <duração>
Smoke results: <link>
Sentry: clean | <link issues>
Schema Prisma committed: <commit SHA>
Fixture regenerated: <commit SHA>
Postmortem required: yes | no
```

Remover labels: `change-window-open`, `pipeline:*-running`.
Adicionar label: `pipeline:approved` (se outcome=success).

### 5. T+24h follow-up

Comentário breve confirmando:
- Sentry sem regressão.
- VACUUM ANALYZE rodado.
- EXPLAIN das queries críticas vs baseline arquivado.

---

## Janela emergency (Fase 8+, fora do escopo atual)

Hotfix em produção tem fast-path documentado em `.claude/rules/qa-pipeline.md`. A janela emergency segue:

1. Abertura simplificada (1 comentário, sem checklist longo).
2. Execução com pipeline core obrigatório (@tester + @security + @reviewer).
3. Postmortem em 48h obrigatório.
4. Card marcado com `hotfix-fast-path` + waiver auto-expirado em 7 dias para os gates skipados.

---

## Quem pode abrir janela

| Quem | Tipo de janela autorizado |
|---|---|
| Operador principal (Claude) | standard, com aval do usuário |
| Usuário | qualquer |
| @devops (subagent) | recomenda, não abre — formaliza no card mas operador executa |
