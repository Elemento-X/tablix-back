/**
 * Gera as fixtures do load test (Card #229 / Fase 7.5) em loadtest/fixtures/.
 * Local, NÃO toca o store. Uso: tsx loadtest/make-fixtures.ts
 *
 * ⚠️ Constraint binding: maxFileSize = 2MB POR ARQUIVO. Com dados DISTINTOS isso amarra
 * ~50k células/arquivo (o legit é file-size-bound). O maxInputCells (1.5M) só é
 * alcançável com conteúdo REPETITIVO (compressível → muitas células em <2MB) OU
 * multi-file. Por isso os fixtures adversariais usam fill='repeat'.
 *
 * Fixtures:
 *  - typical.csv            — médio realista DISTINTO (5k × 8) ~0.3MB.
 *  - legit-realistic.xlsx   — pior caso LEGÍTIMO file-size-bound: DISTINTO, ~1.8MB
 *                             (mede RSS realista por arquivo; concorrência agrega).
 *  - dense.xlsx             — 5k × 100 = 500k células (single-file max: maxRowsPerFile ×
 *                             maxInputColumns), REPETITIVO → <2MB. Mede o pico do
 *                             XLSX.read denso + boundary por-arquivo. k6 single-file ×
 *                             concorrência=cap ≈ agregado de cap×500k em voo.
 *  - wide.xlsx              — 30 × 4000 col, REPETITIVO → <2MB. REJEITADO em
 *                             maxInputColumns ANTES do sheet_to_json (mede decompressão).
 *
 * cap-hit do maxInputCells (Σ>1.5M) = multi-file: curl com 4× -F files=@dense.xlsx (2M).
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import * as XLSX from 'xlsx'

const DIR = 'loadtest/fixtures'
mkdirSync(DIR, { recursive: true })

type Fill = 'distinct' | 'repeat'

function aoa(rows: number, cols: number, fill: Fill): unknown[][] {
  const header = Array.from({ length: cols }, (_, c) => `col_${c + 1}`)
  const data: unknown[][] = [header]
  for (let r = 0; r < rows; r++) {
    data.push(
      Array.from({ length: cols }, (_, c) =>
        fill === 'distinct' ? `v${r}_${c}` : 'x',
      ),
    )
  }
  return data
}

function csvBuf(rows: number, cols: number, fill: Fill): Buffer {
  return Buffer.from(
    aoa(rows, cols, fill)
      .map((row) => row.join(','))
      .join('\n'),
    'utf8',
  )
}

function xlsxBuf(rows: number, cols: number, fill: Fill): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa(rows, cols, fill))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  // compression: true → deflate no zip. Conteúdo repetitivo/denso vira <2MB
  // COMPRIMIDO mas descomprime num grid grande = exatamente o input adversarial
  // (caught por zip-bomb 100:1 + maxInputColumns/maxInputCells).
  return XLSX.write(wb, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  }) as Buffer
}

function emit(name: string, buf: Buffer): void {
  const path = `${DIR}/${name}`
  writeFileSync(path, buf)
  const mb = statSync(path).size / 1024 / 1024
  const flag = mb > 2 ? ' ⚠️ >2MB (maxFileSize) — reduzir!' : ''
  console.log(`[fixtures] ${name} — ${mb.toFixed(2)} MB${flag}`)
}

emit('typical.csv', csvBuf(5000, 8, 'distinct'))
emit('legit-realistic.xlsx', xlsxBuf(5000, 20, 'distinct'))
// dense: maior grid que cabe ≤2MB COMPRIMIDO (file-size-bound: 5k×100=500k dá 2.82MB).
// 4500×70 ≈ 315k células ~1.8MB. Operador pode empurrar até ~2MB no teste p/ o max real.
emit('dense.xlsx', xlsxBuf(4500, 70, 'repeat'))
emit('wide.xlsx', xlsxBuf(30, 4000, 'repeat'))

console.log(
  '[fixtures] prontas em loadtest/fixtures/ (validar que todas ≤ 2MB)',
)
