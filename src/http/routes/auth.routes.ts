import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { authMiddleware } from '../../middleware/auth.middleware'
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware'
import * as authController from '../controllers/auth.controller'
import {
  validateTokenBodySchema,
  validateTokenResponseSchema,
  refreshBodySchema,
  refreshResponseSchema,
  meResponseSchema,
  logoutResponseSchema,
  errorResponseSchema,
} from '../../modules/auth/auth.schema'

export async function authRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // POST /auth/validate-token - Valida token Pro e retorna JWT
  server.post('/validate-token', {
    preHandler: rateLimitMiddleware.validateToken,
    schema: {
      tags: ['Auth'],
      summary: 'Validar token Pro',
      description:
        'Valida um token Pro (recebido por email) e retorna um JWT de sessão. No primeiro uso, vincula o token ao fingerprint do dispositivo.',
      body: validateTokenBodySchema,
      response: {
        200: validateTokenResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: authController.validateToken,
  })

  // POST /auth/refresh - Renova JWT expirado
  server.post('/refresh', {
    preHandler: rateLimitMiddleware.authRefresh,
    schema: {
      tags: ['Auth'],
      summary: 'Renovar sessão',
      description:
        'Renova um JWT expirado. O token original deve estar expirado há menos de 7 dias.',
      body: refreshBodySchema,
      response: {
        200: refreshResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: authController.refresh,
  })

  // GET /auth/me - Retorna dados do usuário autenticado
  server.get('/me', {
    preHandler: [rateLimitMiddleware.authMe, authMiddleware],
    schema: {
      tags: ['Auth'],
      summary: 'Dados do usuário',
      description:
        'Retorna dados do usuário autenticado, incluindo uso mensal e limites do plano.',
      security: [{ bearerAuth: [] }],
      response: {
        200: meResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: authController.me,
  })

  // POST /auth/logout - Logout (client-side)
  server.post('/logout', {
    preHandler: [rateLimitMiddleware.global, authMiddleware],
    schema: {
      tags: ['Auth'],
      summary: 'Logout',
      description:
        'Endpoint de logout. Como JWT é stateless, o logout real é feito removendo o token no cliente.',
      security: [{ bearerAuth: [] }],
      response: {
        200: logoutResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: authController.logout,
  })
}
