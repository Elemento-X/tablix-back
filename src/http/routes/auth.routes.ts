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
  logoutAllResponseSchema,
  errorResponseSchema,
} from '../../modules/auth/auth.schema'

export async function authRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>()

  // POST /auth/validate-token - Valida token Pro e retorna access + refresh tokens
  server.post('/validate-token', {
    preHandler: rateLimitMiddleware.validateToken,
    schema: {
      tags: ['Auth'],
      summary: 'Validar token Pro',
      description:
        'Valida um token Pro (recebido por email) e retorna access token (15min) + refresh token (30d). No primeiro uso, vincula o token ao fingerprint do dispositivo.',
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

  // POST /auth/refresh - Renova tokens usando refresh token
  server.post('/refresh', {
    preHandler: rateLimitMiddleware.authRefresh,
    schema: {
      tags: ['Auth'],
      summary: 'Renovar sessão',
      description:
        'Renova access + refresh tokens usando o refresh token. O refresh token anterior é invalidado (rotation).',
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

  // POST /auth/logout - Revoga a sessão atual
  server.post('/logout', {
    preHandler: [rateLimitMiddleware.global, authMiddleware],
    schema: {
      tags: ['Auth'],
      summary: 'Logout',
      description:
        'Revoga a sessão atual. O access token existente expira em até 15min, mas a sessão é imediatamente invalidada.',
      security: [{ bearerAuth: [] }],
      response: {
        200: logoutResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: authController.logout,
  })

  // POST /auth/logout-all - Revoga todas as sessões do usuário
  server.post('/logout-all', {
    preHandler: [rateLimitMiddleware.global, authMiddleware],
    schema: {
      tags: ['Auth'],
      summary: 'Logout de todos os dispositivos',
      description:
        'Revoga todas as sessões ativas do usuário. Útil quando o usuário suspeita de acesso não autorizado.',
      security: [{ bearerAuth: [] }],
      response: {
        200: logoutAllResponseSchema,
        401: errorResponseSchema,
        429: errorResponseSchema,
      },
    },
    handler: authController.logoutAll,
  })
}
