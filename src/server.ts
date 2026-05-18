// Card 2.2 — Sentry DEVE ser inicializado antes de qualquer outro import.
// `./instrument` é side-effect-only: importa e chama initSentry() no top-level
// ANTES de `./app` carregar `fastify`/`http`. Imports ESM são hoisted, então
// só garantimos ordem se a instrumentação está num módulo separado importado
// primeiro. Padrão oficial do Sentry v10 para Node.
import './instrument'
import { buildApp } from './app'
import { captureException } from './config/sentry'
import { env } from './config/env'
import { setShutdownRequested } from './lib/health'
import { shutdownScheduler } from './scheduler/cron'
import { bootstrapCronJobs } from './scheduler/jobs.bootstrap'

async function start() {
  const app = await buildApp()

  // Card #146 F4 — registra cron jobs (history-purge + cron-runs-cleanup +
  // dead-letter-reprocess) ANTES de app.listen. Em NODE_ENV=test,
  // registerCronJob é no-op (R-5 do plano #145 F4 — cron NÃO dispara em
  // test runs).
  //
  // Card #146 fix-pack ciclo 1 (@devops MÉDIO + @security MÉDIO): wrap em
  // try/catch DEGRADED MODE. Exception em bootstrap (env corrompido,
  // import quebrado por refactor futuro) NÃO deve crashar app inteiro —
  // crons offline é degradação aceitável (LGPD purge acumula mas
  // gauge/Sentry alertam); app HTTP offline é catástrofe (auth, billing,
  // signed URLs param). Alerta Sentry CRITICAL pra forçar investigação.
  try {
    bootstrapCronJobs()
  } catch (err) {
    app.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'scheduler.bootstrap.failed.degraded_mode',
    )
    captureException(err, { route: '/scheduler/bootstrap' })
    // NÃO process.exit — app HTTP segue. Operador investiga via Sentry +
    // GET /admin/jobs/list (lista vazia confirma cron offline).
  }

  // Graceful shutdown — Card 2.3 + Card #145 F4 fix-pack @devops:
  // ordem corrigida pra padrão Kubernetes/Fly.io.
  //
  // 1. setShutdownRequested(true) — /health/ready vira 503
  // 2. Sleep SHUTDOWN_DRAIN_MS (default 15s, configurável) — orquestrador
  //    Fly.io HC interval ~10-15s; 2s anterior era subdimensionado.
  // 3. app.close() — drena HTTP in-flight (não aceita novos)
  // 4. shutdownScheduler(30s) — para schedules + espera batch + libera
  //    locks distribuídos (Redis client ainda vivo nessa fase)
  // 5. exit 0
  //
  // Justificativa da ordem: HTTP precisa parar de aceitar requests novos
  // ANTES do scheduler shutdown (request poderia disparar runJobOnce via
  // admin endpoint mid-shutdown). Scheduler depois drena batch + libera
  // locks em paralelo ao Redis client ainda conectado.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`)
      setShutdownRequested(true)
      await new Promise((resolve) => setTimeout(resolve, env.SHUTDOWN_DRAIN_MS))
      await app.close()
      await shutdownScheduler(30_000)
      process.exit(0)
    })
  }

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' })
    app.log.info(`Server running on http://localhost:${env.PORT}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
