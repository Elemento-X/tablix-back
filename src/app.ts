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
import { registerRoutes } from './http/routes'
import { AppError } from './errors/app-error'
import { PRO_LIMITS } from './lib/spreadsheet'

export async function buildApp() {
  const app = fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      ...(env.NODE_ENV === 'development' && {
        transport: { target: 'pino-pretty' },
      }),
    },
  }).withTypeProvider<ZodTypeProvider>()

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
  await app.register(multipart, {
    limits: {
      fileSize: PRO_LIMITS.maxFileSize, // 2 MB por arquivo (D.1)
      files: PRO_LIMITS.maxInputFiles, // 15 arquivos por unificação
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

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  })

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

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  // Registra todas as rotas
  await registerRoutes(app)

  return app
}
