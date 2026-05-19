/**
 * Prisma mock factory for unit tests.
 * Creates a deeply-mocked PrismaClient where every model method is a vi.fn().
 * Usage: vi.mock('../../src/lib/prisma', () => ({ prisma: createPrismaMock() }))
 *
 * Cobre todos os models de prisma/schema.prisma. Novos models DEVEM ser
 * adicionados aqui quando introduzidos, senão testes que os mockam dão
 * `undefined.findFirst is not a function`.
 *
 * Para testes que usam DB real (integração), ver tests/helpers/prisma.ts
 * (stub até Card 3.1b / Testcontainers).
 *
 * @owner: @tester
 */
import { vi } from 'vitest'

function createModelMock() {
  return {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  }
}

export function createPrismaMock() {
  return {
    user: createModelMock(),
    session: createModelMock(),
    token: createModelMock(),
    usage: createModelMock(),
    job: createModelMock(),
    stripeEvent: createModelMock(),
    auditLog: createModelMock(),
    $transaction: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
  }
}

export type PrismaMock = ReturnType<typeof createPrismaMock>
