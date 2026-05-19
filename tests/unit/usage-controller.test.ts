/**
 * Unit tests — src/http/controllers/usage.controller (Card 4.1 #33).
 *
 * Cobre:
 *  - getUsage: throws 401 quando request.user ausente
 *  - getUsage: happy path retorna envelope { data } com usage do user
 *  - getUsage: seta Cache-Control private no-cache + Vary Authorization
 *  - getLimits: throws 401 quando request.user ausente
 *  - getLimits: happy path retorna envelope { data: { plan, limits } }
 *  - getLimits: seta Cache-Control private max-age=60 + Vary Authorization
 *  - SECURITY: plano vem do JWT (request.user.role), nunca do client
 *
 * @owner: @tester
 * @card: 4.1 (#33)
 */
/* eslint-disable import/first */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetUserUsage, mockGetLimitsForPlanResponse } = vi.hoisted(() => ({
  mockGetUserUsage: vi.fn(),
  mockGetLimitsForPlanResponse: vi.fn(),
}))

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

vi.mock('../../src/modules/usage/usage.service', () => ({
  getUserUsage: mockGetUserUsage,
  getLimitsForPlanResponse: mockGetLimitsForPlanResponse,
}))

import {
  getUsage,
  getLimits,
} from '../../src/http/controllers/usage.controller'
import { AppError, ErrorCodes } from '../../src/errors/app-error'

interface MockReply {
  header: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function makeReply(): MockReply {
  const reply: MockReply = {
    header: vi.fn(),
    send: vi.fn().mockReturnValue(undefined),
  }
  return reply
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// getUsage
// ---------------------------------------------------------------------------
describe('getUsage', () => {
  it('throws UNAUTHORIZED quando request.user ausente', async () => {
    const reply = makeReply()
    const request = { user: undefined, headers: {} } as never

    await expect(getUsage(request, reply as never)).rejects.toThrow(AppError)
    await expect(getUsage(request, reply as never)).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHORIZED,
      statusCode: 401,
    })
    expect(mockGetUserUsage).not.toHaveBeenCalled()
  })

  it('happy path: chama service e retorna envelope { data }', async () => {
    const usage = {
      current: 5,
      limit: 30,
      remaining: 25,
      period: '2026-04',
      resetAt: '2026-05-01T00:00:00.000Z',
    }
    mockGetUserUsage.mockResolvedValueOnce(usage)

    const reply = makeReply()
    const request = {
      user: { userId: 'user-1', role: 'PRO' },
      headers: {},
    } as never

    await getUsage(request, reply as never)

    expect(mockGetUserUsage).toHaveBeenCalledWith('user-1', 'PRO')
    expect(reply.send).toHaveBeenCalledWith({ data: usage })
  })

  it('seta Cache-Control private,no-cache + Vary Authorization', async () => {
    mockGetUserUsage.mockResolvedValueOnce({
      current: 0,
      limit: 30,
      remaining: 30,
      period: '2026-04',
      resetAt: '2026-05-01T00:00:00.000Z',
    })

    const reply = makeReply()
    const request = {
      user: { userId: 'user-2', role: 'PRO' },
      headers: {},
    } as never

    await getUsage(request, reply as never)

    expect(reply.header).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-cache',
    )
    expect(reply.header).toHaveBeenCalledWith('Vary', 'Authorization')
  })

  it('SECURITY: plano vem do JWT (request.user.role), não do client', async () => {
    mockGetUserUsage.mockResolvedValueOnce({
      current: 0,
      limit: 1,
      remaining: 1,
      period: '2026-04',
      resetAt: '2026-05-01T00:00:00.000Z',
    })

    const reply = makeReply()
    // Cliente enviou 'PRO' tentando burlar — JWT diz 'FREE'
    const request = {
      user: { userId: 'attacker', role: 'FREE' },
      headers: {},
      body: { plan: 'PRO' }, // ignorado
    } as never

    await getUsage(request, reply as never)

    // Service foi chamado com 'FREE' do JWT, NÃO com 'PRO' do body
    expect(mockGetUserUsage).toHaveBeenCalledWith('attacker', 'FREE')
  })
})

// ---------------------------------------------------------------------------
// getLimits
// ---------------------------------------------------------------------------
describe('getLimits', () => {
  it('throws UNAUTHORIZED quando request.user ausente', async () => {
    const reply = makeReply()
    const request = { user: undefined, headers: {} } as never

    await expect(getLimits(request, reply as never)).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHORIZED,
      statusCode: 401,
    })
    expect(mockGetLimitsForPlanResponse).not.toHaveBeenCalled()
  })

  it('happy path: chama service e retorna envelope { data }', async () => {
    const data = {
      plan: 'PRO' as const,
      limits: {
        unificationsPerMonth: 30,
        maxInputFiles: 15,
        maxFileSize: 2_097_152,
        maxTotalSize: 31_457_280,
        maxRowsPerFile: 5_000,
        maxTotalRows: 75_000,
        maxColumns: 10,
        hasWatermark: false,
      },
    }
    mockGetLimitsForPlanResponse.mockReturnValueOnce(data)

    const reply = makeReply()
    const request = {
      user: { userId: 'user-1', role: 'PRO' },
      headers: {},
    } as never

    await getLimits(request, reply as never)

    expect(mockGetLimitsForPlanResponse).toHaveBeenCalledWith('PRO')
    expect(reply.send).toHaveBeenCalledWith({ data })
  })

  it('seta Cache-Control private max-age=60 + Vary Authorization', async () => {
    mockGetLimitsForPlanResponse.mockReturnValueOnce({
      plan: 'FREE',
      limits: {
        unificationsPerMonth: 1,
        maxInputFiles: 3,
        maxFileSize: 1_048_576,
        maxTotalSize: 1_048_576,
        maxRowsPerFile: 500,
        maxTotalRows: 500,
        maxColumns: 3,
        hasWatermark: true,
      },
    })

    const reply = makeReply()
    const request = {
      user: { userId: 'user-1', role: 'FREE' },
      headers: {},
    } as never

    await getLimits(request, reply as never)

    expect(reply.header).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=60',
    )
    expect(reply.header).toHaveBeenCalledWith('Vary', 'Authorization')
  })

  it('SECURITY: plano vem do JWT (request.user.role), não do query/body', async () => {
    mockGetLimitsForPlanResponse.mockReturnValueOnce({
      plan: 'FREE',
      limits: {
        unificationsPerMonth: 1,
        maxInputFiles: 3,
        maxFileSize: 1_048_576,
        maxTotalSize: 1_048_576,
        maxRowsPerFile: 500,
        maxTotalRows: 500,
        maxColumns: 3,
        hasWatermark: true,
      },
    })

    const reply = makeReply()
    // Cliente tentou enviar plan=PRO no query — ignorado
    const request = {
      user: { userId: 'attacker', role: 'FREE' },
      headers: {},
      query: { plan: 'PRO' }, // ignorado
    } as never

    await getLimits(request, reply as never)

    expect(mockGetLimitsForPlanResponse).toHaveBeenCalledWith('FREE')
  })
})
