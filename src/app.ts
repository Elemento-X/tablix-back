import fastify, { FastifyError } from 'fastify'
import { constants as zlibConstants } from 'node:zlib'
import compress from '@fastify/compress'
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
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod'
import { env } from './config/env'
import { buildLoggerOptions, genReqId } from './config/logger'
import { captureException } from './config/sentry'
import { registerRoutes } from './http/routes'
import { AppError } from './errors/app-error'
import { PRO_LIMITS } from './lib/spreadsheet'
import { resolveTrustProxy } from './lib/trust-proxy'

// resolveTrustProxy re-exportado para preservar consumers de teste históricos.
// Implementação real em ./lib/trust-proxy.ts — extraído no Card 3.2 (#31) pra
// permitir unit test sob coverage sem re-instrumentar todo o app.
export { resolveTrustProxy }

export async function buildApp() {
  // Card 2.1 — logger e reqId centralizados em src/config/logger.ts.
  // buildLoggerOptions() traz redact de PII/secrets, serializers que pulam
  // body de /auth e /webhooks, e formatter JSON em prod / pretty em dev.
  // genReqId aceita x-request-id incoming só se for UUID v4 válido (anti-spoof).
  const app = fastify({
    logger: buildLoggerOptions(),
    genReqId,
    trustProxy: resolveTrustProxy(),
    // requestTimeout (api-routes.md + Card #219/F2 @security): teto pra RECEBER a
    // request inteira. Sem ele (default 0 = desabilitado), um upload lento
    // (slowloris) no /process/sync segura indefinidamente o slot de concorrência
    // (#219) → DoS. 120s cobre uploads grandes legítimos (até 30MB) em conexões
    // normais; o caminho async existe pra arquivos que excedam isso. Ao expirar,
    // o Fastify encerra a request → dispara o 'close'/onResponse → libera o slot.
    requestTimeout: 120_000,
  }).withTypeProvider<ZodTypeProvider>()

  // Expõe o reqId ao cliente pra correlação em debug/incident response.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
    // Card #220: Permissions-Policy restritivo. A API não usa nenhuma feature de
    // browser — desliga todas as principais (defesa caso uma resposta seja
    // renderizada em contexto de navegador). Helmet 8 não seta este header por default.
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    )
  })

  // Configura Zod como validador/serializador
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Plugins de segurança
  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
    // Card #220: cacheia o preflight OPTIONS por 24h no browser → corta o flood
    // de preflight em cada request cross-origin (1 OPTIONS/dia/rota em vez de 1/request).
    maxAge: 86400,
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
    // Card #220: DENY (não SAMEORIGIN). A API nunca é embedada em iframe — clickjacking
    // defense estrito. Frontend é app separado (CORS), não consome via frame.
    frameguard: { action: 'deny' },
  })

  // Card #220: compressão de resposta (brotli quality 4 — CPU-consciente p/
  // shared-cpu-1x —, gzip fallback). O @fastify/compress decide o que comprimir por
  // regex de content-type (text/*, *+json, octet-stream) com fallback no mime-db:
  // JSON/texto/CSV entram; binários já-comprimidos (xlsx/zip do /process/sync, marcados
  // compressible:false no mime-db) são pulados, sem desperdiçar CPU em re-compressão.
  // threshold 1KB isenta payloads minúsculos. Roda no threadpool do libuv (não bloqueia
  // o event loop) e não bufferiza o payload inteiro além do que o handler já alocou.
  await app.register(compress, {
    encodings: ['br', 'gzip'],
    threshold: 1024,
    // @reviewer F-220-01 (least-privilege): desliga a decompressão de body de
    // REQUEST. Nenhum cliente Tablix envia body comprimido; manter o request-side
    // ligado abriria superfície de decompression-bomb (1KB → N MB inflados) sem
    // necessidade. A compressão de RESPONSE segue global (globalCompression default).
    globalDecompression: false,
    // Pin explícito do brotli quality 4 (não herdar o default da lib silenciosamente):
    // sweet-spot CPU/ratio p/ shared-cpu-1x; q11 teria custo de CPU proibitivo.
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
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

      // Erro de validação do fastify-type-provider-zod (Card #32a).
      // ZodError não tem o campo `.validation` do AJV — se não for tratado
      // aqui, cai no catch genérico abaixo e vira 500 (bug @reviewer/@security
      // revelado pelo Card #32). `hasZodFastifySchemaValidationErrors` é o
      // type guard oficial exportado pela lib.
      //
      // `details` precisa bater com `z.record(z.unknown())` do
      // errorDetailSchema (common.schema.ts) — o array `error.validation`
      // do fastify-type-provider-zod é wrapado em `{ errors: [...] }` pra
      // passar na validação do response schema da rota (que declara 400).
      if (hasZodFastifySchemaValidationErrors(error)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Erro de validação',
            details: { errors: error.validation },
          },
        })
      }

      // Erro de validação do Fastify/AJV (schemas não-Zod)
      if ('validation' in error && error.validation) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Erro de validação',
            details: { errors: error.validation },
          },
        })
      }

      // Erro de CLIENTE do Fastify (statusCode 4xx) — JSON malformado
      // (FST_ERR_CTP_INVALID_JSON 400), Content-Type não suportado (415), body
      // grande demais (413), etc. NÃO é erro de servidor → devolve o status do
      // cliente SEM disparar Sentry. Card #215 (gate 7.5): sem este branch,
      // qualquer 4xx caía no genérico abaixo → 500 + captureException, o que
      // numa rota pública (ex: /webhooks/stripe) vira flood de Sentry /
      // denial-of-wallet + poluição do SLI de erro.
      const clientStatus = (error as FastifyError).statusCode
      if (
        typeof clientStatus === 'number' &&
        clientStatus >= 400 &&
        clientStatus < 500
      ) {
        return reply.status(clientStatus).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Requisição inválida',
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
