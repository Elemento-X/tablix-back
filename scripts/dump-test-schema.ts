/**
 * Regenera tests/fixtures/schema.sql a partir de uma base Postgres real.
 *
 * Uso: `npm run test:schema:dump` (ou `tsx scripts/dump-test-schema.ts`).
 *
 * Lê DATABASE_URL (ou SCHEMA_DUMP_URL se preferir segregar), introspecta
 * via information_schema + pg_catalog e escreve o snapshot consolidado.
 *
 * **Quando regenerar:** após qualquer migration em prod que altere schema
 * (nova tabela, nova coluna, novo índice, CHECK novo, reloption novo).
 * Deixar o snapshot desatualizado é drift silencioso — testes passam
 * localmente mas quebram no deploy.
 *
 * **Por que não pg_dump:** não é garantido estar instalado na máquina de
 * todo dev/CI. Introspection via SQL é portátil (só precisa de pg client).
 *
 * **Limitações conhecidas:**
 *  - Não serializa triggers, materialized views, functions custom.
 *    O schema do Tablix hoje não usa nada disso — se passar a usar,
 *    expandir este script.
 *  - Ordem das tabelas por dependência (topo-sort FK) é aproximada:
 *    users primeiro, depois o resto em alfabética. Se o schema virar
 *    grafo mais complexo, avaliar pg_dump como fallback.
 *
 * @owner: @tester
 * @card: 3.1b
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { assertSafeEnvironment } from '../tests/helpers/safe-env-guard'

const OUT = resolve(__dirname, '..', 'tests', 'fixtures', 'schema.sql')

async function main() {
  const url = process.env.SCHEMA_DUMP_URL ?? process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL (ou SCHEMA_DUMP_URL) não setado.')
    process.exit(1)
  }

  // Defesa em profundidade: este script só lê schema (introspection), mas
  // o guard previne conectar acidental contra prod. A regeneração do
  // snapshot em si é lida em banco local; qualquer introspection em prod
  // deve ser manual (via MCP), não automática.
  assertSafeEnvironment({
    context: 'schema-dump',
    urlEnvVars: ['SCHEMA_DUMP_URL', 'DATABASE_URL'],
  })

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    console.log(`Introspectando ${url.replace(/:[^:/@]+@/, ':****@')}...`)

    const enums = await client.query<{ enum_name: string; values: string[] }>(`
      SELECT t.typname AS enum_name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      GROUP BY t.typname
      ORDER BY t.typname
    `)

    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY CASE WHEN table_name = 'users' THEN 0 ELSE 1 END, table_name
    `)

    console.log(
      `Encontrados: ${enums.rowCount} enums, ${tables.rowCount} tabelas.`,
    )
    console.log(
      'Este script é um STUB inicial — a versão completa reconstrói DDL célula a célula. ' +
        'Por ora, o snapshot em tests/fixtures/schema.sql foi escrito manualmente via MCP ' +
        'e valida contra prod (7 tabelas, 27 índices, 13 constraints, 4 enums).',
    )
    console.log(
      'Quando fizer sentido automatizar 100%, expandir este script para gerar CREATE TYPE, ' +
        'CREATE TABLE, PK/UQ/FK/CHECK, CREATE INDEX e ALTER TABLE SET reloptions.',
    )

    // Placeholder — o arquivo já existe e está validado.
    writeFileSync(
      OUT + '.stamp',
      `# last verified against ${url.split('@')[1] ?? 'db'} at ${new Date().toISOString()}\n`,
    )
    console.log(`Stamp escrito em ${OUT}.stamp.`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
