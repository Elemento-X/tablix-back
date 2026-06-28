/**
 * k6 — load test de POST /process/sync (Card #229 / Fase 7.5).
 *
 * Mede latência, taxa de 200/503 (cap #219), e roda um CANARY-PING paralelo em
 * /health/live (proxy de event-loop lag: o parse síncrono bloqueia o loop → o ping
 * atrasa). RSS é lido FORA daqui, em `fly logs` (`process/sync heap usage` → rssAfterMB)
 * + `fly machine status` (triangulação R-1).
 *
 * Pré-requisitos: `loadtest/seed.ts` rodado (gera .jwts.json) + `make-fixtures.ts`.
 * Topologia: rodar com `fly scale count web=1` nas ondas de calibração (R-4).
 *
 * Exemplos:
 *   # smoke 1 req (Fase 2 / gate S-1)
 *   bin/k6 run -e SCENARIO=smoke -e FIXTURE=fixtures/legit-max.xlsx \
 *     -e FIXTURE_NAME=legit-max.xlsx -e FIXTURE_TYPE=xlsx loadtest/sync.k6.js
 *   # ramp 0→8 VUs (Fase 3)
 *   bin/k6 run -e SCENARIO=ramp ... loadtest/sync.k6.js
 *   # sustained (Fase 3) / burst (Fase 4) / adversarial (Fase 5, FIXTURE=adversarial-wide.xlsx)
 */
import http from 'k6/http'
import { check } from 'k6'
import { SharedArray } from 'k6/data'
import { Trend, Counter } from 'k6/metrics'

const TARGET = __ENV.TARGET || 'https://tablix-back-staging.fly.dev'
const FIXTURE = __ENV.FIXTURE || 'fixtures/dense.xlsx'
const FIXTURE_NAME = __ENV.FIXTURE_NAME || 'dense.xlsx'
const FIXTURE_TYPE = __ENV.FIXTURE_TYPE || 'xlsx'
const SCENARIO = __ENV.SCENARIO || 'smoke'

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
}

// JWTs do pool (rotaciona entre VUs → respeita o guard per-user=2 distribuindo carga).
const jwts = new SharedArray('jwts', () =>
  JSON.parse(open('./.jwts.json')).map((e) => e.jwt),
)
const fileBin = open(FIXTURE, 'b')

const canaryMs = new Trend('canary_ping_ms', true)
const c503 = new Counter('sync_503')
const c200 = new Counter('sync_200')
const c4xx = new Counter('sync_4xx')

// Perfis de carga selecionáveis por -e SCENARIO. Canary sempre on em paralelo.
const PROFILES = {
  smoke: {
    executor: 'shared-iterations',
    vus: 1,
    iterations: 1,
    maxDuration: '2m',
  },
  ramp: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 8 },
      { duration: '30s', target: 8 },
    ],
  },
  sustained: {
    executor: 'constant-vus',
    vus: Number(__ENV.VUS || 5),
    duration: __ENV.DURATION || '8m',
  },
  burst: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '10s', target: Number(__ENV.VUS || 25) },
      { duration: '60s', target: Number(__ENV.VUS || 25) },
      { duration: '20s', target: 0 },
    ],
  },
  adversarial: {
    executor: 'constant-vus',
    vus: Number(__ENV.VUS || 3),
    duration: __ENV.DURATION || '2m',
  },
}

export const options = {
  scenarios: {
    load: { ...PROFILES[SCENARIO], exec: 'syncLoad', tags: { role: 'load' } },
    canary: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: PROFILES[SCENARIO].duration || '3m',
      preAllocatedVUs: 2,
      exec: 'canary',
      tags: { role: 'canary' },
    },
  },
  thresholds: {
    // Go/no-go: canary p95 (event-loop) e ausência de erro de servidor inesperado.
    'canary_ping_ms{role:canary}': ['p(95)<1500'],
    'http_req_failed{role:load}': ['rate<0.95'], // 503 sob burst é esperado; ajustar por onda
  },
}

const SELECTED = JSON.stringify(['col_1', 'col_2', 'col_3', 'col_4', 'col_5'])

export function syncLoad() {
  const jwt = jwts[(__VU - 1) % jwts.length]
  const res = http.post(
    `${TARGET}/process/sync`,
    {
      files: http.file(fileBin, FIXTURE_NAME, MIME[FIXTURE_TYPE]),
      selectedColumns: SELECTED,
      outputFormat: 'xlsx',
    },
    { headers: { Authorization: `Bearer ${jwt}` }, timeout: '120s' },
  )
  if (res.status === 200) c200.add(1)
  else if (res.status === 503) c503.add(1)
  else if (res.status >= 400 && res.status < 500) c4xx.add(1)
  check(res, {
    'status 200/503/4xx esperado': (r) =>
      r.status === 200 ||
      r.status === 503 ||
      (r.status >= 400 && r.status < 500),
    'sem 5xx inesperado (≠503)': (r) => !(r.status >= 500 && r.status !== 503),
    'Retry-After presente no 503': (r) =>
      r.status !== 503 || r.headers['Retry-After'] !== undefined,
  })
}

export function canary() {
  const res = http.get(`${TARGET}/health/live`)
  canaryMs.add(res.timings.duration)
  check(res, { 'canary 200': (r) => r.status === 200 })
}
