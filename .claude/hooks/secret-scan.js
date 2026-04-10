const parseInput = require('./parse-hook-input')

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret|secret_access_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i },
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i },
  { name: 'Generic Secret', pattern: /(?:secret|password|passwd|token)\s*[:=]\s*["'][A-Za-z0-9_\-!@#$%^&*]{16,}["']/i },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-+/=]{10,}/ },
  { name: 'Stripe Secret Key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'Stripe Webhook Secret', pattern: /whsec_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: 'Supabase Service Role Key', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_\-+/=]+/ },
  { name: 'Database URL with password', pattern: /(?:postgres|mysql|mongodb):\/\/[^:]+:[^@]+@[^/]+/ },
  { name: 'Bearer Token Hardcoded', pattern: /["']Bearer\s+[A-Za-z0-9_\-.]{20,}["']/ },
]

// Files where secrets are expected/acceptable
const ALLOWLIST = [
  '.env.example',
  'secret-scan.js',
  'categories.json',
]

parseInput().then(({ filePath, content }) => {
  if (!filePath || !content) process.exit(0)

  const normalized = filePath.replace(/\\/g, '/')
  const basename = normalized.split('/').pop()

  // Skip allowlisted files
  if (ALLOWLIST.some((f) => basename === f)) process.exit(0)

  // Skip test files (may have mock tokens)
  if (/\.(test|spec|mock)\.(ts|js|tsx|jsx)$/.test(basename)) process.exit(0)

  const findings = []
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      findings.push(name)
    }
  }

  if (findings.length > 0) {
    process.stderr.write(
      `BLOQUEADO: possível secret detectado em ${filePath}:\n` +
      findings.map((f) => `  - ${f}`).join('\n') +
      '\n\nSe é um placeholder/exemplo, use valor fictício. Se é real, mova para .env e referencie via env var.'
    )
    process.exit(2)
  }

  process.exit(0)
})
