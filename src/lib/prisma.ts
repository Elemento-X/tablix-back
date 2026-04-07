import { PrismaClient } from '@prisma/client'
import { env } from '../config/env'

const prismaClientSingleton = () => {
  return new PrismaClient({
    log:
      env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>
} & typeof global

// Evita multiplas instancias do Prisma em desenvolvimento (hot reload)
export const prisma = globalThis.prismaGlobal ?? prismaClientSingleton()

if (env.NODE_ENV !== 'production') {
  globalThis.prismaGlobal = prisma
}
