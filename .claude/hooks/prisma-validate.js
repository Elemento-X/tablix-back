const { execSync } = require('child_process')
const parseInput = require('./parse-hook-input')

parseInput().then(({ filePath }) => {
  if (!filePath) process.exit(0)

  const normalized = filePath.replace(/\\/g, '/')
  if (!normalized.endsWith('schema.prisma')) process.exit(0)

  try {
    execSync('npx prisma validate', {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    })
  } catch (err) {
    const output = (err.stderr || err.stdout || '').trim()
    process.stderr.write(`Prisma schema inválido:\n${output}\n\nCorrija o schema antes de continuar.`)
    process.exit(2)
  }

  process.exit(0)
})
