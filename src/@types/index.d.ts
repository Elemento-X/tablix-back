import { AccessTokenPayload } from '../lib/jwt'

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessTokenPayload
  }
}
