/**
 * Entrypoint do PROCESSO worker assíncrono (Card 6.4).
 *
 * Processo SEPARADO do HTTP (decisão D-2): isola OOM/crash do parse de planilha
 * do servidor de auth/billing. Roda como Fly process group próprio na Fase 7
 * (`fly.toml`); em dev/staging sobe via `npm run worker`.
 *
 * Sentry é importado PRIMEIRO (`./instrument`, side-effect-only) — mesmo padrão
 * do `server.ts` — pra instrumentar antes de qualquer código que possa lançar.
 *
 * @owner: @devops
 * @card: 6.4
 */
import './instrument'
import { Queue } from 'bullmq'
import { env } from './config/env'
import { logger } from './lib/logger'
import { captureException } from './config/sentry'
import { sanitizeErrorMessage } from './lib/sanitize-error'
import { prisma } from './lib/prisma'
import {
  createQueueConnection,
  closeQueueConnection,
  getQueueConnection,
} from './config/redis-tcp'
import {
  PROCESS_QUEUE_NAME,
  type ProcessJobPayload,
} from './lib/queue/process-queue'
import { createProcessWorker } from './lib/queue/process-worker'

/** Intervalo do gauge de profundidade de fila + heartbeat (@devops MÉDIO). */
const METRICS_INTERVAL_MS = 30_000
/** Teto de espera do drain no shutdown antes de seguir pro exit (@devops BAIXO). */
const SHUTDOWN_FORCE_MS = 20_000

async function start(): Promise<void> {
  // Dark launch (Card #216 / gate 7.5): sem a flag, o worker NÃO processa —
  // mas também NÃO sai. Sair 0 fazia o `fly deploy` dar timeout esperando a
  // máquina do process group worker atingir "started" → release marcado failed.
  // Em vez disso fica IDLE (processo vivo, sem consumir a fila) e responde a
  // SIGTERM/SIGINT pra encerrar limpo em deploy/scale. Em operação normal o
  // worker fica em count=0 (sem máquina) — o idle só importa quando uma máquina
  // existe com a flag off (1º deploy de prod, DR), tornando o deploy robusto.
  if (!env.ASYNC_PROCESSING_ENABLED) {
    logger.warn(
      { metric: 'worker.idle' },
      '[worker] ASYNC_PROCESSING_ENABLED=false — worker IDLE (não processa a fila)',
    )
    // setInterval (sem unref) mantém o event loop vivo → máquina "started" no Fly.
    // Heartbeat a cada 5min (@devops gate 7.5): torna "worker existe mas IDLE" um
    // estado OBSERVÁVEL contínuo (não só no boot) — habilita alerta "idle +
    // fila waiting>0 por >N min" = flag off com backlog acumulando.
    const IDLE_HEARTBEAT_MS = 5 * 60_000
    const idleTimer = setInterval(() => {
      logger.info(
        { metric: 'worker.idle.heartbeat' },
        '[worker] idle (ASYNC_PROCESSING_ENABLED=false) — não consome a fila',
      )
    }, IDLE_HEARTBEAT_MS)
    let idleShuttingDown = false
    const idleShutdown = (signal: NodeJS.Signals): void => {
      if (idleShuttingDown) return
      idleShuttingDown = true
      clearInterval(idleTimer)
      logger.info({ signal }, '[worker] idle — sinal recebido, encerrando')
      process.exit(0)
    }
    for (const signal of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) {
      process.on(signal, () => idleShutdown(signal))
    }
    return
  }

  const redisUrl = env.REDIS_URL
  const connection = getQueueConnection()
  if (!connection || !redisUrl) {
    logger.error(
      { metric: 'worker.no_redis' },
      '[worker] REDIS_URL ausente — worker async não pode iniciar',
    )
    process.exit(1)
  }

  const worker = createProcessWorker(connection)

  // Queue + conexão DEDICADA só pra métricas de profundidade (getJobCounts é
  // comando normal; não deve compartilhar o socket blocking do Worker).
  const metricsConnection = createQueueConnection(redisUrl)
  const metricsQueue = new Queue<ProcessJobPayload>(PROCESS_QUEUE_NAME, {
    connection: metricsConnection,
  })

  worker.on('completed', (job) => {
    logger.info(
      { jobId: job.id, metric: 'worker.bullmq.completed' },
      '[worker] job finalizado pelo BullMQ',
    )
  })
  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        metric: 'worker.bullmq.failed',
        err: sanitizeErrorMessage(err),
      },
      '[worker] job falhou no BullMQ',
    )
  })
  worker.on('error', (err) => {
    // Erro de infra do worker (conexão, lock) — loga + Sentry, NÃO derruba.
    logger.error(
      { metric: 'worker.error', err: sanitizeErrorMessage(err) },
      '[worker] erro de infraestrutura do worker',
    )
    captureException(err, { route: '/worker' })
  })

  // Gauge periódico de profundidade de fila + heartbeat (dead-man's-switch):
  // fila travada / backlog crescente / worker morto vira invisível sem isto.
  const metricsTimer = setInterval(() => {
    metricsQueue
      .getJobCounts('waiting', 'active', 'delayed', 'failed')
      .then((counts) => {
        logger.info(
          {
            metric: 'worker.queue.depth',
            waiting: counts.waiting,
            active: counts.active,
            delayed: counts.delayed,
            failed: counts.failed,
            rssBytes: process.memoryUsage().rss,
          },
          '[worker] heartbeat + profundidade de fila',
        )
      })
      .catch((err) => {
        logger.warn(
          { metric: 'worker.metrics.failed', err: sanitizeErrorMessage(err) },
          '[worker] falha ao coletar métricas de fila',
        )
      })
  }, METRICS_INTERVAL_MS)
  // Não segura o event loop no shutdown.
  metricsTimer.unref()

  logger.info(
    { queue: PROCESS_QUEUE_NAME, metric: 'worker.started' },
    '[worker] worker async iniciado',
  )

  // Graceful shutdown (D-1): para de puxar jobs, drena o job ativo, fecha
  // conexões. Job morto a meio (kill_timeout do Fly < parse longo) é recuperado
  // pela idempotência do claim no próximo run (B-6.4.2).
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return // guarda de reentrância (sinal duplicado)
    shuttingDown = true
    logger.info({ signal }, '[worker] sinal recebido, encerrando graciosamente')
    clearInterval(metricsTimer)
    try {
      // Drena o job ativo, mas com teto: se o drain passar do limite, segue pro
      // exit (o job em voo é recuperado pela idempotência do claim no próximo run).
      await Promise.race([
        worker.close(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FORCE_MS)),
      ])
      await metricsQueue.close()
      await closeQueueConnection()
      await metricsConnection.quit().catch(() => metricsConnection.disconnect())
      await prisma.$disconnect()
    } catch (err) {
      logger.error(
        { err: sanitizeErrorMessage(err) },
        '[worker] erro no shutdown (best-effort)',
      )
    }
    process.exit(0)
  }

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, () => {
      shutdown(signal).catch(() => {
        // shutdown já trata internamente (try/catch + exit); .catch só satisfaz
        // o no-floating-promises sem usar `void` (proibido pelo lint).
      })
    })
  }
}

start().catch((err) => {
  logger.error(
    { err: sanitizeErrorMessage(err) },
    '[worker] falha fatal ao iniciar',
  )
  captureException(err, { route: '/worker' })
  process.exit(1)
})
