const { execSync } = require('child_process')
const parseInput = require('./parse-hook-input')

parseInput().then(({ filePath }) => {
  if (!filePath || !/\.(ts|tsx)$/.test(filePath)) process.exit(0)

  // Skip files outside src/
  const normalized = filePath.replace(/\\/g, '/')
  if (!normalized.includes('/src/')) process.exit(0)

  try {
    execSync('npx tsc --noEmit --pretty 2>&1', {
      encoding: 'utf8',
      timeout: 30000,
      stdio: 'pipe',
    })
  } catch (err) {
    const output = (err.stdout || '').trim()
    if (output) {
      // Show only errors related to the edited file to reduce noise
      const relevantLines = output
        .split('\n')
        .filter((line) => line.includes(filePath.replace(/\\/g, '/')) || line.includes(filePath))
        .join('\n')

      if (relevantLines) {
        process.stderr.write(`TypeScript errors em ${filePath}:\n${relevantLines}`)
      } else {
        // If there are errors but not in this file, warn but don't block
        process.stderr.write(`TypeScript errors no projeto (não necessariamente neste arquivo). Rode 'npx tsc --noEmit' para ver todos.`)
      }
    }
  }

  // Non-blocking — tsc errors are warnings, lint is the blocker
  process.exit(0)
})
