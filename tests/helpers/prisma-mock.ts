/**
 * Prisma mock factory for unit tests.
 * Creates a deeply-mocked PrismaClient where every model method is a vi.fn().
 * Usage: vi.mock('../../src/lib/prisma', () => ({ prisma: createPrismaMock() }))
 *
 * @owner: @tester
 */
import { vi } from 'vitest'

function createModelMock() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn(),
  }
}

export function createPrismaMock() {
  return {
    user: createModelMock(),
    session: createModelMock(),
    token: createModelMock(),
    usage: createModelMock(),
    job: createModelMock(),
    $transaction: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  }
}

export type PrismaMock = ReturnType<typeof createPrismaMock>
