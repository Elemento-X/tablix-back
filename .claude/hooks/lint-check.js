const { execSync } = require('child_process')
const parseInput = require('./parse-hook-input')

parseInput().then(({ filePath }) => {
  if (!filePath || !/\.(ts|tsx|js|jsx)$/.test(filePath)) process.exit(0)

  // Skip files outside src/ (hooks, configs, scripts)
  const normalized = filePath.replace(/\\/g, '/')
  if (!normalized.includes('/src/')) process.exit(0)

  try {
    const result = execSync(
      `npx eslint --no-error-on-unmatched-pattern ${JSON.stringify(filePath)} 2>&1`,
      { encoding: 'utf8', timeout: 15000 }
    )

    if (result.trim()) {
      process.stderr.write(`Lint warnings em ${filePath}:\n${result.trim()}`)
    }
  } catch (err) {
    const output = (err.stdout || '').trim()
    if (output) {
      process.stderr.write(`Lint errors em ${filePath}:\n${output}\n\nCorrija antes de continuar.`)
      process.exit(2)
    }
  }

  process.exit(0)
})
