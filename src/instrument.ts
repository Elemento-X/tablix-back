/**
 * Card 2.2 — Sentry instrumentation entrypoint.
 *
 * Este módulo é importado ANTES de qualquer outro em `server.ts` como
 * side-effect. Imports ESM são hoisted, então colocar `initSentry()` no
 * corpo de `server.ts` não garante ordem — a instrumentação OpenTelemetry
 * do Sentry precisa patchar `http`/`fastify` ANTES deles serem carregados.
 *
 * Padrão oficial recomendado pela documentação do Sentry v10 para Node.
 *
 * F6 (@security): logging explícito do estado do observability. Sem isto,
 * DSN inválido aceito pelo regex mas rejeitado pelo SDK cria blind-spot.
 * Usamos console.* aqui porque o logger pino ainda não foi instanciado
 * neste ponto (é pre-app).
 */
import { initSentry } from './config/sentry'

const _started = initSentry()

if (process.env.NODE_ENV === 'production' && !_started) {
  // Unreachable: env schema bloqueia no boot. Defense in depth.
  console.error(
    '[sentry] FATAL: produção sem SENTRY_DSN — env schema deveria ter bloqueado',
  )
  process.exit(1)
}

if (_started) {
  console.log(
    `[sentry] initialized env=${process.env.SENTRY_ENVIRONMENT ?? 'development'} release=${process.env.SENTRY_RELEASE ?? 'none'}`,
  )
} else {
  console.log('[sentry] skipped (no DSN — dev/test mode)')
}
