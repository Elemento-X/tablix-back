/**
 * Unit tests for PRO_LIMITS alignment with D.1 (Card 1.5)
 * Covers:
 *   - PRO_LIMITS values match front-end (D.1: front é fonte da verdade)
 *   - validateProLimits: per-file size validation (2 MB)
 *   - validateProLimits: total size validation (30 MB)
 *   - validateProLimits: file count validation (15 files)
 *   - validateRowLimits: per-file row validation (5.000 linhas)
 *   - validateRowLimits: total row validation (75.000 linhas)
 *   - processSpreadsheets: column limit validation (10 colunas)
 *   - Zod schema: maxColumns enforced at schema level
 *   - Edge cases: exactly at limit passes, limit+1 fails
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- vi.hoisted: shared mock state ---
const { prismaMock } = vi.hoisted(() => {
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

  const prismaMock = {
    user: createModelMock(),
    session: createModelMock(),
    token: createModelMock(),
    usage: createModelMock(),
    job: createModelMock(),
    stripeEvent: createModelMock(),
    $transaction: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  }

  return { prismaMock }
})

vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
    JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
    FRONTEND_URL: 'http://localhost:3000',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  },
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('../../src/lib/spreadsheet', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    parseSpreadsheet: vi.fn(),
    validateColumns: vi.fn(),
  }
})

import { PRO_LIMITS } from '../../src/lib/spreadsheet/types'
import { validateProLimits, processSpreadsheets } from '../../src/modules/process/process.service'
import { processSyncInputSchema } from '../../src/modules/process/process.schema'
import { AppError } from '../../src/errors/app-error'
import { parseSpreadsheet, validateColumns } from '../../src/lib/spreadsheet'

// Helper: cria buffer de tamanho exato
function makeBuffer(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes)
}

// Helper: cria FileData
function makeFile(fileName: string, sizeBytes: number): { buffer: Buffer; fileName: string } {
  return { buffer: makeBuffer(sizeBytes), fileName }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: 0 uso no mês
  prismaMock.usage.findUnique.mockResolvedValue(null)
})

// ===========================================
// PRO_LIMITS values — D.1 alignment
// ===========================================
describe('PRO_LIMITS values (D.1 alignment)', () => {
  it('maxFileSize is 2 MB', () => {
    expect(PRO_LIMITS.maxFileSize).toBe(2 * 1024 * 1024)
  })

  it('maxRowsPerFile is 5000', () => {
    expect(PRO_LIMITS.maxRowsPerFile).toBe(5_000)
  })

  it('maxColumns is 10', () => {
    expect(PRO_LIMITS.maxColumns).toBe(10)
  })

  it('maxTotalSize is 30 MB', () => {
    expect(PRO_LIMITS.maxTotalSize).toBe(30 * 1024 * 1024)
  })

  it('maxTotalRows is 75000', () => {
    expect(PRO_LIMITS.maxTotalRows).toBe(75_000)
  })

  it('unificationsPerMonth is 40', () => {
    expect(PRO_LIMITS.unificationsPerMonth).toBe(40)
  })

  it('maxInputFiles is 15', () => {
    expect(PRO_LIMITS.maxInputFiles).toBe(15)
  })
})

// ===========================================
// validateProLimits — per-file size
// ===========================================
describe('validateProLimits — per-file size (2 MB)', () => {
  it('rejects file exceeding 2 MB', async () => {
    const oversizedFile = makeFile('big.csv', 2 * 1024 * 1024 + 1) // 2 MB + 1 byte

    await expect(validateProLimits('user-123', [oversizedFile])).rejects.toThrow(AppError)

    await expect(validateProLimits('user-123', [oversizedFile])).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: '2MB por arquivo',
      }),
    })
  })

  it('accepts file exactly at 2 MB', async () => {
    const exactFile = makeFile('exact.csv', 2 * 1024 * 1024) // Exactly 2 MB

    await expect(validateProLimits('user-123', [exactFile])).resolves.toBeUndefined()
  })

  it('accepts file under 2 MB', async () => {
    const smallFile = makeFile('small.csv', 1 * 1024 * 1024) // 1 MB

    await expect(validateProLimits('user-123', [smallFile])).resolves.toBeUndefined()
  })

  it('rejects when second file exceeds limit', async () => {
    const okFile = makeFile('ok.csv', 1 * 1024 * 1024)
    const bigFile = makeFile('big.xlsx', 2 * 1024 * 1024 + 1)

    await expect(validateProLimits('user-123', [okFile, bigFile])).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: '2MB por arquivo',
        actual: expect.stringContaining('big.xlsx'),
      }),
    })
  })
})

// ===========================================
// validateProLimits — total size
// ===========================================
describe('validateProLimits — total size (30 MB)', () => {
  it('accepts exactly 30 MB total', async () => {
    const files = Array.from({ length: 15 }, (_, i) => makeFile(`file${i}.csv`, 2 * 1024 * 1024))
    await expect(validateProLimits('user-123', files)).resolves.toBeUndefined()
  })

  it('rejects when total exceeds 30 MB', async () => {
    // With current limits, maxInputFiles * maxFileSize = maxTotalSize (30MB).
    // To exercise the total-size branch, temporarily lower maxTotalSize.
    const originalMaxTotalSize = PRO_LIMITS.maxTotalSize
    Object.defineProperty(PRO_LIMITS, 'maxTotalSize', {
      value: 3 * 1024 * 1024,
      configurable: true,
    }) // 3 MB temporary limit

    try {
      // 2 files of 2MB each = 4MB > 3MB temporary limit
      const files = [makeFile('a.csv', 2 * 1024 * 1024), makeFile('b.csv', 2 * 1024 * 1024)]

      await expect(validateProLimits('user-123', files)).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
        details: expect.objectContaining({
          limit: expect.stringContaining('MB total'),
        }),
      })
    } finally {
      Object.defineProperty(PRO_LIMITS, 'maxTotalSize', {
        value: originalMaxTotalSize,
        configurable: true,
      })
    }
  })
})

// ===========================================
// validateProLimits — file count
// ===========================================
describe('validateProLimits — file count (15 max)', () => {
  it('rejects more than 15 files', async () => {
    const files = Array.from({ length: 16 }, (_, i) => makeFile(`file${i}.csv`, 1024))

    await expect(validateProLimits('user-123', files)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: '15 arquivos',
        actual: '16 enviados',
      }),
    })
  })

  it('accepts exactly 15 files', async () => {
    const files = Array.from({ length: 15 }, (_, i) => makeFile(`file${i}.csv`, 1024))

    await expect(validateProLimits('user-123', files)).resolves.toBeUndefined()
  })
})

// ===========================================
// validateProLimits — unifications per month
// ===========================================
describe('validateProLimits — unifications (40/month)', () => {
  it('rejects when at monthly limit', async () => {
    prismaMock.usage.findUnique.mockResolvedValue({
      unificationsCount: 40,
    })

    await expect(validateProLimits('user-123', [makeFile('f.csv', 1024)])).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: '40 unificações/mês',
      }),
    })
  })

  it('accepts when under monthly limit', async () => {
    prismaMock.usage.findUnique.mockResolvedValue({
      unificationsCount: 39,
    })

    await expect(validateProLimits('user-123', [makeFile('f.csv', 1024)])).resolves.toBeUndefined()
  })
})

// ===========================================
// Zod schema — maxColumns validation
// ===========================================
describe('processSyncInputSchema — maxColumns (10)', () => {
  it('rejects more than 10 columns', () => {
    const result = processSyncInputSchema.safeParse({
      selectedColumns: Array.from({ length: 11 }, (_, i) => `col${i}`),
      outputFormat: 'xlsx',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('10')
    }
  })

  it('accepts exactly 10 columns', () => {
    const result = processSyncInputSchema.safeParse({
      selectedColumns: Array.from({ length: 10 }, (_, i) => `col${i}`),
      outputFormat: 'xlsx',
    })

    expect(result.success).toBe(true)
  })

  it('accepts 1 column (minimum)', () => {
    const result = processSyncInputSchema.safeParse({
      selectedColumns: ['col0'],
      outputFormat: 'csv',
    })

    expect(result.success).toBe(true)
  })

  it('rejects 0 columns', () => {
    const result = processSyncInputSchema.safeParse({
      selectedColumns: [],
      outputFormat: 'xlsx',
    })

    expect(result.success).toBe(false)
  })
})

// ===========================================
// processSpreadsheets — per-file row limit (5.000)
// ===========================================
describe('processSpreadsheets — per-file row limit (5.000)', () => {
  const mockParseSpreadsheet = vi.mocked(parseSpreadsheet)
  const mockValidateColumns = vi.mocked(validateColumns)

  beforeEach(() => {
    mockValidateColumns.mockReturnValue(undefined)
    prismaMock.usage.findUnique.mockResolvedValue(null)
    prismaMock.usage.upsert.mockResolvedValue({})
  })

  it('rejects file with 5.001 rows', async () => {
    mockParseSpreadsheet.mockReturnValue({
      fileName: 'huge.csv',
      format: 'csv',
      headers: ['Name'],
      rows: [],
      rowCount: 5_001,
      fileSize: 1024,
    })

    await expect(
      processSpreadsheets('user-123', [makeFile('huge.csv', 1024)], {
        selectedColumns: ['Name'],
        outputFormat: 'xlsx',
      }),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: expect.stringContaining('linhas por arquivo'),
        actual: expect.stringContaining('huge.csv'),
      }),
    })
  })

  it('accepts file with exactly 5.000 rows', async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      Name: `row${i}`,
    }))
    mockParseSpreadsheet.mockReturnValue({
      fileName: 'exact.csv',
      format: 'csv',
      headers: ['Name'],
      rows,
      rowCount: 5_000,
      fileSize: 1024,
    })

    await expect(
      processSpreadsheets('user-123', [makeFile('exact.csv', 1024)], {
        selectedColumns: ['Name'],
        outputFormat: 'csv',
      }),
    ).resolves.toBeDefined()
  })
})

// ===========================================
// processSpreadsheets — per-file row limit edge cases
// ===========================================
describe('processSpreadsheets — per-file row limit edge cases', () => {
  const mockParseSpreadsheet = vi.mocked(parseSpreadsheet)
  const mockValidateColumns = vi.mocked(validateColumns)

  beforeEach(() => {
    mockValidateColumns.mockReturnValue(undefined)
    prismaMock.usage.findUnique.mockResolvedValue(null)
    prismaMock.usage.upsert.mockResolvedValue({})
  })

  it('rejects second file exceeding row limit and reports its filename', async () => {
    const files = [makeFile('ok.csv', 1024), makeFile('big.csv', 1024)]

    mockParseSpreadsheet
      .mockReturnValueOnce({
        fileName: 'ok.csv',
        format: 'csv',
        headers: ['Name'],
        rows: [],
        rowCount: 3_000,
        fileSize: 1024,
      })
      .mockReturnValueOnce({
        fileName: 'big.csv',
        format: 'csv',
        headers: ['Name'],
        rows: [],
        rowCount: 5_001,
        fileSize: 1024,
      })

    await expect(
      processSpreadsheets('user-123', files, {
        selectedColumns: ['Name'],
        outputFormat: 'csv',
      }),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: expect.stringContaining('linhas por arquivo'),
        actual: expect.stringContaining('big.csv'),
      }),
    })
  })
})

// ===========================================
// processSpreadsheets — total row limit (75.000)
// ===========================================
describe('processSpreadsheets — total row limit (75.000)', () => {
  const mockParseSpreadsheet = vi.mocked(parseSpreadsheet)
  const mockValidateColumns = vi.mocked(validateColumns)

  beforeEach(() => {
    mockValidateColumns.mockReturnValue(undefined)
    prismaMock.usage.findUnique.mockResolvedValue(null)
    prismaMock.usage.upsert.mockResolvedValue({})
  })

  it('accepts exactly 75.000 total rows', async () => {
    const files = Array.from({ length: 15 }, (_, i) => makeFile(`file${i}.csv`, 1024))

    let callIndex = 0
    mockParseSpreadsheet.mockImplementation(() => {
      const idx = callIndex++
      return {
        fileName: `file${idx}.csv`,
        format: 'csv',
        headers: ['Name'],
        rows: [],
        rowCount: 5_000,
        fileSize: 1024,
      }
    })

    await expect(
      processSpreadsheets('user-123', files, {
        selectedColumns: ['Name'],
        outputFormat: 'csv',
      }),
    ).resolves.toBeDefined()
  })

  it('rejects when total rows exceed 75.000', async () => {
    // Each file under per-file limit but total exceeds maxTotalRows.
    // 3 files * 4999 rows = 14997 per-file OK, but we need total > 75000.
    // Use many files with rows close to limit: 15 files * 4999 = 74985 (passes).
    // To exceed: mock 15 files with 5000 rows each = 75000 (passes),
    // then add 1 extra row on the last file = 75001.
    // But 5001 would fail per-file! Use a different approach:
    // Mock PRO_LIMITS.maxTotalRows to a smaller value temporarily.
    const files = [makeFile('a.csv', 1024), makeFile('b.csv', 1024)]

    mockParseSpreadsheet
      .mockReturnValueOnce({
        fileName: 'a.csv',
        format: 'csv',
        headers: ['Name'],
        rows: [],
        rowCount: 4_000,
        fileSize: 1024,
      })
      .mockReturnValueOnce({
        fileName: 'b.csv',
        format: 'csv',
        headers: ['Name'],
        rows: [],
        rowCount: 4_000,
        fileSize: 1024,
      })

    // Temporarily lower maxTotalRows to exercise the branch
    const originalMaxTotalRows = PRO_LIMITS.maxTotalRows
    Object.defineProperty(PRO_LIMITS, 'maxTotalRows', {
      value: 7_999,
      configurable: true,
    })

    try {
      await expect(
        processSpreadsheets('user-123', files, {
          selectedColumns: ['Name'],
          outputFormat: 'csv',
        }),
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
        details: expect.objectContaining({
          limit: expect.stringContaining('linhas'),
        }),
      })
    } finally {
      Object.defineProperty(PRO_LIMITS, 'maxTotalRows', {
        value: originalMaxTotalRows,
        configurable: true,
      })
    }
  })
})

// ===========================================
// processSpreadsheets — column limit at service level
// ===========================================
describe('processSpreadsheets — column limit (10) at service level', () => {
  it('rejects 11 columns', async () => {
    prismaMock.usage.findUnique.mockResolvedValue(null)

    await expect(
      processSpreadsheets('user-123', [makeFile('f.csv', 1024)], {
        selectedColumns: Array.from({ length: 11 }, (_, i) => `col${i}`),
        outputFormat: 'xlsx',
      }),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: '10 colunas',
        actual: '11 selecionadas',
      }),
    })
  })
})
