const { execSync } = require('child_process')
const parseInput = require('./parse-hook-input')

parseInput().then(({ filePath }) => {
  if (!filePath) process.exit(0)

  const normalized = filePath.replace(/\\/g, '/')
  if (!normalized.endsWith('schema.prisma')) process.exit(0)

  try {
    const prismaBin = require('path').resolve('node_modules', '.bin', 'prisma')
    const result = execSync(`"${prismaBin}" validate`, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: 'pipe',
    })
    // Prisma prints "is valid" on success
    if (result && result.includes('is valid')) process.exit(0)
  } catch (err) {
    const stdout = (err.stdout || '').trim()
    const stderr = (err.stderr || '').trim()
    // Filter out npm warn lines — only fail on actual Prisma errors
    const prismaErrors = [stdout, stderr]
      .join('\n')
      .split('\n')
      .filter((line) => !line.startsWith('npm warn') && line.trim())
      .join('\n')
      .trim()
    if (!prismaErrors || prismaErrors.includes('is valid')) process.exit(0)
    process.stderr.write(
      `Prisma schema inválido:\n${prismaErrors}\n\nCorrija o schema antes de continuar.`,
    )
    process.exit(2)
  }

  process.exit(0)
})
