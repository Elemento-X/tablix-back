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
 *
 * Card #150 — @security ALTO F-HIGH-01: aplicar `redact: { paths: REDACT_PATHS }`
 * (SSOT em src/config/logger.ts) como defesa em profundidade contra PII vazada
 * por bug. Em código LGPD-sensível com retencao 5y (audit_log_legal), uma
 * linha alterada sem revisao atenta vaza PII direto pra stdout. REDACT é
 * second barrier além da disciplina do dev.
 */
import pino from 'pino'

import { env } from '../config/env'
import { REDACT_PATHS } from '../config/logger'

function resolveLogLevel(): 'silent' | 'info' | 'debug' {
  if (env.NODE_ENV === 'test') return 'silent'
  if (env.NODE_ENV === 'production') return 'info'
  return 'debug'
}

export const logger = pino({
  level: resolveLogLevel(),
  // SSOT REDACT_PATHS reusado de src/config/logger.ts (Card 2.1 + 2.2 + #77 LGPD).
  // Bloqueia tokens, secrets, PII (email/phone/cpf), session ids, etc — mesmo
  // quando dev futuro adicionar campo sensível num logger.info por descuido.
  redact: { paths: [...REDACT_PATHS] },
  // Transport `pino-pretty` fica a cargo do Fastify logger (app.ts) —
  // este logger é para código fora do ciclo de request e usa saída JSON
  // crua (pino default). Mantém zero dep opcional em runtime.
})
