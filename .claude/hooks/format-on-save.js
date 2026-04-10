const { execSync } = require('child_process')
const parseInput = require('./parse-hook-input')

parseInput().then(({ filePath }) => {
  if (!filePath || !/\.(ts|tsx|js|jsx|json|css)$/.test(filePath)) process.exit(0)

  try {
    execSync(`npx prettier --write ${JSON.stringify(filePath)}`, {
      stdio: 'ignore',
      timeout: 10000,
    })
  } catch (err) {
    process.stderr.write(`Prettier falhou em ${filePath}: ${err.message || 'erro desconhecido'}. Verifique a config do Prettier.`)
    // Non-blocking — formatting failure shouldn't stop work
  }

  process.exit(0)
})
