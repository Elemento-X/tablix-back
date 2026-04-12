/**
 * Root pino logger compartilhado para módulos que não têm acesso ao
 * `request.log` do Fastify (config estática, boot, helpers puros).
 *
 * Para código que roda dentro do ciclo de request, prefira `request.log`
 * — ele já carrega reqId e contexto do Fastify.
 *
 * Motivação: @reviewer #BAIXO pipeline run #2 — `console.warn` em
 * plan-limits.ts polui stdout sem estrutura e não respeita level/transport.
 * Pino estruturado permite filtro, correlação e descarte em test.
 */
import pino from 'pino'
import { env } from '../config/env'

function resolveLogLevel(): 'silent' | 'info' | 'debug' {
  if (env.NODE_ENV === 'test') return 'silent'
  if (env.NODE_ENV === 'production') return 'info'
  return 'debug'
}

export const logger = pino({
  level: resolveLogLevel(),
  // Transport `pino-pretty` fica a cargo do Fastify logger (app.ts) —
  // este logger é para código fora do ciclo de request e usa saída JSON
  // crua (pino default). Mantém zero dep opcional em runtime.
})
