#!/usr/bin/env node
'use strict'

// 真實 Claude Code + 真實上游；只讀正式 store，所有 set 都留在記憶體。
// 用法：node scripts/probe-ccswitch-claude-e2e.js [--provider=codex] [--defaults]
// 可用 AXONDECK_CC_SCRATCHPAD / AXONDECK_CC_STORE / CLAUDE_EXE 指定測試路徑。
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const assert = require('assert/strict')
const { spawn, spawnSync } = require('child_process')
const { randomBytes, createHash } = require('crypto')
const { removeTreeSync } = require('../src/main/safe-rm')
const presets = require('../src/main/ccswitch/presets')
const providers = require('../src/main/ccswitch/providers')
const settings = require('../src/main/ccswitch/claude-settings')
const gateway = require('../src/main/ccswitch/gateway/server')
const credential = require('../src/main/ccswitch/gateway/credential')
const oauth = require('../src/main/ccswitch/gateway/oauth')
const scan = require('../src/main/ccswitch/models-scan')

const scratchpad = process.env.AXONDECK_CC_SCRATCHPAD || path.join(os.homedir(),
  'AppData/Local/Temp/claude/D--Workspace-Personal-Project-VoiceInk',
  '65106a55-8401-4f14-b8ff-2ad92723c437/scratchpad')
const source = process.env.AXONDECK_CC_STORE || path.join(process.env.APPDATA, 'voiceink/cc-providers.json')
const args = process.argv.slice(2)
const only = args.find((arg) => arg.startsWith('--provider='))?.slice(11)
const useDefaults = args.includes('--defaults')
const localKey = randomBytes(32).toString('hex')
const matrix = []
const providerIds = ['official', 'grok-build', 'codex', 'ollama-cloud', 'opencode-go', 'commandcode', 'openrouter']
let calls = []

function digest(file) {
  return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
}

// 只輸出固定分類，不輸出任何上游字串、CLI stderr 或 body。
function category(text) {
  if (/insufficient.*(credit|balance)|credit.*balance|not enough credits/i.test(text)) return 'ACCOUNT_CREDITS'
  if (/quota|usage.limit|rate.limit|spending.limit/i.test(text)) return 'ACCOUNT_LIMIT'
  if (/subscription|plan.*(support|access|available)|not.*(subscribed|eligible)|upgrade|payment.required/i.test(text)) return 'ACCOUNT_PLAN'
  if (/model.*(not.*(support|found|available)|invalid)|unknown model/i.test(text)) return 'MODEL_UNAVAILABLE'
  if (/instructions.*(required|missing|must)/i.test(text)) return 'INSTRUCTIONS_REQUIRED'
  if (/max[_ ](output[_ ])?tokens.*(unsupported|limit|exceed)|unsupported.*max[_ ]tokens/i.test(text)) return 'MAX_TOKENS'
  if (/tool.*schema|invalid.*schema|parameters.*(invalid|required)/i.test(text)) return 'TOOL_SCHEMA'
  if (/unsupported.*param|unrecognized.*param/i.test(text)) return 'UNSUPPORTED_PARAMETER'
  if (/scope|permission|unauthorized|expired.*token|invalid.*token/i.test(text)) return 'AUTH_REJECTED'
  if (/session|user.agent/i.test(text)) return 'CLIENT_SESSION_REQUIRED'
  return 'UPSTREAM_REJECTED'
}

async function observedFetch(url, options) {
  const response = await fetch(url, options)
  const entry = { status: response.status, code: response.ok ? 'OK' : 'UPSTREAM_REJECTED' }
  if (!response.ok) entry.code = category(await response.clone().text())
  calls.push(entry)
  return response
}

function readOnlyCredential(provider, options = {}) {
  // 不用旋轉 refresh token：正式 store 不寫回時，旋轉會讓原憑證失效。
  return credential.acquire(provider, { ...options, fetchImpl: async () => {
    const error = new Error('READ_ONLY_TOKEN_EXPIRED')
    error.code = 'READ_ONLY_TOKEN_EXPIRED'
    throw error
  } })
}

function childEnv(provider, config, base) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^ANTHROPIC_|^CLAUDE_CODE_|^CLAUDECODE$/.test(key)) delete env[key]
  }
  return { ...env, ...providers.resolveEnv(provider, base), CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '0', DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_MAX_RETRIES: '0' }
}

function runClaude(exe, provider, kind, config, cwd, base) {
  const tool = kind === 'tool'
  const prompt = tool
    ? 'Use Bash to run exactly "ls -a" in the current directory. Then reply with just OK. You must call Bash before answering.'
    : 'Reply with just OK'
  const argv = ['-p', prompt, '--model', provider.model, '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--tools', tool ? 'Bash' : '', '--max-turns', '3',
    '--output-format', kind === 'text' ? 'json' : 'stream-json']
  if (kind !== 'text') argv.push('--verbose', '--include-partial-messages')
  if (tool) argv.push('--allowedTools', 'Bash(ls -a)')
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false
    const child = spawn(exe, argv, { cwd, env: childEnv(provider, config, base), shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      child.kill()
    }, Number(process.env.AXONDECK_CC_TIMEOUT_MS) || 150_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', () => { clearTimeout(timer); resolve({ pass: false, code: 'CLI_START_FAILED' }) })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      const records = stdout.split('\n').flatMap((line) => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      const result = records.findLast((record) => record.type === 'result')
      const blocks = records.filter((r) => r.type === 'assistant').flatMap((r) => r.message?.content || [])
      const toolIds = blocks.filter((b) => b.type === 'tool_use' && b.name === 'Bash').map((b) => b.id)
      const returned = records.filter((r) => r.type === 'user').flatMap((r) => r.message?.content || [])
        .some((b) => b.type === 'tool_result' && !b.is_error && toolIds.includes(b.tool_use_id))
      const streamed = records.some((r) => r.type === 'stream_event' &&
        r.event?.type === 'content_block_delta' && r.event.delta?.type === 'text_delta')
      const success = exitCode === 0 && result?.is_error === false && /^OK[.!]?\s*$/.test(result?.result?.trim() || '')
      const pass = success && (kind === 'text' || streamed) && (!tool || (toolIds.length > 0 && returned))
      const status = calls.map((c) => c.status)
      if (!status.length) {
        const match = `${stdout}\n${stderr}`.match(/(?:HTTP|API Error:)\s*(\d{3})/i)
        if (match) status.push(Number(match[1]))
        else if (success) status.push(200)
      }
      resolve({ pass, status, exitCode, streamed, toolCalls: toolIds.length, toolReturned: returned,
        code: pass ? 'OK' : timedOut ? 'CLI_TIMEOUT' : calls.find((c) => c.status >= 400)?.code ||
          (result?.is_error ? category(JSON.stringify(result)) : tool && success ? 'TOOL_NOT_EXECUTED' : 'CLI_FAILED') })
    })
  })
}

function nonStream(provider, base, env) {
  return new Promise((resolve) => {
    const url = new URL(`${env.ANTHROPIC_BASE_URL}/v1/messages`)
    const body = JSON.stringify({ model: provider.model, max_tokens: 64, stream: false,
      system: 'Reply with just OK', metadata: { session_id: `probe-${randomBytes(16).toString('hex')}` },
      messages: [{ role: 'user', content: 'Reply with just OK' }] })
    const req = http.request(url, { method: 'POST', headers: { 'x-api-key': base.apiKey,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let parsed = {}
        try { parsed = JSON.parse(text) } catch { /* 回報格式不合 */ }
        const reply = (parsed.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim()
        resolve({ pass: res.statusCode === 200 && /^OK[.!]?$/.test(reply), status: res.statusCode,
          code: calls.find((c) => c.status >= 400)?.code || (res.statusCode === 200 ? 'OK' : 'GATEWAY_REJECTED') })
      })
    })
    req.setTimeout(150_000, () => req.destroy())
    req.on('error', () => resolve({ pass: false, status: 0, code: 'NETWORK' }))
    req.end(body)
  })
}

function officialCheck(run) {
  assert.deepEqual(providers.resolveEnv({ presetId: 'official', model: 'leftover' }), {})
  const home = path.join(run, 'official-test')
  const file = path.join(home, '.claude/settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ env: { ...Object.fromEntries(settings.MANAGED_ENV_KEYS
    .map((key) => [key, 'test-placeholder'])), KEEP: 'yes' }, hooks: { keep: [] } }))
  settings.configure({ homeDir: home, backupDir: path.join(home, 'backups') })
  settings.applyEnv({})
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.env, { KEEP: 'yes' })
  assert.deepEqual(after.hooks, { keep: [] })
  return { provider: 'official', text: 'PASS (ENV UNIT)', stream: 'N/A', tool: 'N/A' }
}

async function main() {
  if (only && !providerIds.includes(only)) throw new Error('INVALID_PROVIDER')
  const guarded = [source, path.join(os.homedir(), '.claude/settings.json'), path.join(os.homedir(), '.claude.json'),
    credential.grokAuthPath(), credential.codexAuthPath()]
  const hashes = guarded.map(digest)
  const snapshot = structuredClone(JSON.parse(fs.readFileSync(source, 'utf8')))
  const store = { get: (key, fallback) => structuredClone(snapshot[key] ?? fallback),
    set: (key, value) => { snapshot[key] = structuredClone(value) } }
  providers.configure({ getStore: async () => store })
  oauth.configure({ getStore: async () => store })
  credential.configure({ refreshCli: async () => {
    const error = new Error('READ_ONLY_TOKEN_EXPIRED')
    error.code = 'READ_ONLY_TOKEN_EXPIRED'
    throw error
  } })
  scan.configure({ acquire: readOnlyCredential })
  gateway.configure({ fetchImpl: observedFetch, credential: { acquire: readOnlyCredential, invalidate: credential.invalidate } })
  fs.mkdirSync(scratchpad, { recursive: true })
  const run = fs.mkdtempSync(path.join(scratchpad, 'claude-e2e-')) // temp-ok: 使用者指定 scratchpad
  const exe = process.env.CLAUDE_EXE || path.join(os.homedir(), '.local/bin/claude.exe')
  const cli = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true })
  console.log(`Claude Code: ${cli.stdout?.match(/\d+\.\d+\.\d+/)?.[0] || 'UNKNOWN'}`)
  try {
    const { port } = await gateway.start({ port: 0, apiKey: localKey, getProviderKey: providers.keyForPreset,
      getAccountId: providers.accountForPreset, resolveRoute: providers.resolveRoute })
    const base = { baseUrl: `http://127.0.0.1:${port}`, apiKey: localKey }
    if (!only || only === 'official') matrix.push(officialCheck(run))
    for (const preset of presets.PRESETS.filter((p) => providerIds.includes(p.id) && p.id !== 'official' && (!only || only === p.id))) {
      const raw = snapshot.providers.find((p) => p.presetId === preset.id)
      if (!raw) throw new Error('MISSING_PROVIDER')
      const provider = { ...providers.sanitizeAll([raw])[0] }
      if (useDefaults) for (const key of Object.keys(providers.MODEL_FIELDS)) provider[key] = ''
      provider.model = provider.model || preset.env.ANTHROPIC_MODEL
      snapshot.currentId = provider.id
      // 預設測試的選擇也只留在複本，resolveRoute 仍走正式 providers 資料流。
      if (useDefaults) snapshot.providers = snapshot.providers.map((p) => p.id === provider.id ? provider : p)
      const modelScan = await scan.scanProviderModels(provider, { fetchImpl: observedFetch })
      const missing = modelScan.ok ? [...new Set(Object.values(preset.env).filter((v, i) =>
        Object.keys(preset.env)[i].endsWith('_MODEL')))].filter((m) => !modelScan.models.includes(m)) : []
      console.log(`${preset.id} model=${provider.model} models=${modelScan.ok ? modelScan.models.length : modelScan.code} missingDefaults=${missing.join(',') || '-'}`)
      const row = { provider: preset.id, model: provider.model, modelScan: modelScan.ok ? 'PASS' : modelScan.code, missingDefaults: missing }
      if (['codex', 'opencode-go'].includes(preset.id)) {
        const checked = await scan.testProvider(provider, { fetchImpl: observedFetch })
        row.validation = { pass: checked.ok, status: checked.status || 0, code: checked.code }
        console.log(`${preset.id} testProvider: HTTP=${checked.status || '-'} code=${checked.code}`)
      }
      for (const kind of ['text', 'stream', 'tool']) {
        const config = path.join(run, preset.id, kind, 'config')
        const cwd = path.join(run, preset.id, kind, 'empty')
        fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(cwd, { recursive: true })
        calls = []
        const result = await runClaude(exe, provider, kind, config, cwd, base)
        row[kind] = result
        console.log(`${preset.id} ${kind}: ${result.pass ? 'PASS' : 'FAIL'} HTTP=${result.status?.join('/') || '-'} code=${result.code} tool=${result.toolCalls || 0}/${Boolean(result.toolReturned)}`)
      }
      if (providers.routeFor(provider, preset) === 'gateway') {
        calls = []
        row.nonStream = await nonStream(provider, base, providers.resolveEnv(provider, base))
        console.log(`${preset.id} stream=false: ${row.nonStream.pass ? 'PASS' : 'FAIL'} HTTP=${row.nonStream.status} upstream=${calls.map((c) => c.status).join('/')} code=${row.nonStream.code}`)
      }
      matrix.push(row)
    }
  } finally {
    await gateway.stop()
    const cell = (value) => typeof value === 'string' ? value :
      value ? `${value.pass ? 'PASS' : 'FAIL'} HTTP ${value.status?.join('/') || '-'} ${value.code}` : '-'
    console.table(matrix.map((row) => ({ provider: row.provider, text: cell(row.text),
      stream: cell(row.stream), tool: cell(row.tool) })))
    console.log('MATRIX ' + JSON.stringify(matrix))
    removeTreeSync(run, { retries: 5 })
    const checks = guarded.map((file, i) => ({ file: path.basename(file), unchanged: digest(file) === hashes[i] }))
    const unchanged = checks.every((check) => check.unchanged)
    console.log(`正式設定與憑證未變更: ${unchanged ? 'PASS' : 'FAIL'}`)
    if (!unchanged) console.log('變更的檔案（可能有其他程序同時寫入）: ' + checks.filter((check) => !check.unchanged).map((check) => check.file).join(', '))
    assert.equal(unchanged, true)
  }
  process.exitCode = matrix.some((row) => ['text', 'stream', 'tool'].some((key) => row[key]?.pass === false) || row.nonStream?.pass === false) ? 1 : 0
}

main().catch((error) => {
  const code = ['ENOENT', 'EPERM', 'EBUSY', 'EACCES', 'ERR_ASSERTION', 'MISSING_PROVIDER'].includes(error?.code || error?.message)
    ? error.code || error.message : 'PROBE_FAILED'
  console.error(`探測失敗（${code}，細節已隱藏）`)
  process.exitCode = 1
})
