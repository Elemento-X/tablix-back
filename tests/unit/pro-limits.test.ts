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

import { PRO_LIMITS } from '../../src/lib/spreadsheet/types'
import {
  validateProLimits,
  processSpreadsheets,
} from '../../src/modules/process/process.service'
import { processSyncInputSchema } from '../../src/modules/process/process.schema'
import { AppError } from '../../src/errors/app-error'
import { parseSpreadsheet, validateColumns } from '../../src/lib/spreadsheet'

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
    // Card 4.2: validateAndIncrementUsage usa $queryRaw atômico.
    $queryRaw: vi.fn(),
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

// Helper: cria buffer de tamanho exato
function makeBuffer(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes)
}

// Helper: cria FileData
function makeFile(
  fileName: string,
  sizeBytes: number,
): { buffer: Buffer; fileName: string } {
  return { buffer: makeBuffer(sizeBytes), fileName }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: 0 uso no mês
  prismaMock.usage.findUnique.mockResolvedValue(null)
  // Card 4.2: validateAndIncrementUsage usa $queryRaw atômico. Default
  // = sucesso (count=1). Tests de quota exhausted overridam pra [].
  prismaMock.$queryRaw.mockResolvedValue([{ unifications_count: 1 }])
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

  it('unificationsPerMonth is 30 (D.1)', () => {
    // Regression guard: antes era 40, fonte da verdade e 30 (Card 1.11).
    expect(PRO_LIMITS.unificationsPerMonth).toBe(30)
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

    await expect(
      validateProLimits('user-123', [oversizedFile]),
    ).rejects.toThrow(AppError)

    await expect(
      validateProLimits('user-123', [oversizedFile]),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: '2MB por arquivo',
      }),
    })
  })

  it('accepts file exactly at 2 MB', async () => {
    const exactFile = makeFile('exact.csv', 2 * 1024 * 1024) // Exactly 2 MB

    await expect(
      validateProLimits('user-123', [exactFile]),
    ).resolves.toBeUndefined()
  })

  it('accepts file under 2 MB', async () => {
    const smallFile = makeFile('small.csv', 1 * 1024 * 1024) // 1 MB

    await expect(
      validateProLimits('user-123', [smallFile]),
    ).resolves.toBeUndefined()
  })

  it('rejects when second file exceeds limit', async () => {
    const okFile = makeFile('ok.csv', 1 * 1024 * 1024)
    const bigFile = makeFile('big.xlsx', 2 * 1024 * 1024 + 1)

    await expect(
      validateProLimits('user-123', [okFile, bigFile]),
    ).rejects.toMatchObject({
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
    const files = Array.from({ length: 15 }, (_, i) =>
      makeFile(`file${i}.csv`, 2 * 1024 * 1024),
    )
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
      const files = [
        makeFile('a.csv', 2 * 1024 * 1024),
        makeFile('b.csv', 2 * 1024 * 1024),
      ]

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
    const files = Array.from({ length: 16 }, (_, i) =>
      makeFile(`file${i}.csv`, 1024),
    )

    await expect(validateProLimits('user-123', files)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({
        limit: '15 arquivos',
        actual: '16 enviados',
      }),
    })
  })

  it('accepts exactly 15 files', async () => {
    const files = Array.from({ length: 15 }, (_, i) =>
      makeFile(`file${i}.csv`, 1024),
    )

    await expect(validateProLimits('user-123', files)).resolves.toBeUndefined()
  })
})

// ===========================================
// validateProLimits — unifications per month (Card 4.2 — moved)
// ===========================================
// Card 4.2: a validação de unificações mensais MIGROU de `validateProLimits`
// para `validateAndIncrementUsage` (atomic). Tests dessa lógica vivem agora
// em `tests/unit/usage-service.test.ts`. `validateProLimits` aqui só valida
// file size/count/colunas — pre-flight cheap.
//
// Estes 2 cenários (at limit / under limit) ficam cobertos via integração
// concorrente em `tests/integration/usage-atomic.integration.test.ts` (Card
// 4.2) e via mock $queryRaw em `tests/unit/usage-service.test.ts`.

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
    const files = Array.from({ length: 15 }, (_, i) =>
      makeFile(`file${i}.csv`, 1024),
    )

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

// ===========================================
// processSpreadsheets — aggregated input-cells cap (#225 @performance F1)
// ===========================================
// O cap acumula Σ(rowCount × headers.length) INCREMENTALMENTE no loop de parse
// e aborta ANTES de empilhar o próximo arquivo — bounding o pico de retenção em
// memória (parsedSpreadsheets[] segura o grid de TODOS os arquivos ao mesmo
// tempo). maxInputColumns (por arquivo) NÃO bounda o produto sob N arquivos;
// maxInputCells (agregado) é a camada que fecha esse gap.
describe('processSpreadsheets — input-cells cap (maxInputCells)', () => {
  const mockParseSpreadsheet = vi.mocked(parseSpreadsheet)
  const mockValidateColumns = vi.mocked(validateColumns)
  const MAX_CELLS = PRO_LIMITS.maxInputCells // 1.500.000 (PRO)

  beforeEach(() => {
    mockValidateColumns.mockReturnValue(undefined)
    prismaMock.usage.findUnique.mockResolvedValue(null)
    prismaMock.usage.upsert.mockResolvedValue({})
  })

  /** Programa parseSpreadsheet pra devolver, por chamada, um grid cols×rows. */
  function mockFilesParsed(
    specs: Array<{ fileName: string; cols: number; rows: number }>,
  ): void {
    let i = 0
    mockParseSpreadsheet.mockImplementation(() => {
      const s = specs[i++]
      return {
        fileName: s.fileName,
        format: 'csv',
        headers: Array.from({ length: s.cols }, (_, k) => `h${k}`),
        rows: [],
        rowCount: s.rows,
        fileSize: 1024,
      }
    })
  }

  it('rejeita conjunto cujo Σ(linhas×colunas) > maxInputCells → 400 LIMIT_EXCEEDED', async () => {
    // 4 arquivos de 100 col × 5.000 linhas = 500k células cada → Σ = 2.000.000 > 1,5M.
    // (cada arquivo isolado respeita maxInputColumns=100 e maxRowsPerFile=5.000:
    // só a SOMA estoura — exatamente o gap que o cap agregado fecha.)
    const files = Array.from({ length: 4 }, (_, i) =>
      makeFile(`f${i}.csv`, 1024),
    )
    mockFilesParsed(
      files.map((f) => ({ fileName: f.fileName, cols: 100, rows: 5_000 })),
    )

    let captured: AppError | undefined
    try {
      await processSpreadsheets('user-123', files, {
        selectedColumns: ['h0'],
        outputFormat: 'csv',
      })
    } catch (err) {
      captured = err as AppError
    }

    expect(captured).toBeInstanceOf(AppError)
    expect(captured?.code).toBe('LIMIT_EXCEEDED')
    expect(captured?.statusCode).toBe(400)
    expect(captured?.details?.limit).toContain(
      'células de entrada (linhas × colunas somadas)',
    )
    // Mutation-resilient: `actual` reflete o Σ real (2.000.000), não um literal.
    // Extrai só dígitos pra ser robusto à locale do toLocaleString.
    const actualDigits = String(captured?.details?.actual).replace(/\D/g, '')
    expect(actualDigits).toBe('2000000')
  })

  it('aceita conjunto exatamente no limite (Σ = maxInputCells) — o cap é `>`, não `>=`', async () => {
    // 3 arquivos de 100 col × 5.000 linhas = 500k cada → Σ = 1.500.000 == limite.
    // Guard explícito contra mutação `>` → `>=` (que rejeitaria o exato).
    const files = Array.from({ length: 3 }, (_, i) =>
      makeFile(`f${i}.csv`, 1024),
    )
    mockFilesParsed(
      files.map((f) => ({ fileName: f.fileName, cols: 100, rows: 5_000 })),
    )

    await expect(
      processSpreadsheets('user-123', files, {
        selectedColumns: ['h0'],
        outputFormat: 'csv',
      }),
    ).resolves.toBeDefined()

    // Sanidade: o Σ testado é de fato o limite (não um número arbitrário).
    expect(3 * 100 * 5_000).toBe(MAX_CELLS)
  })

  it('PROVA (incrementalidade): aborta no arquivo que estoura — NÃO parseia os seguintes', async () => {
    // 6 arquivos de 500k células. Σ cruza 1,5M no 4º (após o 3º Σ=1,5M, ainda
    // passa; o 4º leva a 2,0M e dispara). Se o cap fosse pós-loop, os 6 já teriam
    // sido materializados. Provar que parseSpreadsheet parou no 4º = bound de memória.
    const files = Array.from({ length: 6 }, (_, i) =>
      makeFile(`f${i}.csv`, 1024),
    )
    mockFilesParsed(
      files.map((f) => ({ fileName: f.fileName, cols: 100, rows: 5_000 })),
    )

    await expect(
      processSpreadsheets('user-123', files, {
        selectedColumns: ['h0'],
        outputFormat: 'csv',
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    // O 4º arquivo dispara o throw → arquivos 5 e 6 NUNCA são parseados.
    expect(mockParseSpreadsheet).toHaveBeenCalledTimes(4)
    // validateColumns roda antes do cap, no mesmo loop → também 4×.
    expect(mockValidateColumns).toHaveBeenCalledTimes(4)
  })

  it('LIMIT_EXCEEDED não vaza fileName/PII nos details nem no envelope (#224/#225)', async () => {
    const piiName = 'folha_pagamento_joao_cpf_12345678900'
    const files = Array.from({ length: 4 }, (_, i) =>
      makeFile(`${piiName}_${i}.csv`, 1024),
    )
    mockFilesParsed(
      files.map((f) => ({ fileName: f.fileName, cols: 100, rows: 5_000 })),
    )

    let captured: AppError | undefined
    try {
      await processSpreadsheets('user-123', files, {
        selectedColumns: ['h0'],
        outputFormat: 'csv',
      })
    } catch (err) {
      captured = err as AppError
    }

    expect(captured?.code).toBe('LIMIT_EXCEEDED')
    // limitExceeded chamado SEM o 3º arg (file) → chave `file` ausente.
    expect(captured?.details).not.toHaveProperty('file')
    expect(JSON.stringify(captured?.details)).not.toContain(piiName)
    expect(captured?.message).not.toContain(piiName)
    expect(JSON.stringify(captured?.toJSON())).not.toContain(piiName)
  })

  it('regressão: conjunto normal (poucas células) passa sem disparar o cap', async () => {
    // 2 arquivos de 10 col × 100 linhas = 1.000 células cada → Σ = 2.000, << 1,5M.
    const files = [makeFile('a.csv', 1024), makeFile('b.csv', 1024)]
    mockFilesParsed([
      { fileName: 'a.csv', cols: 10, rows: 100 },
      { fileName: 'b.csv', cols: 10, rows: 100 },
    ])

    await expect(
      processSpreadsheets('user-123', files, {
        selectedColumns: ['h0'],
        outputFormat: 'csv',
      }),
    ).resolves.toBeDefined()

    // Ambos os arquivos foram parseados (nenhum abortado).
    expect(mockParseSpreadsheet).toHaveBeenCalledTimes(2)
  })

  it('single file dentro do limite não dispara o cap (boundary inferior)', async () => {
    // 1 arquivo de 100 col × 5.000 linhas = 500k células < 1,5M.
    const files = [makeFile('solo.csv', 1024)]
    mockFilesParsed([{ fileName: 'solo.csv', cols: 100, rows: 5_000 }])

    await expect(
      processSpreadsheets('user-123', files, {
        selectedColumns: ['h0'],
        outputFormat: 'csv',
      }),
    ).resolves.toBeDefined()
  })
})
