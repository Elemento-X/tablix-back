# Runbook — Signed URL Sobrevive a DELETE (R-9, Card #145 5.2a)

Documentação do risco R-9 do plano @planner v2.2 (Card #145) — **gap conhecido** de janela de exposição em signed URLs do Supabase Storage após DELETE de file_history.

> **Severity**: R-9 foi **elevado de BAIXO para ALTO** pelo @security em 2026-05-02 (rodada de decisões #145). Mitigação imediata em F5 + card descoberta `signed-url-revoke-on-delete` (#158) na Backlog ALTA.

---

## O risco

### Sequência do problema

```
T+0    Usuário GET /user/history/:id
       → Backend gera signed URL com TTL=300s (Supabase default)
       → Cliente recebe URL no JSON, baixa o arquivo localmente

T+30s  Usuário DELETE /user/history/:id (decide remover do histórico)
       → Backend executa two-phase delete LGPD:
         (a) audit_log_legal(purge_pending) + UPDATE deleted_at = now()
         (b) Storage.remove(storagePath) — request HTTP ao Supabase

T+30s a T+300s  **JANELA DE EXPOSIÇÃO**
       → Signed URL emitida no T+0 ainda é VÁLIDA (TTL=300s).
       → Atacante (ou própria URL vazada em log/cache/CDN) pode
         baixar o arquivo MESMO APÓS o usuário ter pedido remoção.

T+300s URL expira pelo TTL. Storage delete já completou.
       Não há mais como acessar o arquivo.
```

### Por que isso é ALTO (não BAIXO)

- **LGPD Art. 18 (direito à eliminação)**: usuário pediu remoção; sistema confirma 200 OK; mas dado continua acessível por até 5min via URL pré-gerada.
- **Threat model**: URL vaza em screenshot, log de erro do browser, scraper de bookmark, CDN cache, history do iCloud, share via WhatsApp.
- **Auditoria forense**: `audit_log_legal` registra o DELETE no T+30s; download via URL pré-gerada NÃO aparece nos logs do Tablix (vem direto do Supabase Storage). Gap no audit trail.

---

## Mitigação atual (em vigor — Card #145 F5)

### M1 — TTL reduzido de signed URL (IMPLEMENTADO)

Caller override no controller força TTL de 60s (vs 300s default do adapter,
vs 3600s cap):

```ts
// src/http/controllers/history.controller.ts
const SIGNED_URL_TTL_SECONDS = 60

const { url, expiresAt } = await adapter.getSignedUrlForUser({
  userId: request.user.userId,
  jobId,
  ext,
  expiresInSeconds: SIGNED_URL_TTL_SECONDS,  // override do default 300s
})
```

```ts
// src/lib/storage/supabase.adapter.ts (referência — NÃO mudar default sem
// auditar todos callers; controller que cuida do TTL operacional)
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300  // não-aplicado: caller override
const MAX_SIGNED_URL_TTL_SECONDS = 3600     // hard cap rejeitando > 1h
```

**Efeito**: reduz janela de exposição de 5min pra 1min. NÃO elimina o gap — apenas comprime.

### M2 — Header `Cache-Control: no-store` em GET /user/history/:id

Response do backend NUNCA é cacheável. Reduz chance de CDN/proxy cachear URL.

```ts
reply.header('Cache-Control', 'no-store')
reply.header('Pragma', 'no-cache')  // legacy proxies
```

### M3 — Log estruturado de geração de URL (IMPLEMENTADO em F5 fix-pack)

`getOneHistoryHandler` (controller) emite evento `storage.signed_url.created`
após sucesso do `getSignedUrlForUser`. Permite forense pós-incidente.

```ts
// src/http/controllers/history.controller.ts (após createSignedUrl)
logger.info(
  {
    userId: request.user.userId,
    pathHash: hashStoragePathForAudit(row.storagePath),  // SHA-256, NUNCA path cru
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
    jobId,
  },
  'storage.signed_url.created',
)
```

**Forense LGPD**: cruzar `storage.signed_url.created.pathHash` (logs pino via `fly logs`)
com `audit_log_legal` (`purge_pending` event_type, mesmo `resource_id` hashable)
permite identificar todo usuário cujo signed URL foi emitido no intervalo
suspeito antes do DELETE.

### M4 — Documentação ao usuário

Privacy policy explícita: "links de download têm validade de 60 segundos; após esse prazo, novo link deve ser solicitado".

---

## Mitigação completa (futuro — Card #158 ALTA)

Card descoberta `signed-url-revoke-on-delete` na Backlog, prioridade ALTA. Plano:

### Opção A — Rotação de bucket key

```
1. Manter 2 buckets ativos (file_history_active, file_history_pending).
2. Migrar arquivos novos pro pending diariamente.
3. Após N dias, rotacionar key do active (invalida todas signed URLs).
4. file_history_pending vira active, ciclo recomeça.
```

**Trade-off**: complexidade operacional + custo extra. Plausível pra Pro com retenção 30d.

### Opção B — Supabase Admin API (revoke explícito)

Verificar se Supabase Storage v2 expõe endpoint admin pra invalidar URLs ativas. Última checagem: NÃO existe (documentação 2026-04). Acompanhar changelog.

### Opção C — Proxy próprio com auth

Backend gera URL apontando pra `https://api.tablix.com.br/storage/proxy/:opaqueToken`. Token é validado contra `file_history.deleted_at IS NULL` em CADA download. DELETE invalida automaticamente.

**Trade-off**: latência extra (proxy hop) + custo de banda. Decisão de produto.

---

## Detecção (foi explorado?)

### Sinais de exploração

- Audit log mostra DELETE de file_history seguido de download bem-sucedido via Supabase logs.
- Supabase Storage logs mostram download de URL com TTL pré-DELETE.
- Reclamação de usuário: "deletei arquivo e ainda consigo abrir o link salvo no histórico do browser".

### Verificação periódica

```sql
-- File histories com DELETE recente — janela suspeita
SELECT
  fh.id,
  fh.user_id,
  fh.deleted_at,
  fh.storage_path
FROM file_history fh
WHERE fh.deleted_at > now() - interval '1 hour'
  AND fh.deleted_at IS NOT NULL;
```

Cross-referenciar com Supabase Storage download logs (Supabase Dashboard → Logs → Storage). Download após `deleted_at` é sinal de exploração da janela.

---

## Comunicação ao usuário

### Em caso de exploração detectada

Email obrigatório (LGPD Art. 48):
- Identificar usuário afetado.
- Descrever a janela de exposição factual (sem minimizar).
- Apresentar mitigações em vigor e roadmap (Card #158).
- Oferecer canal de contato com DPO.

### Pré-incidente (pró-ativo)

Privacy policy + FAQ atualizadas no `tablix-front`. Frase chave (em revisão pelo @copywriter):

> "Quando você solicita a remoção de um arquivo do histórico, removemos imediatamente do nosso sistema. Links de download gerados nos últimos 60 segundos podem permanecer válidos até a expiração natural — recomendamos não compartilhar esses links."

---

## Action items contínuos

- [ ] Acompanhar changelog Supabase Storage trimestralmente — Admin API de revoke é mudança que destrava Opção B.
- [ ] Card #158 (`signed-url-revoke-on-delete`) revisado após cada incidente relacionado.
- [ ] Audit log de `storage.signed_url.created` consumido por @analyst no relatório de saúde do time.
- [ ] Em caso de exploração: postmortem público (LGPD Art. 48) + escalation pro operador principal.

---

## Referências

- Card #145 (5.2a) plano @planner v2.2 — Risk Register R-9 elevado a ALTO.
- Card #158 (`signed-url-revoke-on-delete`, shortLink `GkuIjKXF`) — mitigação completa pendente.
- LGPD Art. 18 (direito à eliminação), Art. 46 (segurança), Art. 48 (comunicação ao titular).
- Supabase Storage docs — `createSignedUrl` API.
- Card 5.1 (`2ce90f2`) — `StorageAdapter` Supabase user-scoped.
- Card 2.2 — Sentry integration (consumo dos eventos `storage.signed_url.*`).
