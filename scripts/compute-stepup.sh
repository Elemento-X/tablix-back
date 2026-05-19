#!/usr/bin/env bash
#
# Stub — Card #145 (5.2a) F5 fix-pack — Card #159 (Backlog ALTO) tracks
# full implementation.
#
# Quando implementado, este script deve computar o header X-Admin-Confirm
# para POST /admin/jobs/run/:name conforme protocolo step-up reauth do
# Card #145 D#3 + F4 fix-pack (admin.middleware.ts):
#
#   Formato:  <ts-ms>.<nonce-uuid-v4>.<hmac-sha256-hex>
#   HMAC =    HMAC-SHA256(ADMIN_STEPUP_SECRET,
#               userId:METHOD:path:ts:nonce:sha256(body))
#
# Argumentos esperados (quando implementado):
#   $1 = METHOD (GET|POST)
#   $2 = path (ex: /admin/jobs/run/history-purge)
#   $3 = userId (UUID v4)
#   $4 = body (string vazia pra GET; JSON canonical pra POST)
#
# Env vars exigidas:
#   ADMIN_STEPUP_SECRET (lido via `fly secrets list` ou .env local)
#
# Implementação ref: src/scheduler/admin.middleware.ts:computeExpectedHmac
# (já testado em tests/unit/scheduler/admin.middleware.test.ts).

echo "ERRO: scripts/compute-stepup.sh ainda não implementado." >&2
echo "Card #159 (Backlog) rastreia. Por ora, computar X-Admin-Confirm" >&2
echo "manualmente via REPL Node — ver admin.middleware.ts função" >&2
echo "computeStepUpHmacForTesting (helper exportado pra teste, pode ser" >&2
echo "usado em sessão Node ad-hoc com ADMIN_STEPUP_SECRET no env)." >&2
exit 1
