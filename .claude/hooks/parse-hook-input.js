/**
 * Shared helper for Claude Code hooks.
 * Reads stdin, parses JSON, extracts file path and content.
 * Usage: const { filePath, content, toolInput } = await require('./parse-hook-input')()
 */
module.exports = function parseHookInput() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data)
        const toolInput = parsed.tool_input || {}
        const filePath = toolInput.file_path || toolInput.filePath || ''
        const content = toolInput.content || toolInput.new_string || ''
        resolve({ filePath, content, toolInput, raw: parsed })
      } catch {
        resolve({ filePath: '', content: '', toolInput: {}, raw: {} })
      }
    })
  })
}
