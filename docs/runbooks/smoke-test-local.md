# Runbook — Smoke Test E2E local (Card 6.1)

**Objetivo:** validar manualmente o fluxo completo de ponta a ponta em ambiente local,
em **test mode** do Stripe, antes de qualquer deploy: pagamento → webhook → token →
JWT → processamento de planilha.

**Quando usar:** antes de um deploy de staging/prod, após mudanças em billing/webhook/auth/
process, ou quando precisar reproduzir o caminho de compra de ponta a ponta.

> ⚠️ Sempre em **test mode** (`STRIPE_SECRET_KEY=sk_test_...`). Nunca rode este runbook
> apontando para chaves live.

---

## Pré-requisitos

| Item | Como verificar |
|---|---|
| `.env` em test mode | `grep -E '^STRIPE_SECRET_KEY="?sk_test' .env` |
| Upstash Redis vivo | `/health/ready` retorna `redis: up` (free-tier some por inatividade — recriar e atualizar `UPSTASH_REDIS_REST_URL/TOKEN` no `.env` se NXDOMAIN) |
| Supabase ativo | `/health/ready` retorna `db: up` |
| Stripe CLI | `stripe version` (instalar: `winget install Stripe.StripeCli`) |
| Docker (só p/ integration) | `docker ps` |

> Nota Windows: após instalar o Stripe CLI via winget, o PATH só atualiza em terminais
> novos. O binário fica em
> `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Stripe.StripeCli_*\stripe.exe`.

---

## Passo 1 — Subir o back e validar dependências

```bash
npm run dev
# noutro terminal:
curl -s http://127.0.0.1:3333/health/live      # {"data":{"status":"ok"}}
curl -s http://127.0.0.1:3333/health/ready     # db: up, redis: up  (200)
curl -s http://127.0.0.1:3333/billing/prices   # 200 com as moedas
```

> O Fastify escuta em `127.0.0.1` — use isso, não `localhost` (pode resolver IPv6 `[::1]`
> e falhar com `HTTP 000`).

Se `/health/ready` ou `/billing/prices` derem `500 "fetch failed"`, leia o log do servidor:
`getaddrinfo ENOTFOUND <host>.upstash.io` = Redis morto (recriar database Upstash).

---

## Passo 2 — Webhook (validação de assinatura)

O `stripe listen` gera um **webhook secret efêmero** próprio, diferente do `.env`. Injete-o
no back via env inline (sem tocar no `.env`):

```bash
STRIPE="<caminho>/stripe.exe"   # ou apenas 'stripe' se no PATH
KEY=$(grep -E '^STRIPE_SECRET_KEY=' .env | sed -E 's/^STRIPE_SECRET_KEY=//; s/^"//; s/"$//')

# 1) listener (deixe rodando; copie o whsec_... que ele imprime)
"$STRIPE" listen --api-key "$KEY" --forward-to localhost:3333/webhooks/stripe

# 2) reinicie o back com o whsec efêmero
STRIPE_WEBHOOK_SECRET="whsec_<do_listen>" npm run dev

# 3) dispare um evento
"$STRIPE" trigger checkout.session.completed --api-key "$KEY"
```

**Esperado:** os eventos chegam com `[200]` no `stripe listen` → assinatura validada. O
`checkout.session.completed` do `stripe trigger` retorna **500** — isso é **esperado**: o
fixture sintético não traz `subscription`/`email`, então `handleCheckoutCompleted` rejeita
com `webhookFailed()`. Para exercitar a criação real de token, use um **checkout real**
(cartão `4242 4242 4242 4242`) via front local, ou o seed do Passo 3.

> A idempotência atômica (RECEIVED→PROCESSED) é validada pelos integration tests do
> Card #189 (`tests/integration/webhook.integration.test.ts`), não pelo `stripe trigger`.

---

## Passo 3 — Auth (token Pro → JWT)

Sem um checkout real, semeie um token Pro direto no banco (via MCP Supabase / SQL editor):

```sql
WITH u AS (
  INSERT INTO public.users (email, role, stripe_customer_id)
  VALUES ('smoke@tablix.dev', 'PRO', 'cus_smoke')
  RETURNING id
)
INSERT INTO public.tokens (token, user_id, stripe_subscription_id, plan, status)
SELECT '<token tbx_pro_...>', u.id, 'sub_smoke', 'PRO', 'ACTIVE' FROM u
RETURNING token, user_id;
```

> Gere um token válido com: `npx tsx -e "import {generateProToken} from './src/lib/token-generator'; console.log(generateProToken())"`

Valide o token → recebe JWT:

```bash
curl -s -X POST http://127.0.0.1:3333/auth/validate-token \
  -H "Content-Type: application/json" \
  -d '{"token":"<token>","fingerprint":"smoke-fp-0123456789abcdef"}'
# 200 → { accessToken (15m), refreshToken (30d), user: { role: PRO, status: ACTIVE } }
```

> O fingerprint é vinculado ao token no **primeiro uso**. Reuse o mesmo nas chamadas
> seguintes; um fingerprint diferente exige re-input (anti-compartilhamento).

---

## Passo 4 — Processamento (JWT → /process/sync)

```bash
printf 'nome,email,valor\nAlice,alice@x.com,100\nBob,bob@x.com,200\n' > /tmp/vendas1.csv
printf 'nome,email,valor\nCarol,carol@x.com,300\n' > /tmp/vendas2.csv

JWT="<accessToken do passo 3>"
curl -s -D - -o /tmp/merged.csv -X POST http://127.0.0.1:3333/process/sync \
  -H "Authorization: Bearer $JWT" \
  -F "files=@/tmp/vendas1.csv" \
  -F "files=@/tmp/vendas2.csv" \
  -F 'selectedColumns=["nome","email","valor"]' \
  -F "outputFormat=csv"
```

**Esperado:** `200` + binary do arquivo unificado + headers:
`X-Tablix-Rows: 3`, `X-Tablix-Columns: 3`, `X-Tablix-Format: csv`,
`Content-Disposition: attachment; filename="unified-<data>.csv"`. O `usage.unifications_count`
do user incrementa em 1 (enforcement de quota).

Contrato do multipart: campos `files` (1+ arquivos `.csv/.xlsx/.xls`), `selectedColumns`
(JSON array, máx 10 colunas no PRO), `outputFormat` (`csv`|`xlsx`). Limite: 2MB por arquivo,
30MB total, 75.000 linhas, 15 arquivos.

---

## Limpeza (sempre rodar no fim)

```sql
DELETE FROM public.usage    WHERE user_id = '<id>';
DELETE FROM public.sessions WHERE user_id = '<id>';
DELETE FROM public.tokens   WHERE user_id = '<id>';
DELETE FROM public.users    WHERE id      = '<id>';
DELETE FROM public.audit_log;          -- só em dev/pré-go-live
DELETE FROM public.stripe_events;      -- fixtures do stripe trigger
```

Encerre os processos: o `back` (`Stop-Process` na porta 3333) e o `stripe listen`
(`Stop-Process -Name stripe`).

---

## Achados e armadilhas conhecidas

- **Bug #189 (corrigido):** o smoke deste card descobriu que `stripe_events` era registrado
  ANTES de processar o handler → falha transitória deixava o cliente sem token no retry.
  Corrigido com idempotent receiver (RECEIVED→PROCESSED). Não regredir.
- **`stripe trigger` ≠ checkout real:** o fixture sintético não cria token. Use checkout
  real (`4242…`) ou o seed do Passo 3.
- **Dependências free-tier morrem por inatividade:** Upstash (NXDOMAIN) e Supabase (pausa).
  Reativar antes de rodar.
- **Erros novos viram cards** no Backlog com label `pipeline-discovery`.
