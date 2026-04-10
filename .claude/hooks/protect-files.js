const parseInput = require('./parse-hook-input')

parseInput().then(({ filePath }) => {
  if (!filePath) process.exit(0)

  const normalized = filePath.replace(/\\/g, '/')
  const basename = normalized.split('/').pop()

  // Exact filename matches
  const blockedFiles = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    '.env.staging',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ]

  // Directory/path patterns (contains check)
  const blockedPaths = [
    '.git/',
    'node_modules/',
    'prisma/migrations/',
  ]

  // Extension patterns
  const blockedExtensions = [
    '.pem',
    '.key',
    '.p12',
    '.pfx',
    '.jks',
  ]

  // Exact filename match
  const fileMatch = blockedFiles.find((f) => basename === f)
  if (fileMatch) {
    process.stderr.write(`BLOQUEADO: ${filePath} é arquivo protegido (${fileMatch}). Edição manual proibida.`)
    process.exit(2)
  }

  // Path contains match
  const pathMatch = blockedPaths.find((p) => normalized.includes(p))
  if (pathMatch) {
    process.stderr.write(`BLOQUEADO: ${filePath} está em diretório protegido (${pathMatch}). Edição manual proibida.`)
    process.exit(2)
  }

  // Extension match
  const extMatch = blockedExtensions.find((ext) => basename.endsWith(ext))
  if (extMatch) {
    process.stderr.write(`BLOQUEADO: ${filePath} é arquivo sensível (${extMatch}). Nunca editar certificados/chaves diretamente.`)
    process.exit(2)
  }

  process.exit(0)
})
