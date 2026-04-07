import { JwtPayload } from '../lib/jwt'

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload
  }
}
