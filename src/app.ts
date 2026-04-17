import fastify, { FastifyError } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { env } from './config/env'
import { buildLoggerOptions, genReqId } from './config/logger'
import { captureException } from './config/sentry'
import { registerRoutes } from './http/routes'
import { AppError } from './errors/app-error'
import { PRO_LIMITS } from './lib/spreadsheet'

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

export async function buildApp() {
  // Card 2.1 — logger e reqId centralizados em src/config/logger.ts.
  // buildLoggerOptions() traz redact de PII/secrets, serializers que pulam
  // body de /auth e /webhooks, e formatter JSON em prod / pretty em dev.
  // genReqId aceita x-request-id incoming só se for UUID v4 válido (anti-spoof).
  const app = fastify({
    logger: buildLoggerOptions(),
    genReqId,
    trustProxy: resolveTrustProxy(),
  }).withTypeProvider<ZodTypeProvider>()

  // Expõe o reqId ao cliente pra correlação em debug/incident response.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  // Configura Zod como validador/serializador
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Plugins de segurança
  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
    exposedHeaders: [
      'Content-Disposition',
      'X-Tablix-Rows',
      'X-Tablix-Columns',
      'X-Tablix-File-Size',
      'X-Tablix-Format',
      'X-Tablix-File-Name',
    ],
  })

  await app.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === 'production',
  })

  // Multipart para upload de arquivos (limites alinhados com PRO_LIMITS — D.1)
  // fieldSize/fields (Card 1.16 / @security finding c8a3f70e5d12):
  //   Sem esses caps, atacante autenticado manda request com N fields de 1MB
  //   (default busboy) e paga parse+zod por iteração. Aqui temos só 2 fieldnames
  //   válidos (selectedColumns, outputFormat); fields=10 dá folga de 5x sem
  //   abrir vetor. fieldSize=8KB casa com MAX_SELECTED_COLUMNS_FIELD_BYTES.
  await app.register(multipart, {
    limits: {
      fileSize: PRO_LIMITS.maxFileSize, // 2 MB por arquivo (D.1)
      files: PRO_LIMITS.maxInputFiles, // 15 arquivos por unificação
      fields: 10, // max fields não-arquivo por request (Card 1.16)
      fieldSize: 8 * 1024, // 8 KB por field (Card 1.16 — alinhado com helper)
      fieldNameSize: 100, // 100 bytes por nome de field (default explícito)
    },
  })

  // Swagger / OpenAPI
  await app.register(swagger, {
    transform: jsonSchemaTransform,
    openapi: {
      info: {
        title: 'Tablix API',
        description: 'API do backend Tablix para unificação de planilhas',
        version: '1.0.0',
      },
      servers: [
        {
          url: env.API_URL || `http://localhost:${env.PORT}`,
          description:
            env.NODE_ENV === 'production' ? 'Produção' : 'Desenvolvimento',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT obtido via /auth/validate-token',
          },
        },
      },
      tags: [
        { name: 'Auth', description: 'Autenticação e sessão' },
        { name: 'Billing', description: 'Pagamentos e assinaturas (Stripe)' },
        { name: 'Process', description: 'Processamento de planilhas' },
        { name: 'Usage', description: 'Uso e limites do plano' },
        { name: 'Health', description: 'Status da API' },
      ],
    },
  })

  // Card 1.18 @security finding SEC.18 (OWASP A05): Swagger UI em produção
  // expõe schemas completos, endpoints e exemplos — facilita reconhecimento
  // pra atacante. Em prod, nada é registrado em /docs. O spec continua
  // acessível via `app.swagger()` programaticamente (build-time export,
  // testes, etc.), só não via HTTP público. Se algum dia precisar de
  // /docs/json em runtime de prod, adicionar com basic auth — nunca aberto.
  if (env.NODE_ENV !== 'production') {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    })
  }

  // Error handler global
  app.setErrorHandler(
    (error: FastifyError | AppError | Error, request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }

      // Erro de validação do Fastify
      if ('validation' in error && error.validation) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Erro de validação',
            details: error.validation,
          },
        })
      }

      // Log de erros não tratados
      request.log.error(error)

      // Card 2.2 — envia erro 5xx não tratado ao Sentry com contexto mínimo.
      // `beforeSend` em config/sentry.ts já dropa eventos em `test` e scruba
      // body/headers sensíveis. Nunca passar o objeto request inteiro aqui.
      //
      // F5 (@security): `route` é TEMPLATE (`/users/:id`), nunca URL raw com
      // valores. `request.routeOptions?.url` é o template do Fastify; se
      // ausente (erro antes do routing), fallback é `'unknown'` — NUNCA
      // `request.url` cru, que vaza path params + query como tag cardinal no
      // Sentry (violação LGPD + cardinality explosion).
      captureException(error, {
        reqId: request.id,
        route: request.routeOptions?.url ?? 'unknown',
      })

      // Só vaza mensagem real em development
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message:
            env.NODE_ENV === 'development' && error instanceof Error
              ? error.message
              : 'Erro interno do servidor',
        },
      })
    },
  )

  // Health check (Card 2.3) — registrado via registerRoutes em src/http/routes/health.routes.ts
  // Substituiu o /health inline trivial por /health, /health/live, /health/ready
  // com checks profundos de DB e Redis, cache stale-while-revalidate e contratos Zod.

  // Registra todas as rotas
  await registerRoutes(app)

  return app
}
