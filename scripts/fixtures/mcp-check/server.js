'use strict'

const fs = require('fs')
const readline = require('readline')
const { spawn } = require('child_process')
const mode = process.argv[2] || 'ok'

if (mode === 'exit') process.exit(1)
if (process.env.MCP_CHECK_PID_FILE) fs.writeFileSync(process.env.MCP_CHECK_PID_FILE, String(process.pid))
if (mode === 'child') setInterval(() => {}, 1000)
else {
  if (process.env.MCP_CHECK_CHILD_PID_FILE) {
    const child = spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore', windowsHide: true,
      env: { ...process.env, MCP_CHECK_PID_FILE: '' } })
    fs.writeFileSync(process.env.MCP_CHECK_CHILD_PID_FILE, String(child.pid))
  }
  let initialized = false
  const input = readline.createInterface({ input: process.stdin })
  input.on('line', line => {
    const message = JSON.parse(line)
    if (mode === 'silent') return
    if (message.method === 'notifications/initialized') { initialized = true; return }
    let result
    if (message.method === 'initialize') {
      if (mode === 'bad') { process.stdout.write('not JSON secret-token\n'); return }
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      if (mode === 'invalid-init') result = { protocolVersion: 'secret-token' }
    } else if (message.method === 'tools/list') {
      if (mode === 'hang-tools') return
      if (!initialized) { process.exit(2); return }
      const page = Number(message.params?.cursor || 0)
      const tools = mode === 'many' ? Array.from({ length: 250 }, (_, i) => ({ name: `tool-${i}` }))
        : [{ name: `${page ? 'second' : 'first'}-tool`, description: '第一段 ' + '字'.repeat(220) + '\n\n第二段秘密' }]
      result = { tools }
      if (mode === 'pages' && page === 0) result.nextCursor = '1'
      if (mode === 'endless') result.nextCursor = String(page + 1)
      if (mode === 'args') result = { tools: [{ name: 'arguments', description: JSON.stringify(process.argv.slice(3)) + '|' + process.env.MCP_CHECK_ENV }] }
      if (mode === 'bad-tools') result = { tools: [{ name: 42, description: 'secret-token' }] }
      if (mode === 'rpc-error') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'secret-token' } }) + '\n')
        return
      }
    }
    process.stderr.write('secret-token\n')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n')
  })
}
