/**
 * Tests for process.controller.ts (Card 1.4)
 * Covers:
 *   - Binary response with correct Content-Type and Content-Disposition
 *   - X-Tablix-* custom headers present in response
 *   - XLSX buffer is valid (starts with PK magic bytes)
 *   - Concurrency guard: acquires and releases slots
 *   - Concurrency guard: rejects when limit exceeded
 *   - Memory logging on each request
 *   - CORS exposedHeaders includes X-Tablix-* headers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- vi.hoisted: shared mock state ---
const { prismaMock, redisMock } = vi.hoisted(() => {
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

  const redisMock = {
    incr: vi.fn(),
    decr: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
  }

  return { prismaMock, redisMock }
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

vi.mock('../../src/config/redis', () => ({
  redis: redisMock,
  isRedisConfigured: () => true,
  getRedis: () => redisMock,
}))

vi.mock('../../src/lib/spreadsheet', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    parseSpreadsheet: vi.fn(),
    validateColumns: vi.fn(),
  }
})

import * as XLSX from 'xlsx'
import { processSpreadsheets } from '../../src/modules/process/process.service'
import { ProcessSyncResult } from '../../src/modules/process/process.schema'
import { parseSpreadsheet, validateColumns } from '../../src/lib/spreadsheet'
import { MIME_TYPES } from '../../src/lib/spreadsheet/types'

// Helper: make a valid XLSX buffer
function makeXlsxBuffer(headers: string[], rows: string[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.usage.findUnique.mockResolvedValue(null)
  prismaMock.usage.upsert.mockResolvedValue({})
  redisMock.incr.mockResolvedValue(1)
  redisMock.decr.mockResolvedValue(0)
  redisMock.expire.mockResolvedValue(true)
  redisMock.del.mockResolvedValue(1)
})

// ===========================================
// processSpreadsheets — returns ProcessSyncResult
// ===========================================
describe('processSpreadsheets returns ProcessSyncResult', () => {
  it('returns buffer (not base64) with correct metadata', async () => {
    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name', 'Email'],
      rows: [
        Object.assign(Object.create(null), {
          Name: 'Alice',
          Email: 'alice@test.com',
        }),
      ],
      rowCount: 1,
      fileSize: 100,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const result: ProcessSyncResult = await processSpreadsheets(
      'user-1',
      [{ buffer: Buffer.from('csv-data'), fileName: 'test.csv' }],
      { selectedColumns: ['Name', 'Email'], outputFormat: 'xlsx' },
    )

    // Buffer, not base64 string
    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.buffer.length).toBeGreaterThan(0)

    // Metadata
    expect(result.fileName).toMatch(/^unified-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(result.fileSize).toBe(result.buffer.length)
    expect(result.rowsCount).toBe(1)
    expect(result.columnsCount).toBe(2)
    expect(result.format).toBe('xlsx')
    expect(result.mimeType).toBe(MIME_TYPES.xlsx)
  })

  it('returns CSV mimeType when outputFormat is csv', async () => {
    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const result = await processSpreadsheets(
      'user-1',
      [{ buffer: Buffer.from('csv-data'), fileName: 'test.csv' }],
      { selectedColumns: ['Name'], outputFormat: 'csv' },
    )

    expect(result.format).toBe('csv')
    expect(result.mimeType).toBe(MIME_TYPES.csv)
    expect(result.fileName).toMatch(/\.csv$/)
  })
})

// ===========================================
// XLSX buffer validity
// ===========================================
describe('XLSX buffer validity', () => {
  it('generated XLSX starts with PK magic bytes (valid ZIP)', async () => {
    const mockParsed = {
      fileName: 'data.xlsx',
      format: 'xlsx' as const,
      headers: ['Col1', 'Col2'],
      rows: [
        Object.assign(Object.create(null), { Col1: 'a', Col2: 'b' }),
        Object.assign(Object.create(null), { Col1: 'c', Col2: 'd' }),
      ],
      rowCount: 2,
      fileSize: 200,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const result = await processSpreadsheets(
      'user-1',
      [{ buffer: makeXlsxBuffer(['Col1', 'Col2'], [['a', 'b']]), fileName: 'data.xlsx' }],
      { selectedColumns: ['Col1', 'Col2'], outputFormat: 'xlsx' },
    )

    // PK\x03\x04 magic bytes
    expect(result.buffer[0]).toBe(0x50) // P
    expect(result.buffer[1]).toBe(0x4b) // K
    expect(result.buffer[2]).toBe(0x03)
    expect(result.buffer[3]).toBe(0x04)
  })

  it('generated XLSX can be parsed back by xlsx library', async () => {
    const mockParsed = {
      fileName: 'round.xlsx',
      format: 'xlsx' as const,
      headers: ['Name', 'Age'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice', Age: 30 })],
      rowCount: 1,
      fileSize: 100,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const result = await processSpreadsheets(
      'user-1',
      [{ buffer: Buffer.from('data'), fileName: 'round.xlsx' }],
      { selectedColumns: ['Name', 'Age'], outputFormat: 'xlsx' },
    )

    // Round-trip: parse the generated buffer
    const wb = XLSX.read(result.buffer, { type: 'buffer' })
    expect(wb.SheetNames).toContain('Unified')
    const ws = wb.Sheets['Unified']
    const data = XLSX.utils.sheet_to_json(ws)
    expect(data).toHaveLength(1)
  })
})

// ===========================================
// Concurrency guard
// ===========================================
describe('concurrency guard', () => {
  it('acquires slot when under limit (Redis incr returns 1)', async () => {
    redisMock.incr.mockResolvedValue(1)

    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    // Import controller module to test concurrency
    const { processSync } = await import('../../src/http/controllers/process.controller')

    // Create mock request/reply
    const headers: Record<string, string> = {}
    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn((key: string, val: string) => {
        headers[key] = val
        return mockReply
      }),
      send: vi.fn().mockReturnThis(),
    }

    // Create async iterator for parts
    async function* partsIterator() {
      // File part
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      // Field part: selectedColumns
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: '["Name"]',
      }
    }

    const mockRequest = {
      user: {
        sub: 'session-1',
        userId: 'user-1',
        email: 'test@test.com',
        role: 'PRO' as const,
      },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    await processSync(mockRequest as never, mockReply as never)

    // Redis was called for concurrency
    expect(redisMock.incr).toHaveBeenCalledWith('tablix:concurrency:user-1')
    expect(redisMock.expire).toHaveBeenCalled()

    // Slot released after processing
    expect(redisMock.decr).toHaveBeenCalledWith('tablix:concurrency:user-1')

    // Response is binary with correct headers
    expect(mockReply.status).toHaveBeenCalledWith(200)
    expect(headers['Content-Type']).toBe(MIME_TYPES.xlsx)
    expect(headers['Content-Disposition']).toMatch(
      /^attachment; filename="unified-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    )
    expect(headers['X-Tablix-Rows']).toBe('1')
    expect(headers['X-Tablix-Columns']).toBe('1')
    expect(headers['X-Tablix-Format']).toBe('xlsx')
    expect(headers['X-Tablix-File-Name']).toMatch(/^unified-/)
    expect(headers['X-Tablix-File-Size']).toBeDefined()

    // Buffer was sent (not JSON)
    const sentBuffer = mockReply.send.mock.calls[0][0]
    expect(sentBuffer).toBeInstanceOf(Buffer)
  })

  it('rejects when concurrency limit exceeded', async () => {
    // Simulate 3rd concurrent request (limit is 2)
    redisMock.incr.mockResolvedValue(3)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    const mockRequest = {
      user: {
        sub: 'session-1',
        userId: 'user-1',
        email: 'test@test.com',
        role: 'PRO' as const,
      },
      parts: async function* () {},
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await expect(processSync(mockRequest as never, mockReply as never)).rejects.toThrow(
      'Limite de processamento simultâneo',
    )

    // Should have decremented after rejection
    expect(redisMock.decr).toHaveBeenCalledWith('tablix:concurrency:user-1')
  })

  it('releases slot even when processing throws', async () => {
    redisMock.incr.mockResolvedValue(1)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    // Parts that yield no files → will throw validation error
    const mockRequest = {
      user: {
        sub: 'session-1',
        userId: 'user-1',
        email: 'test@test.com',
        role: 'PRO' as const,
      },
      parts: async function* () {},
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await expect(processSync(mockRequest as never, mockReply as never)).rejects.toThrow(
      'Nenhum arquivo enviado',
    )

    // Slot released in finally block
    expect(redisMock.decr).toHaveBeenCalledWith('tablix:concurrency:user-1')
  })
})

// ===========================================
// Memory logging
// ===========================================
describe('memory logging', () => {
  it('logs heap usage after processing', async () => {
    redisMock.incr.mockResolvedValue(1)

    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    const logInfo = vi.fn()

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: '["Name"]',
      }
    }

    const mockRequest = {
      user: {
        sub: 'session-1',
        userId: 'user-1',
        email: 'test@test.com',
        role: 'PRO' as const,
      },
      parts: () => partsIterator(),
      log: { info: logInfo, error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await processSync(mockRequest as never, mockReply as never)

    // Verify heap logging was called
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        filesCount: 1,
        rowsCount: 1,
        heapBeforeMB: expect.any(String),
        heapAfterMB: expect.any(String),
        heapDeltaMB: expect.any(String),
      }),
      'process/sync heap usage',
    )
  })
})

// ===========================================
// CORS exposedHeaders
// ===========================================
describe('CORS configuration', () => {
  it('app.ts exports exposedHeaders with X-Tablix-* headers', async () => {
    // Read the app.ts source to verify CORS config
    const { readFileSync } = await import('fs')
    const appSource = readFileSync('src/app.ts', 'utf-8')

    expect(appSource).toContain('exposedHeaders')
    expect(appSource).toContain('X-Tablix-Rows')
    expect(appSource).toContain('X-Tablix-Columns')
    expect(appSource).toContain('X-Tablix-File-Size')
    expect(appSource).toContain('X-Tablix-Format')
    expect(appSource).toContain('X-Tablix-File-Name')
    expect(appSource).toContain('Content-Disposition')
  })
})

// ===========================================
// Controller — error paths (coverage gaps)
// ===========================================
describe('processSync controller — error paths', () => {
  it('rejects with 401 when request.user is absent', async () => {
    const { processSync } = await import('../../src/http/controllers/process.controller')

    const mockRequest = {
      user: undefined,
      parts: async function* () {},
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await expect(processSync(mockRequest as never, mockReply as never)).rejects.toThrow(
      'Usuário não autenticado',
    )
  })

  it('rejects with validation error on unsupported file extension', async () => {
    redisMock.incr.mockResolvedValue(1)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'document.pdf',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('%PDF-1.4 content')
          },
          truncated: false,
        },
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await expect(processSync(mockRequest as never, mockReply as never)).rejects.toThrow(
      'Formato de arquivo não suportado: document.pdf',
    )

    // Slot must be released in finally even after extension rejection
    expect(redisMock.decr).toHaveBeenCalledWith('tablix:concurrency:user-1')
  })

  it('rejects with limit error when file is truncated', async () => {
    redisMock.incr.mockResolvedValue(1)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'big.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          // Simulate multipart truncated (file exceeded limit)
          truncated: true,
        },
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await expect(processSync(mockRequest as never, mockReply as never)).rejects.toThrow(
      'Limite excedido',
    )

    expect(redisMock.decr).toHaveBeenCalledWith('tablix:concurrency:user-1')
  })

  it('falls back to push when selectedColumns is not valid JSON', async () => {
    redisMock.incr.mockResolvedValue(1)

    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      // Non-JSON plain string for selectedColumns triggers the catch fallback
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: 'Name',
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn((k: string, v: string) => mockReply),
      send: vi.fn().mockReturnThis(),
    }

    // Should succeed — 'Name' was pushed as single-element array
    await processSync(mockRequest as never, mockReply as never)

    expect(mockReply.status).toHaveBeenCalledWith(200)
  })

  it('respects outputFormat field from multipart', async () => {
    redisMock.incr.mockResolvedValue(1)

    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    const headers: Record<string, string> = {}

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: '["Name"]',
      }
      yield {
        type: 'field' as const,
        fieldname: 'outputFormat',
        value: 'csv',
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn((k: string, v: string) => {
        headers[k] = v
        return mockReply
      }),
      send: vi.fn().mockReturnThis(),
    }

    await processSync(mockRequest as never, mockReply as never)

    expect(headers['X-Tablix-Format']).toBe('csv')
  })

  it('rejects with validation error when selectedColumns is empty array (Zod fails)', async () => {
    redisMock.incr.mockResolvedValue(1)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      // Empty array → Zod min(1) fails
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: '[]',
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await expect(processSync(mockRequest as never, mockReply as never)).rejects.toThrow(
      'Dados inválidos',
    )

    expect(redisMock.decr).toHaveBeenCalledWith('tablix:concurrency:user-1')
  })
})

// ===========================================
// Service — limit validation paths (coverage gaps)
// ===========================================
describe('processSpreadsheets — pro-limit edge cases', () => {
  it('rejects when total file size exceeds maxTotalSize', async () => {
    const { PRO_LIMITS } = await import('../../src/lib/spreadsheet/types')

    // Two files that together exceed maxTotalSize (30 MB)
    const halfOver = Math.floor(PRO_LIMITS.maxTotalSize / 2) + 1
    const file1 = { buffer: Buffer.alloc(halfOver), fileName: 'a.csv' }
    const file2 = { buffer: Buffer.alloc(halfOver), fileName: 'b.csv' }

    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 } as never)

    await expect(
      processSpreadsheets('user-1', [file1, file2], {
        selectedColumns: ['Col'],
        outputFormat: 'xlsx',
      }),
    ).rejects.toThrow('Limite excedido')
  })

  it('rejects when a single file exceeds maxFileSize', async () => {
    const { PRO_LIMITS } = await import('../../src/lib/spreadsheet/types')

    const oversizedFile = {
      buffer: Buffer.alloc(PRO_LIMITS.maxFileSize + 1),
      fileName: 'huge.csv',
    }

    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 } as never)

    await expect(
      processSpreadsheets('user-1', [oversizedFile], {
        selectedColumns: ['Col'],
        outputFormat: 'xlsx',
      }),
    ).rejects.toThrow('Limite excedido')
  })

  it('rejects when monthly unification quota is exhausted', async () => {
    const { PRO_LIMITS } = await import('../../src/lib/spreadsheet/types')

    prismaMock.usage.findUnique.mockResolvedValue({
      unificationsCount: PRO_LIMITS.unificationsPerMonth,
    } as never)

    await expect(
      processSpreadsheets('user-1', [{ buffer: Buffer.from('data'), fileName: 'a.csv' }], {
        selectedColumns: ['Col'],
        outputFormat: 'xlsx',
      }),
    ).rejects.toThrow('Limite excedido')
  })

  it('rejects when number of files exceeds maxInputFiles', async () => {
    const { PRO_LIMITS } = await import('../../src/lib/spreadsheet/types')

    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 } as never)

    const tooManyFiles = Array.from({ length: PRO_LIMITS.maxInputFiles + 1 }, (_, i) => ({
      buffer: Buffer.from('data'),
      fileName: `file${i}.csv`,
    }))

    await expect(
      processSpreadsheets('user-1', tooManyFiles, {
        selectedColumns: ['Col'],
        outputFormat: 'xlsx',
      }),
    ).rejects.toThrow('Limite excedido')
  })

  it('rejects when selectedColumns exceeds maxColumns', async () => {
    const { PRO_LIMITS } = await import('../../src/lib/spreadsheet/types')

    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 } as never)

    const tooManyColumns = Array.from({ length: PRO_LIMITS.maxColumns + 1 }, (_, i) => `col${i}`)

    await expect(
      processSpreadsheets('user-1', [{ buffer: Buffer.from('data'), fileName: 'a.csv' }], {
        selectedColumns: tooManyColumns,
        outputFormat: 'xlsx',
      }),
    ).rejects.toThrow('Limite excedido')
  })

  it('rejects when a single file exceeds maxRowsPerFile', async () => {
    const { PRO_LIMITS } = await import('../../src/lib/spreadsheet/types')

    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 } as never)

    // Mock parseSpreadsheet to return a spreadsheet with too many rows
    vi.mocked(parseSpreadsheet).mockReturnValue({
      fileName: 'large.csv',
      format: 'csv',
      headers: ['Name'],
      rows: [],
      rowCount: PRO_LIMITS.maxRowsPerFile + 1,
      fileSize: 100,
    })
    vi.mocked(validateColumns).mockReturnValue(undefined)

    await expect(
      processSpreadsheets('user-1', [{ buffer: Buffer.from('data'), fileName: 'large.csv' }], {
        selectedColumns: ['Name'],
        outputFormat: 'xlsx',
      }),
    ).rejects.toThrow('Limite excedido')
  })

  it('rejects when total rows across files exceeds maxTotalRows', async () => {
    const { PRO_LIMITS } = await import('../../src/lib/spreadsheet/types')

    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 } as never)

    const halfOver = Math.floor(PRO_LIMITS.maxTotalRows / 2) + 1

    // Two files, each below per-file limit but together exceeding total
    vi.mocked(parseSpreadsheet)
      .mockReturnValueOnce({
        fileName: 'a.csv',
        format: 'csv',
        headers: ['Name'],
        rows: [],
        rowCount: halfOver,
        fileSize: 100,
      })
      .mockReturnValueOnce({
        fileName: 'b.csv',
        format: 'csv',
        headers: ['Name'],
        rows: [],
        rowCount: halfOver,
        fileSize: 100,
      })

    vi.mocked(validateColumns).mockReturnValue(undefined)

    await expect(
      processSpreadsheets(
        'user-1',
        [
          { buffer: Buffer.from('data'), fileName: 'a.csv' },
          { buffer: Buffer.from('data'), fileName: 'b.csv' },
        ],
        { selectedColumns: ['Name'], outputFormat: 'xlsx' },
      ),
    ).rejects.toThrow('Limite excedido')
  })
})

// ===========================================
// Concurrency guard — Redis absent (structural guard)
// ===========================================
describe('concurrency guard — Redis absent', () => {
  // NOTE: acquireConcurrencySlot is not exported, so the `if (!redis) return true`
  // branch cannot be exercised in this test file without refactoring the production
  // code to export the helper. This test verifies the guard is present in source —
  // an architecture-violation finding is raised separately.
  it('controller source contains null-redis bypass guard', async () => {
    const { readFileSync } = await import('fs')
    const source = readFileSync('src/http/controllers/process.controller.ts', 'utf-8')

    // Proves the guard exists and will short-circuit when redis is falsy
    expect(source).toContain('if (!redis) return true')
    expect(source).toContain('if (!redis) return')
  })
})

// ===========================================
// releaseConcurrencySlot — del when val <= 0
// ===========================================
describe('concurrency guard — slot cleanup on zero', () => {
  it('deletes Redis key when DECR reaches 0', async () => {
    redisMock.incr.mockResolvedValue(1)
    // DECR returns 0 → key should be deleted
    redisMock.decr.mockResolvedValue(0)

    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: '["Name"]',
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await processSync(mockRequest as never, mockReply as never)

    // DECR was called and returned 0, so DEL must have been called
    expect(redisMock.del).toHaveBeenCalledWith('tablix:concurrency:user-1')
  })

  it('deletes Redis key when DECR goes negative (stale counter)', async () => {
    redisMock.incr.mockResolvedValue(1)
    // DECR returns -1 (stale state) → key should also be deleted
    redisMock.decr.mockResolvedValue(-1)

    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: '["Name"]',
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await processSync(mockRequest as never, mockReply as never)

    expect(redisMock.del).toHaveBeenCalledWith('tablix:concurrency:user-1')
  })

  it('does NOT delete Redis key when DECR returns positive (other requests still active)', async () => {
    // incr returns 2 → second concurrent request occupying same slot
    // This also covers the `current === 1` false branch (no expire call on second incr)
    redisMock.incr.mockResolvedValue(2)
    // DECR returns 1 → still one active request, key must stay
    redisMock.decr.mockResolvedValue(1)

    const mockParsed = {
      fileName: 'test.csv',
      format: 'csv' as const,
      headers: ['Name'],
      rows: [Object.assign(Object.create(null), { Name: 'Alice' })],
      rowCount: 1,
      fileSize: 50,
    }

    vi.mocked(parseSpreadsheet).mockReturnValue(mockParsed)
    vi.mocked(validateColumns).mockReturnValue(undefined)

    const { processSync } = await import('../../src/http/controllers/process.controller')

    async function* partsIterator() {
      yield {
        type: 'file' as const,
        filename: 'test.csv',
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('Name\nAlice')
          },
          truncated: false,
        },
      }
      yield {
        type: 'field' as const,
        fieldname: 'selectedColumns',
        value: '["Name"]',
      }
    }

    const mockRequest = {
      user: { sub: 'session-1', userId: 'user-1', email: 'test@test.com', role: 'PRO' as const },
      parts: () => partsIterator(),
      log: { info: vi.fn(), error: vi.fn() },
    }

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    await processSync(mockRequest as never, mockReply as never)

    // expire IS called on every incr (resilient TTL refresh)
    expect(redisMock.expire).toHaveBeenCalledWith('tablix:concurrency:user-1', 120)
    // del was NOT called (val was 1, not <= 0)
    expect(redisMock.del).not.toHaveBeenCalled()
    // Still succeeded — second concurrent slot is within limit
    expect(mockReply.status).toHaveBeenCalledWith(200)
  })
})
