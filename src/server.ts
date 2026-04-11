import { buildApp } from './app'
import { env } from './config/env'

async function start() {
  const app = await buildApp()

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`)
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
