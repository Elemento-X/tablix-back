# [Nome do Projeto]

## Comandos

- Dev: `npm run dev`
- Build: `npm run lint && npm run build`
- Lint: `npx eslint .`
- Test (específico): `npm test -- --testPathPattern=<pattern>`
- Test coverage: `npm run test:coverage`

## Regras de código

- Todo texto visível ao usuário DEVE usar sistema de i18n (se aplicável)
- Validação de input externo via Zod ou equivalente
- Componentes: máximo 500 linhas
- Conventional commits: feat:, fix:, chore:, refactor:, test:, docs:
- Não commitar sem instrução explícita do usuário
- Não criar arquivos novos sem necessidade comprovada
- Não refatorar código fora do escopo solicitado

## Segurança (inegociável)

- Toda entrada de usuário DEVE ser validada e sanitizada
- Toda validação client-side é UX, não segurança — o server é a única barreira real
- Rate limiting em toda API route
- Nunca logar dados sensíveis
- Nunca expor stack traces ao cliente
- Avaliar OWASP Top 10 em toda mudança
- Cookies sensíveis: httpOnly, Secure, SameSite=Strict

## Arquitetura

### Multi-currency billing (política fechada — 2026-04-20)

- Moeda da cobrança é decidida **server-side** pelo backend, nunca pelo cliente
- Regra de negócio: `.env.example` declara "psychological pricing por mercado, sem conversão automática" — cada país tem price ID próprio no Stripe (BRL/USD/EUR)
- Fonte da verdade do país do usuário: header `CF-IPCountry` injetado pela Cloudflare na frente do Fly.io (dependência de infra — Fase 8)
- Schema do `/billing/create-checkout` continua aceitando `currency` no body por compatibilidade, mas o handler IGNORA o valor do cliente e resolve via `CF-IPCountry` → `PRICE_MAP`
- Implementação completa adiada para Card 8.7 (ex-1.20) na Fase 8 — Infra & Deploy, junto com a configuração da Cloudflare
- Até lá: `PRICE_MAP` existe no código mas só `BRL` tem price ID configurado em produção; `env.ts` via `superRefine` só exige `USD`/`EUR` quando `NODE_ENV=production`
- Finding F-HIGH-01 (price arbitrage) coberto pelo waiver `WV-2026-004` (expira 2026-05-15) — risco real = zero em ambiente controlado pré-go-live
- Atalhos rejeitados conscientemente: `geoip-lite` (base desatualizada, VPN-bypass trivial), detecção via `Accept-Language` (não é sinal de país)
- Cap global anti denial-of-wallet em `/billing/create-checkout` (30 req/min agregado) implementado em 2026-04-20 via `createGlobalCapMiddleware` — defesa em profundidade sobre o limiter per-IP (5/min) que sozinho permitia `N IPs × 5 = N×5` chamadas Stripe pagas/minuto

## Proibições

- NÃO usar `any` em TypeScript
- NÃO adicionar dependências sem discutir justificativa
- NÃO gerar documentação sem instrução explícita
- NÃO fazer push sem instrução explícita
- NÃO ignorar erros de lint ou TypeScript
- NÃO rodar a suíte de testes inteira — sempre segmentado

## Pipeline QA (obrigatorio)

Toda entrega de codigo passa pelo pipeline completo, sem excecao:

### Pipeline core (sempre)
```
(@tester + @security) em paralelo → @reviewer → Trello
```

- **@tester** escreve testes, valida coverage, edge cases (CI rodara automaticamente no futuro)
- **@security** audita seguranca: OWASP, injection, headers, rate limit
- **@reviewer** faz code review direto no codigo, recebe achados de todos como contexto, emite veredito final

### Pipeline estendido (por tipo de card)
```
Card de schema/migration:  core + @dba
Card de API/contrato:      core + @dba (se toca DB) + @reviewer aplica rule api-contract
Card de infra/deploy:      core + @devops + @performance
Card de webhook/integracao: core + @dba + @devops
Pre-release backend:       core + @dba + @devops + @performance
Card de UI:                core + @design-qa + @copywriter
Card de landing:           core + @seo + @copywriter + @performance
```

- **@dba** audita schema, indices, migrations (expand-contract), locks, MVCC, RLS, performance de query, connection pooling — acionado em cards que tocam Prisma schema, migrations ou queries hot
- **@devops** audita Docker, deploy (Fly.io), CI/CD, SLO, observabilidade, supply chain, secrets, IaC — acionado em cards de infra, Dockerfile, .env.example novo, workflows, deploy
- **@design-qa** valida fidelidade ao spec do @designer (UI)
- **@performance** audita bundle, runtime, Core Web Vitals (deps, features pesadas, pre-release)
- **@seo** audita meta tags, structured data, semantic HTML (paginas publicas)
- **@copywriter** audita copy, microcopy, tom de voz, qualidade multilingue (texto novo)

### Agentes de suporte (sob demanda)
- **@planner** — planejamento e estruturacao de cards
- **@analyst** — metricas do pipeline e saude do time (fim de fase, sob demanda, pre-release)
- **@designer** — specs visuais e UX
- **@docs** — sincronia documentacao/codigo
- **@refactor** — refatoracao cirurgica em worktree isolada

### Regras do pipeline
- 1 comentario consolidado por card por execucao (VALIDACAO, AUDITORIA, REVISAO + agentes estendidos)
- Reprovacao de QUALQUER agente reinicia o ciclo completo apos correcao
- Correcoes vao no card existente; descobertas novas viram card novo
- Historico de reprovacoes no Trello e sagrado — nunca apagar, nunca pular
- Toda execucao gera entrada em `.claude/metrics/pipeline.jsonl` (schema e categorias em `.claude/metrics/`)

Regra detalhada em `.claude/rules/qa-pipeline.md`

### Rules contextuais (carregadas por path)

- `.claude/rules/api-routes.md` — convencoes Fastify, schemas Zod, error handling, webhooks Stripe
- `.claude/rules/api-contract.md` — disciplina de contrato (versionamento, breaking change, idempotency, ETag, LRO, webhooks outbound, precisao numerica) — auditado por @reviewer e @security
- `.claude/rules/security.md` — regras de seguranca aplicadas a todo codigo
- `.claude/rules/qa-pipeline.md` — fluxo completo do pipeline QA

## Documentação e qualidade

- Toda feature nova precisa de testes (mínimo 90% coverage)
- Se documentação contradiz código: PARAR e perguntar qual está correto
