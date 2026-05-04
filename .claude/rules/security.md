---
paths:
  - "src/middleware/**/*.ts"
  - "src/lib/jwt.ts"
  - "src/lib/token-generator.ts"
  - "src/modules/auth/**/*.ts"
  - "src/modules/billing/**/*.ts"
  - "src/config/env.ts"
  - "src/config/rate-limit.ts"
  - "src/errors/**/*.ts"
  - "src/http/routes/**/*.ts"
  - "src/plugins/**/*.ts"
---

# Security (backend é a única barreira real)

## Referência cruzada

- **`api-routes.md`** — estrutura de rotas Fastify, timeouts, health check, graceful degradation.
- **`api-contract.md`** — disciplina de contrato: envelope, versionamento, breaking changes, idempotency, ETag, paginação, bulk ops, webhooks outbound, SDK.
- **`qa-pipeline.md`** — path-matrix que determina quais rules e agentes carregam por arquivo tocado.

## Princípio

- Toda validação do frontend é UX. O server é a única barreira real. Replique TODAS as validações aqui, mesmo as triviais.
- Em dúvida de decisão de segurança, errar para o lado mais restritivo.
- Qualquer alteração em `middleware/`, `lib/jwt.ts`, `lib/token-generator.ts` ou em handlers de webhook exige auditoria manual do @security antes de merge.

## Autenticação (JWT + Token)

- **Deny-by-default**: auth middleware DEVE ser global (registrado no app). Rotas públicas são exceção explícita via allowlist (`skipAuth: true` ou equivalente). Toda rota nova nasce autenticada — nunca o contrário.
- **CSRF**: API com Bearer token no header é naturalmente CSRF-safe (browser não envia Authorization header em requests cross-origin). Se migrar para cookie-based auth, CSRF token é OBRIGATÓRIO (double-submit cookie ou synchronizer token).
- **Token Pro** (`tbx_pro_*`): mínimo 256 bits de entropia via `crypto.randomBytes` em `token-generator.ts`. Nunca usar `Math.random`, nunca reduzir o tamanho.
- **Comparação timing-safe obrigatória**: toda comparação de token/secret DEVE usar `crypto.timingSafeEqual` (com buffers de mesmo tamanho). Nunca `===` para segredos — side-channel timing attack permite brute force caractere a caractere.
- **JWT**: assinatura HS256 com `JWT_SECRET` (mínimo 32 chars, validado em `env.ts`). Nunca aceitar algoritmo `none`. Sempre verificar `exp`.
- **Vinculação fingerprint → token**: primeira validação vincula; trocas exigem re-input do token. Nunca permitir rebind silencioso.
- **Refresh**: só aceitar JWT expirado dentro de janela razoável; nunca renovar token sem validar subscription ativa no Stripe/DB.
- **Logout**: stateless hoje. Se adicionarmos revogação, usar Upstash Redis como denylist por `jti`.

## Secrets rotation

- `JWT_SECRET`, `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL` credentials, e qualquer API key devem ter política de rotação definida.
- **JWT_SECRET**: rotação exige período de dual-key (aceitar assinatura com key antiga por N horas para tokens em trânsito). Nunca trocar atomicamente sem grace period.
- **STRIPE_WEBHOOK_SECRET**: Stripe suporta múltiplos endpoints — rotação via criar novo endpoint → migrar → deletar antigo.
- **Regra prática**: se um secret vazar (log, commit, chat), rotação IMEDIATA é obrigatória. Não "depois".
- Toda rotação deve ser documentada em `.env.example` com comentário de quando e por que rotacionar.

## Validação de input (OWASP A03 — Injection)

- **Zod obrigatório** em todo input externo (body, params, query, headers relevantes, campos de multipart). Nunca `.passthrough()`, nunca `z.any()`.
- **Prisma** elimina SQL injection quando usado via query builder — NUNCA usar `$queryRawUnsafe` com input do usuário. Se precisar raw, usar `$queryRaw` (template tag).
- **Path traversal**: nomes de arquivo vindos do multipart devem ser sanitizados antes de qualquer operação de filesystem ou storage key. Nunca concatenar direto em path.
- **Prototype pollution**: não usar `Object.assign` nem spread em JSON externo sem passar por Zod antes.

## Multitenancy e ownership isolation (OWASP A01 — Broken Access Control)

- **Regra absoluta**: toda query que retorna dados de um tenant DEVE filtrar por `userId` / `organizationId` / ownership equivalente. Nunca confiar em ID vindo do client sem validar ownership.
- **Pattern obrigatório**: services recebem `userId` do JWT (extraído no middleware), não do body/params. Body/params informam o recurso; JWT informa quem está pedindo.
- **IDOR prevention**: antes de update/delete, SEMPRE verificar que o recurso pertence ao usuário autenticado. Nunca assumir "se tem o ID, pode acessar".
- **Testes de ownership**: todo endpoint que acessa recurso de usuário deve ter teste explícito de "usuário A não acessa recurso do usuário B".

## Request size limits

- **`bodyLimit` do Fastify**: configurar limite global razoável (ex: 1MB) e override por rota quando necessário (upload pode ser maior).
- Rotas de upload: limite explícito alinhado com `PRO_LIMITS` do plano. Nunca aceitar upload sem limite.
- Rotas de API (JSON): `bodyLimit` de 256KB é suficiente para 99% dos casos. Payload maior que isso é smell de design.
- **Query string**: limitar tamanho via Fastify `querystringParser` ou validação Zod com `.max()` em campos string.

## Parsing de planilhas (específico do domínio)

- `papaparse` e `xlsx` já têm histórico de CVEs — manter atualizados e monitorar. Validar MIME + extensão + tamanho ANTES de entregar ao parser.
- **Magic bytes validation**: não confiar apenas em extensão/MIME (spoofável). Validar assinatura de arquivo (magic bytes) para CSV (sem BOM ou UTF-8 BOM) e XLSX (PK zip header `50 4B 03 04`).
- Limites de tamanho, linhas e colunas (`PRO_LIMITS`) são barreira anti-DoS. Nunca remover, nunca afrouxar sem aprovação.
- Zip bomb: arquivos XLSX são zip. `xlsx` não oferece proteção nativa — validar tamanho descompactado antes de expor ao parser se limite for elevado no futuro.
- **Storage**: arquivos uploadados vão para bucket isolado (S3/R2), nunca filesystem local do servidor. URLs de acesso devem ser signed com TTL curto (15min max).

## Error handling defensivo (information disclosure)

- **Nunca vazar estado interno via mensagem de erro.** Respostas de erro devem ser genéricas pro cliente.
- **Error discrimination proibida**: não diferenciar "email não encontrado" vs "senha incorreta" vs "conta desativada" — resposta única: "Credenciais inválidas".
- **Token errors**: não diferenciar "token inválido" vs "token expirado" vs "token não encontrado" para o cliente. Internamente pode logar o motivo (sem o token).
- **Rate limit hit**: retornar 429 sem informar quantas tentativas restam (evita oracle de timing).
- Nunca expor stack trace ao cliente. Error handler global em `app.ts` cuida disso — não criar handlers paralelos.
- **Prisma errors**: capturar `PrismaClientKnownRequestError` e mapear para HTTP status sem expor código interno (P2002 → 409, P2025 → 404, resto → 500).

## Headers e CORS

- `@fastify/helmet` ativo com CSP em produção. Qualquer relaxamento exige justificativa documentada.
- CORS com origin **fixo** em `FRONTEND_URL`. Nunca usar `origin: true` nem wildcard.
- **`Access-Control-Max-Age`**: configurar cache de preflight (ex: 86400s / 24h) para evitar preflight flood em cada request.
- Respostas devem incluir `X-Content-Type-Options: nosniff` (helmet já aplica).

## Rate limiting

- **Camadas de rate limit**: (1) global por IP (proteção DDoS básica), (2) por rota (config específica em `src/config/rate-limit.ts`), (3) por usuário autenticado (evita abuso com conta válida). As três camadas são complementares.
- Toda rota pública passa por `rateLimitMiddleware` com limiter específico de `src/config/rate-limit.ts`.
- `/auth/validate-token` com limite agressivo (5/min) contra brute force.
- **Webhooks Stripe**: sem rate limit uniforme (Stripe legítimo pode burstar eventos), mas com **circuit breaker por IP em falhas de assinatura** em `src/lib/security/webhook-circuit-breaker.ts`. Stripe real nunca dispara signature failure — atacante forjando assinatura atinge o limite (5 falhas/60s) e é banido (15min/429). Barreira necessária pós-Card 2.4: auditoria forense + Sentry breadcrumb + pino log por request amplificam DoS se deixados sem proteção.

## Content-Type enforcement

- **Validar `Content-Type` em toda rota que aceita body.** Fastify valida JSON por default, mas rotas com custom parsers (multipart, raw) devem rejeitar content-types inesperados explicitamente.
- Nunca aceitar `application/x-www-form-urlencoded` em rota que espera JSON — pode ser vetor de CSRF em cenários edge.
- Rotas de upload: aceitar apenas MIME types esperados (`multipart/form-data` com tipos de arquivo específicos). Rejeitar o resto com 415 Unsupported Media Type.

## Webhook Stripe

- **Verificação de assinatura obrigatória** via `constructWebhookEvent`. Nunca confiar em header puro.
- **Idempotência**: mesmo `event.id` pode chegar múltiplas vezes. Manter tabela/cache de eventos processados ou usar upsert defensivo.
- **Replay window**: rejeitar eventos com `created` timestamp > 5 minutos do clock do servidor (Stripe recomenda). Protege contra replay de evento legítimo capturado.
- **Raw body**: já configurado no `app.ts`. Nunca adicionar parser JSON antes desta rota.

## Logs e dados sensíveis

- NUNCA logar: tokens Pro, JWT completo, `Authorization` header, body de `/auth/*`, body de `/webhooks/stripe`, emails em massa, senha/secret do banco.
- Em desenvolvimento pode logar payload sanitizado (sem campos sensíveis). Em produção, apenas metadata (request id, rota, status, latência).
- Nunca expor stack trace ao cliente. Error handler global em `app.ts` cuida disso — não criar handlers paralelos.

## Cookies e sessão

- Se adicionarmos cookies no futuro: `httpOnly`, `Secure` (prod), `SameSite=Strict`. Nunca armazenar JWT em cookie sem essas flags.

## Env vars

- Toda env var validada no boot via Zod em `src/config/env.ts`. Novo segredo = nova entrada no schema + `.env.example`.
- `.env` NUNCA commitado. `.env.example` sem valores reais.

## Supply chain e dependências (OWASP A06 — Vulnerable Components)

- **`npm audit`** deve rodar em todo CI e antes de todo deploy. Vulnerabilidade `high` ou `critical` bloqueia deploy.
- **Lockfile integrity**: `package-lock.json` deve ser commitado e respeitado (`npm ci`, não `npm install` em CI).
- **Dependabot / Renovate**: manter habilitado. PRs de security patch são prioridade — não acumular.
- **Deps novas**: toda dependência nova exige justificativa (por que não resolver sem dep? qual o tamanho do supply chain que estamos importando?). Preferir deps com poucos transitive deps.
- **Monitoramento contínuo**: verificar advisories de `papaparse`, `xlsx`, `jsonwebtoken`, `stripe`, `@fastify/*` — são as deps mais críticas do projeto.

## Análise estática de segurança

- **ESLint security plugins**: `eslint-plugin-security` deve estar configurado. Regras como `detect-non-literal-fs-filename`, `detect-non-literal-require`, `detect-unsafe-regex` pegam bugs antes do runtime.
- **Semgrep** (ou equivalente): considerar para regras customizadas do projeto (ex: "nunca usar $queryRawUnsafe", "nunca comparar token com ===").
- Findings de análise estática são tratados como findings de @security no pipeline.

## OWASP Top 10 — checklist de revisão

- [ ] A01 Broken Access Control → auth + ownership check no service + IDOR tests
- [ ] A02 Cryptographic Failures → JWT HS256, token 256 bits, TLS em prod, timingSafeEqual
- [ ] A03 Injection → Zod + Prisma, nunca raw SQL com input
- [ ] A04 Insecure Design → rate limit + limites de plano como barreira + error discrimination
- [ ] A05 Security Misconfiguration → helmet + CORS fixo + env validado + bodyLimit
- [ ] A06 Vulnerable Components → npm audit, lockfile, dependabot, supply chain review
- [ ] A07 Identification/Auth Failures → rate limit no validate-token, JWT curto, secrets rotation
- [ ] A08 Software/Data Integrity → webhook signature + replay window, Prisma schema único
- [ ] A09 Logging/Monitoring → sem dados sensíveis em log
- [ ] A10 SSRF → axios só para domínios conhecidos (Stripe/Resend); validar qualquer URL vinda de input
