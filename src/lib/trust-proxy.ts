import { env } from '../config/env'

/**
 * Card 1.12 — Resolve configuração de trustProxy de forma fail-closed.
 *
 * trustProxy controla como Fastify resolve `request.ip` a partir de
 * X-Forwarded-For. Ler XFF cru é spoofável; só devemos confiar em XFF
 * vindo de hops comprovadamente nossos.
 *
 * NODE_ENV é enum fechado `['development','production','test']` (ver env.ts).
 * Exaustividade garantida pelo `switch` — qualquer valor novo vira erro de
 * compilação, prevenindo fail-open silencioso (ex: staging novo sem trust
 * explícito).
 *
 * - `production`: 1 hop (load balancer da plataforma — Fly.io/Render).
 *   TODO (Fase 8): trocar por allowlist explícita de IPs do Fly.io.
 * - `development` / `test`: loopback CIDRs explícitos. Curl/integração
 *   local continua funcionando, mas XFF spoofado de 1.2.3.4 não é
 *   honrado — `request.ip` permanece como o hop loopback real.
 *
 * Extraído de `src/app.ts` no Card 3.2 (#31) para permitir unit test sob
 * coverage sem re-instrumentar Fastify+plugins (que causava timeout).
 */
export function resolveTrustProxy(): number | string[] {
  switch (env.NODE_ENV) {
    case 'production':
      return 1
    case 'development':
    case 'test':
      return ['127.0.0.0/8', '::1/128']
  }
}
