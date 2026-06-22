/**
 * Unit tests do key-builder MULTI-INPUT (Card 6.2 — Fase 6 Fila Assíncrona).
 *
 * Cobre as funções novas:
 *   - toStorageJobKey: UUID v4 → strip hífens (32 hex); inválido → INVALID_JOB_ID
 *   - buildJobInputPath: subpasta por job (G-3), padding 2 dígitos,
 *     index boundary [0,99], ext whitelist, determinismo com `now`,
 *     path traversal defendido
 *   - buildJobOutputPath: caminho fixo output.{ext}
 *   - Cross-module: paths gerados passam em assertValidStoragePath (anti-drift
 *     builder ↔ validator)
 *
 * @owner: @tester
 * @card: 6.2 — Setup BullMQ + conexão Redis TCP (Fase 6)
 */
import { describe, expect, it } from 'vitest'
import {
  type AllowedExtension,
  ALLOWED_EXTENSIONS,
} from '../../src/lib/storage/types'
import {
  buildJobInputPath,
  buildJobOutputPath,
  toStorageJobKey,
} from '../../src/lib/storage/key-builder'
import { assertValidStoragePath } from '../../src/lib/storage/path-validator'

const VALID_USER_ID = 'a3b6f9c2-1d4e-4a8b-9c2d-3e5f7a9b1c4d'
// Job.id UUID v4 (versão 4, variant 8) → stripped = 32 hex lowercase.
const VALID_JOB_UUID = '8c7e1234-5678-4abc-89de-f01234567890'
const STRIPPED = '8c7e123456784abc89def01234567890'
const NOW = new Date(Date.UTC(2026, 5, 21, 12, 0, 0)) // 2026-06-21

// Regex que o JOB_ID_REGEX do key-builder aplica (32 hex passa).
const JOB_ID_REGEX = /^[a-z0-9]{7,64}$/

describe('toStorageJobKey', () => {
  it('UUID v4 válido → remove hífens → 32 hex lowercase', () => {
    expect(toStorageJobKey(VALID_JOB_UUID)).toBe(STRIPPED)
    expect(STRIPPED).toHaveLength(32)
  })

  it('o jobKey derivado passa no JOB_ID_REGEX (storage-safe por construção)', () => {
    expect(JOB_ID_REGEX.test(toStorageJobKey(VALID_JOB_UUID))).toBe(true)
  })

  it('é determinístico (mesma entrada → mesma saída)', () => {
    expect(toStorageJobKey(VALID_JOB_UUID)).toBe(
      toStorageJobKey(VALID_JOB_UUID),
    )
  })

  it('rejeita UUID inválido (não-v4) com INVALID_JOB_ID', () => {
    expect(() =>
      toStorageJobKey('8c7e1234-5678-1abc-89de-f01234567890'),
    ).toThrow(/valid UUID v4/)
  })

  it('rejeita UUID uppercase (RFC 4122 canonical lowercase)', () => {
    expect(() => toStorageJobKey(VALID_JOB_UUID.toUpperCase())).toThrow(
      /valid UUID v4/,
    )
  })

  it('rejeita string já sem hífens (não é UUID canônico)', () => {
    expect(() => toStorageJobKey(STRIPPED)).toThrow(/valid UUID v4/)
  })

  it('rejeita nil UUID', () => {
    expect(() =>
      toStorageJobKey('00000000-0000-0000-0000-000000000000'),
    ).toThrow(/valid UUID v4/)
  })

  it('rejeita string vazia', () => {
    expect(() => toStorageJobKey('')).toThrow(/valid UUID v4/)
  })

  it('rejeita non-string (null)', () => {
    // @ts-expect-error — defesa contra type abuse runtime
    expect(() => toStorageJobKey(null)).toThrow(/valid UUID v4/)
  })

  it('rejeita path traversal disfarçado de jobId', () => {
    expect(() => toStorageJobKey('../../etc/passwd')).toThrow(/valid UUID v4/)
  })
})

describe('buildJobInputPath — pattern e padding (G-3)', () => {
  it('monta {userId}/{date}/{jobKey}/input-NN.{ext}', () => {
    const path = buildJobInputPath({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      index: 5,
      ext: 'csv',
      now: NOW,
    })
    expect(path).toBe(`${VALID_USER_ID}/2026-06-21/${STRIPPED}/input-05.csv`)
  })

  it('padding de 2 dígitos: index 0 → input-00', () => {
    const path = buildJobInputPath({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      index: 0,
      ext: 'xlsx',
      now: NOW,
    })
    expect(path).toContain('/input-00.xlsx')
  })

  it('index 99 (teto) → input-99', () => {
    const path = buildJobInputPath({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      index: 99,
      ext: 'csv',
      now: NOW,
    })
    expect(path).toContain('/input-99.csv')
  })

  it.each(ALLOWED_EXTENSIONS)('cada ext permitida produz path: %s', (ext) => {
    const path = buildJobInputPath({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      index: 1,
      ext: ext as AllowedExtension,
      now: NOW,
    })
    expect(path).toContain(`/input-01.${ext}`)
  })

  it('determinístico com `now` injetado', () => {
    const args = {
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      index: 3,
      ext: 'csv' as AllowedExtension,
      now: NOW,
    }
    expect(buildJobInputPath(args)).toBe(buildJobInputPath(args))
  })
})

describe('buildJobInputPath — index boundary', () => {
  it('rejeita index negativo (-1)', () => {
    expect(() =>
      buildJobInputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        index: -1,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/input index/)
  })

  it('rejeita index acima do teto (100)', () => {
    expect(() =>
      buildJobInputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        index: 100,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/input index/)
  })

  it('rejeita index não-inteiro (0.5)', () => {
    expect(() =>
      buildJobInputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        index: 0.5,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/input index/)
  })

  it('rejeita index NaN', () => {
    expect(() =>
      buildJobInputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        index: Number.NaN,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/input index/)
  })

  it('rejeita index Infinity', () => {
    expect(() =>
      buildJobInputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        index: Number.POSITIVE_INFINITY,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/input index/)
  })
})

describe('buildJobInputPath — validação de input (defesa em profundidade)', () => {
  it('rejeita userId inválido antes de montar', () => {
    expect(() =>
      buildJobInputPath({
        userId: 'not-a-uuid',
        jobId: VALID_JOB_UUID,
        index: 0,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/UUID v4/)
  })

  it('rejeita userId com path traversal', () => {
    expect(() =>
      buildJobInputPath({
        userId: '../../etc',
        jobId: VALID_JOB_UUID,
        index: 0,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/UUID v4/)
  })

  it('rejeita jobId não-UUID (INVALID_JOB_ID via toStorageJobKey)', () => {
    expect(() =>
      buildJobInputPath({
        userId: VALID_USER_ID,
        jobId: 'not-a-uuid',
        index: 0,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/valid UUID v4/)
  })

  it('rejeita ext fora da whitelist', () => {
    expect(() =>
      buildJobInputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        index: 0,
        // @ts-expect-error — type abuse runtime
        ext: 'exe',
        now: NOW,
      }),
    ).toThrow(/ext must be one of/)
  })
})

describe('buildJobOutputPath', () => {
  it('monta {userId}/{date}/{jobKey}/output.{ext} (caminho fixo)', () => {
    const path = buildJobOutputPath({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      ext: 'xlsx',
      now: NOW,
    })
    expect(path).toBe(`${VALID_USER_ID}/2026-06-21/${STRIPPED}/output.xlsx`)
  })

  it.each(ALLOWED_EXTENSIONS)('cada ext produz output.%s', (ext) => {
    const path = buildJobOutputPath({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      ext: ext as AllowedExtension,
      now: NOW,
    })
    expect(path).toContain(`/output.${ext}`)
  })

  it('determinístico com `now` injetado', () => {
    const args = {
      userId: VALID_USER_ID,
      jobId: VALID_JOB_UUID,
      ext: 'csv' as AllowedExtension,
      now: NOW,
    }
    expect(buildJobOutputPath(args)).toBe(buildJobOutputPath(args))
  })

  it('rejeita userId inválido', () => {
    expect(() =>
      buildJobOutputPath({
        userId: 'bad',
        jobId: VALID_JOB_UUID,
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/UUID v4/)
  })

  it('rejeita jobId não-UUID', () => {
    expect(() =>
      buildJobOutputPath({
        userId: VALID_USER_ID,
        jobId: 'short',
        ext: 'csv',
        now: NOW,
      }),
    ).toThrow(/valid UUID v4/)
  })

  it('rejeita ext fora da whitelist', () => {
    expect(() =>
      buildJobOutputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        // @ts-expect-error — type abuse runtime
        ext: 'sh',
        now: NOW,
      }),
    ).toThrow(/ext must be one of/)
  })
})

describe('cross-module: paths gerados passam no validator (anti-drift)', () => {
  it('buildJobInputPath → assertValidStoragePath não lança', () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      for (const index of [0, 7, 99]) {
        const path = buildJobInputPath({
          userId: VALID_USER_ID,
          jobId: VALID_JOB_UUID,
          index,
          ext: ext as AllowedExtension,
          now: NOW,
        })
        expect(() => assertValidStoragePath(path)).not.toThrow()
      }
    }
  })

  it('buildJobOutputPath → assertValidStoragePath não lança', () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      const path = buildJobOutputPath({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_UUID,
        ext: ext as AllowedExtension,
        now: NOW,
      })
      expect(() => assertValidStoragePath(path)).not.toThrow()
    }
  })
})
