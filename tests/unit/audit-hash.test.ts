/**
 * Card #150 — Teste do hash freezed v1 com VETOR FIXO conhecido.
 *
 * Este teste é o GUARDIÃO do contrato de 5 anos. Quebra deste teste
 * significa que rows antigos da tabela audit_log_legal viram inauditáveis
 * (não conseguem mais correlacionar via resource_hash).
 *
 * NUNCA atualizar os vetores fixos — eles representam a fórmula histórica
 * gravada no DB. Se precisar mudar a fórmula, criar v2 (função separada,
 * nunca mutar v1) e adicionar testes V2 separados.
 *
 * Vetores foram computados manualmente uma vez e congelados aqui.
 *
 * @owner: @security
 * @card: #150
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { HASH_RESOURCE_VERSION, hashResourceV1 } from '../../src/lib/audit-hash'
import { RESOURCE_HASH_ALGO_V1 } from '../../src/modules/audit-legal/audit-legal.types'

describe('hashResourceV1 (FREEZED — não mudar)', () => {
  describe('contrato de 5 anos: vetores fixos', () => {
    // Vetor 1: caso típico (UUID v4 + path user-scoped)
    it('vetor 1 — UUID + path simples', () => {
      const userId = '11111111-1111-4111-8111-111111111111'
      const storagePath = '11111111-1111-4111-8111-111111111111/file.csv'

      const hash = hashResourceV1(userId, storagePath)

      // Computado uma vez via:
      //   echo -n "11111111-1111-4111-8111-111111111111:11111111-1111-4111-8111-111111111111/file.csv" | sha256sum
      expect(hash.toString('hex')).toBe(
        'fa83e5bb5d943c51c4828f7d5b409490d585eb98fd85af40f7f49247ee8a6521',
      )
    })

    // Vetor 2: caso com filename complexo
    it('vetor 2 — UUID + path com extensão xlsx', () => {
      const userId = '22222222-2222-4222-8222-222222222222'
      const storagePath =
        '22222222-2222-4222-8222-222222222222/relatorio_2026.xlsx'

      const hash = hashResourceV1(userId, storagePath)

      expect(hash.toString('hex')).toBe(
        '00238cfd4c87eca26aaf5202400b03d634a4287d7fe58ed59dbd35a619c4c9d0',
      )
    })

    // Vetor 3: caso edge — caracteres especiais no nome
    it('vetor 3 — path com caracteres especiais no filename', () => {
      const userId = '33333333-3333-4333-8333-333333333333'
      const storagePath =
        '33333333-3333-4333-8333-333333333333/dados-2026_v2.csv'

      const hash = hashResourceV1(userId, storagePath)

      expect(hash.toString('hex')).toBe(
        'c464d91ed0255d2fffcd4d65f27a944f43ad6cfc1d885777151ecc4d73529ee5',
      )
    })
  })

  describe('propriedades invariantes', () => {
    it('retorna Buffer de exatamente 32 bytes (SHA-256)', () => {
      const hash = hashResourceV1('user', 'path')
      expect(hash).toBeInstanceOf(Buffer)
      expect(hash.byteLength).toBe(32)
    })

    it('é determinística — mesmas entradas, mesmo hash', () => {
      const a = hashResourceV1('user-x', 'user-x/file.csv')
      const b = hashResourceV1('user-x', 'user-x/file.csv')
      expect(a.equals(b)).toBe(true)
    })

    it('hash sensível ao userId (anti-colisão cross-tenant)', () => {
      const a = hashResourceV1('user-A', 'shared/file.csv')
      const b = hashResourceV1('user-B', 'shared/file.csv')
      expect(a.equals(b)).toBe(false)
    })

    it('hash sensível ao storagePath', () => {
      const a = hashResourceV1('user-x', 'user-x/a.csv')
      const b = hashResourceV1('user-x', 'user-x/b.csv')
      expect(a.equals(b)).toBe(false)
    })

    it('separador `:` previne ambiguidade entre userId e path', () => {
      // Sem o separador, hashResource("ab", "cd") == hashResource("a", "bcd").
      // Com `:`, "ab:cd" != "a:bcd".
      const a = hashResourceV1('ab', 'cd')
      const b = hashResourceV1('a', 'bcd')
      expect(a.equals(b)).toBe(false)
    })
  })

  describe('versionamento', () => {
    it('exporta versão v1 alinhada com RESOURCE_HASH_ALGO_V1', () => {
      expect(HASH_RESOURCE_VERSION).toBe(RESOURCE_HASH_ALGO_V1)
      expect(HASH_RESOURCE_VERSION).toBe('sha256v1')
    })
  })

  // ============================================================================
  // Property-based testing (Card #150 fix-pack F-MED-PROPERTY-BASED)
  // ============================================================================
  // fast-check valida invariantes em N casos gerados — pega mutações sutis
  // que vetores fixos não cobrem (ex: "se path começa com `/`, prefixa userId
  // duplo" passaria nos 3 vetores fixos, mas property-based pega).
  describe('propriedades (fast-check, seed fixo)', () => {
    const fcOpts = { seed: 42, numRuns: 100 }

    it('sempre retorna 32 bytes', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (userId, path) => {
          return hashResourceV1(userId, path).byteLength === 32
        }),
        fcOpts,
      )
    })

    it('é determinística (mesmas entradas → mesmo hash)', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (userId, path) => {
          return hashResourceV1(userId, path).equals(
            hashResourceV1(userId, path),
          )
        }),
        fcOpts,
      )
    })

    it('inputs distintos (userId, path) não colidem (anti-colisão prática)', () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.string(),
          fc.string(),
          fc.string(),
          (a, b, c, d) => {
            // Pré-condição: pares (a,b) e (c,d) são distintos
            fc.pre(a !== c || b !== d)
            return !hashResourceV1(a, b).equals(hashResourceV1(c, d))
          },
        ),
        fcOpts,
      )
    })

    it('hash não vaza userId em texto plano (não-reversibilidade trivial)', () => {
      fc.assert(
        fc.property(
          fc
            .string({ minLength: 8, maxLength: 64 })
            // garante que userId não consegue colidir trivialmente como hex
            .filter((s) => !/^[0-9a-f]{0,16}$/i.test(s)),
          fc.string(),
          (userId, path) => {
            const hex = hashResourceV1(userId, path).toString('hex')
            return !hex.includes(userId)
          },
        ),
        fcOpts,
      )
    })
  })
})
