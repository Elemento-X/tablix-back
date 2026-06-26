# syntax=docker/dockerfile:1
#
# Card 7.1 — Imagem do backend Tablix (Fastify) — multi-stage, prod-only.
#
# UMA imagem serve aos DOIS process groups do Fly (web + worker): o `CMD` default
# sobe o servidor HTTP; o process group `worker` do fly.toml sobrescreve o comando
# (`node dist/src/worker.js`). Mesma imagem = mesma árvore de deps + mesmo engine
# Prisma nos dois processos (sem drift).
#
# Base: node:24-bookworm-slim (Debian/glibc), NÃO Alpine. Motivos:
#   - @sentry/profiling-node tem addon NATIVO com prebuild glibc; em Alpine/musl
#     viraria compile-from-source (python/make/g++ na imagem).
#   - Prisma 6: build e runtime na MESMA base/arch → o client gerado no builder é
#     byte-idêntico ao runtime, então é COPIADO (não regenerado), dispensando o
#     `prisma` CLI no runtime.
# Pin por DIGEST (não só tag): tag é mutável (pode ser repushada). Digest garante
# build hermético e fecha o vetor de supply chain da base (@devops/@security ALTO).
# Renovar o digest via Renovate/Dependabot com gate de teste.

# ============================================================
# Stage 1 — builder: TODAS as deps, gera Prisma Client, compila TS→JS
# ============================================================
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS builder

WORKDIR /app

# OpenSSL é exigido pelo `prisma generate` (detecção do engine de query).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Camada de deps cacheável: muda só quando package*.json muda.
# `npm ci` = install determinístico a partir do lockfile (não `npm install`).
# Cache mount do BuildKit acelera rebuild sem afetar determinismo (lockfile manda).
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Prisma Client (tipos consumidos pelo tsc + engine .so do runtime) — antes do
# código pra cachear. Output vai pra node_modules/.prisma/client.
COPY prisma ./prisma
RUN npx prisma generate

# Código-fonte + tsconfig. NÃO copiamos tests/ nem vitest.config.ts, então o
# `tsc` emite SOMENTE dist/src (sem dist/tests) — imagem enxuta de graça.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ============================================================
# Stage 2 — runtime: deps de produção + client Prisma copiado + dist/src
# ============================================================
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime

# NODE_ENV=production: liga o caminho estrito do env.ts (exige todos os secrets
# de prod) e desabilita devtools. PORT casa com o internal_port do fly.toml e com
# o default do env.ts (3333) — explícito pra evitar drift silencioso.
ENV NODE_ENV=production \
    PORT=3333

WORKDIR /app

# OpenSSL/ca-certificates: runtime do Prisma + TLS (rediss://, https Supabase/Stripe).
# dumb-init: PID 1 correto — encaminha SIGTERM/SIGINT pro Node (graceful shutdown
# dos dois processos depende disso) e reapeia zumbis.
# Versões dos pacotes apt NÃO são pinadas conscientemente: o digest da base já fixa
# o snapshot; pinar versão exata de pacote Debian quebra build quando o repo remove
# a versão antiga (trade-off documentado — @devops BAIXO).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Deps de PRODUÇÃO apenas. O `prisma` CLI (+ @prisma/engines + effect, ~180MB) é
# peer OPCIONAL do @prisma/client → excluído por --omit=dev. Prune defensivo de
# resíduos que sobrevivem como peer opcional (typescript) ou dedupe, garantindo a
# imagem enxuta independente da resolução do lockfile (@performance ALTO/MÉDIO).
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
  && rm -rf \
      node_modules/typescript \
      node_modules/.bin/tsc \
      node_modules/.bin/tsserver \
      node_modules/prisma \
      node_modules/@prisma/engines \
      node_modules/@prisma/config \
      node_modules/effect \
  && npm cache clean --force

# Prisma Client GERADO no builder (engine .so debian-openssl-3.0.x) — copiado em
# vez de regenerado (mesma base/arch → byte-idêntico), o que elimina a CLI do
# runtime. O @prisma/client (pacote, deps {}) já veio do npm ci acima.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Artefato compilado (inclui dist/src/lib/spreadsheet/parse-worker.thread.js —
# binding #2 da Fase 6: o worker_thread resolve este .js por __dirname em prod).
COPY --from=builder /app/dist/src ./dist/src

# Hardening: processo roda como usuário não-root `node` (uid 1000), já presente
# na imagem oficial. Sem shell de root no container em runtime.
USER node

EXPOSE 3333

# Sem HEALTHCHECK no Dockerfile de propósito: a MESMA imagem serve web (HTTP) e
# worker (sem porta) — um único HEALTHCHECK marcaria o worker como unhealthy. A
# liveness é orquestrada pelo fly.toml por process group (HTTP check no web;
# heartbeat de log no worker). Para `docker run` local, checar /health/live à mão.

# dumb-init como PID 1; o comando concreto vem do CMD (web) ou do process group
# `worker` do fly.toml.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/server.js"]
