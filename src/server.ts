// Card 2.2 — Sentry DEVE ser inicializado antes de qualquer outro import.
// `./instrument` é side-effect-only: importa e chama initSentry() no top-level
// ANTES de `./app` carregar `fastify`/`http`. Imports ESM são hoisted, então
// só garantimos ordem se a instrumentação está num módulo separado importado
// primeiro. Padrão oficial do Sentry v10 para Node.
import './instrument'
import { buildApp } from './app'
import { env } from './config/env'
import { setShutdownRequested } from './lib/health'

async function start() {
  const app = await buildApp()

  // Graceful shutdown — Card 2.3: sinaliza readiness degraded ANTES de
  // fechar, para que o proxy/orquestrador pare de rotear tráfego novo.
  // Delay de 2s dá tempo para o próximo probe detectar o 503 e remover
  // a instância do pool antes de drenarmos conexões existentes.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`)
      setShutdownRequested(true)
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await app.close()
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
