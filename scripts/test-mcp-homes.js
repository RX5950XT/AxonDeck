#!/usr/bin/env node
/**
 * AxonDeck — 四家 MCP homes 回歸（node 直跑，不碰真實家目錄）。
 *
 * 最容易錯的三條：
 * - TOML 整份重寫時把不認識的鍵弄丟（startup_timeout_sec、env_vars、別人的表格）
 * - 壞掉的 config.toml 被覆寫掉（必須先拋錯，檔案一字不動）
 * - codex 的停用狀態跟檔案內容對不上（它沒有 enabled 欄位，靠 store 記）
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const homes = require(path.join(ROOT, 'src/main/ccswitch/mcp-homes.js'))
const claudeSettings = require(path.join(ROOT, 'src/main/ccswitch/claude-settings.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const tmp = tempDir('axondeck-mcp-homes-')
const codexHome = path.join(tmp, 'codex')
const grokHome = path.join(tmp, 'grok')
const ocHome = path.join(tmp, 'oc')
fs.mkdirSync(codexHome, { recursive: true })
fs.mkdirSync(grokHome, { recursive: true })
fs.mkdirSync(path.join(ocHome, '.config', 'opencode'), { recursive: true })

const prevCodex = process.env.CODEX_HOME
const prevGrok = process.env.GROK_HOME
process.env.CODEX_HOME = codexHome
process.env.GROK_HOME = grokHome
claudeSettings.configure({ backupDir: path.join(tmp, 'backup') })
const bag = new Map()
homes.configure({
  homeDir: ocHome,
  getStore: async () => ({
    get: (key, fallback) => (bag.has(key) ? bag.get(key) : fallback),
    set: (key, value) => { bag.set(key, value) }
  })
})

async function asyncSections() {
try {
  console.log('\n[A] 家目錄清單')
  {
    const all = homes.homes()
    ok('四家', all.length === 4 && all.every((row) => row.id && row.label && row.path))
    ok('codex 標 stdio-only', all.find((row) => row.id === 'codex').stdioOnly === true)
    ok('codex 指到 CODEX_HOME', all.find((row) => row.id === 'codex').path.startsWith(codexHome))
    let threw = ''
    try {
      await homes.list('agy')
    } catch (error) { threw = error.code }
    ok('未知家目錄擋掉', threw === 'MCP_HOME_UNKNOWN', threw)
  }

  console.log('\n[B] Codex TOML（未知鍵要留著）')
  {
    const file = path.join(codexHome, 'config.toml')
    fs.writeFileSync(file, [
      'model = "gpt-6.1-sol"',
      '',
      '[mcp_servers.node_repl]',
      'command = "node_repl.exe"',
      'args = []',
      'startup_timeout_sec = 120',
      'env_vars = ["CODEX_HOME"]',
      '',
      '[mcp_servers.node_repl.env]',
      'FOO = "bar"',
      '',
      '[projects.\'c:\\x\']',
      'trust_level = "trusted"',
      ''
    ].join('\n'))
    const before = fs.readFileSync(file, 'utf8')

    const listed = await homes.list('codex')
    ok('讀得到', listed.servers.length === 1 && listed.servers[0].id === 'node_repl')
    ok('env 讀得到', listed.servers[0].spec.env.FOO === 'bar')

    await homes.upsert('codex', 'ctx7', { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] }, true)
    const after = fs.readFileSync(file, 'utf8')
    // smol-toml 重寫時引號格式可能跟原檔不同（'c:\x'→"c:\\x"）：認表格內容不認引號
    ok('別人的表格還在', after.includes('trust_level = "trusted"'))
    ok('startup_timeout_sec 還在', after.includes('startup_timeout_sec = 120'))
    ok('env_vars 還在', after.includes('env_vars'))
    ok('新伺服器寫進去了', after.includes('[mcp_servers.ctx7]'))

    await homes.toggle('codex', 'node_repl', false)
    const disabled = fs.readFileSync(file, 'utf8')
    ok('停用後從檔案移除', !disabled.includes('[mcp_servers.node_repl]'))
    const listedOff = await homes.list('codex')
    const row = listedOff.servers.find((item) => item.id === 'node_repl')
    ok('停用顯示在清單尾', row && row.enabled === false)
    ok('停用的設定沒丟（env 還在）', row && row.spec.env.FOO === 'bar')

    await homes.toggle('codex', 'node_repl', true)
    const enabled = fs.readFileSync(file, 'utf8')
    ok('重開放回去', enabled.includes('[mcp_servers.node_repl]'))

    await homes.remove('codex', 'ctx7')
    ok('刪除只刪那一台', !fs.readFileSync(file, 'utf8').includes('ctx7'))

    let threw = ''
    try {
      await homes.upsert('codex', 'web', { type: 'http', url: 'https://x/mcp' }, true)
    } catch (error) { threw = error.code }
    ok('codex 拒收 http（不硬轉）', threw === 'MCP_HOME_TYPE', threw)
    void before
  }

  console.log('\n[C] 壞 TOML 不覆寫')
  {
    const file = path.join(grokHome, 'config.toml')
    fs.writeFileSync(file, '[mcp_servers.oops\nbroken = ')
    let threw = ''
    try {
      await homes.list('grok')
    } catch (error) { threw = error.code }
    ok('壞檔讀取拋錯', threw === 'MCP_HOME_TOML_INVALID', threw)
    threw = ''
    try {
      await homes.upsert('grok', 'x', { type: 'stdio', command: 'cmd' }, true)
    } catch (error) { threw = error.code }
    ok('壞檔寫入也擋', threw === 'MCP_HOME_TOML_INVALID', threw)
    ok('檔案一字沒動', fs.readFileSync(file, 'utf8') === '[mcp_servers.oops\nbroken = ')
  }

  console.log('\n[D] Grok TOML（remote＋原生 enabled）')
  {
    const file = path.join(grokHome, 'config.toml')
    fs.writeFileSync(file, '')
    await homes.upsert('grok', 'supa', { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } }, true)
    const raw = fs.readFileSync(file, 'utf8')
    ok('remote 寫成 url＋headers', raw.includes('url = ') && raw.includes('[mcp_servers.supa.headers]'))
    const listed = await homes.list('grok')
    ok('讀回來是啟用的', listed.servers.length === 1 && listed.servers[0].enabled === true)
    ok('headers 讀得到', listed.servers[0].spec.headers.A === 'b')
    await homes.toggle('grok', 'supa', false)
    const off = await homes.list('grok')
    ok('原生 enabled 關得掉', off.servers[0].enabled === false)
    ok('關掉不斷線（檔案還在）', fs.readFileSync(file, 'utf8').includes('[mcp_servers.supa]'))
  }

  console.log('\n[E] OpenCode JSON（其他鍵不動）')
  {
    const file = path.join(ocHome, '.config', 'opencode', 'opencode.json')
    fs.writeFileSync(file, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: {}, shell: 'pwsh' }))
    await homes.upsert('opencode', 'local1', { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } }, true)
    await homes.upsert('opencode', 'remote1', { type: 'http', url: 'https://y/mcp' }, false)
    const root = JSON.parse(fs.readFileSync(file, 'utf8'))
    ok('shell 鍵還在', root.shell === 'pwsh')
    ok('local 存成陣列 command', Array.isArray(root.mcp.local1.command) && root.mcp.local1.command[0] === 'npx')
    ok('env 叫 environment', root.mcp.local1.environment.K === 'v')
    ok('remote 存 type remote', root.mcp.remote1.type === 'remote')
    const listed = await homes.list('opencode')
    const remote = listed.servers.find((item) => item.id === 'remote1')
    ok('啟用狀態讀得到', remote && remote.enabled === false)
    const local = listed.servers.find((item) => item.id === 'local1')
    ok('command 拼得回去', local && local.spec.command === 'npx' && local.spec.args[0] === '-y')
    await homes.toggle('opencode', 'remote1', true)
    ok('重開寫回 enabled', JSON.parse(fs.readFileSync(file, 'utf8')).mcp.remote1.enabled === true)
  }
} finally {
    if (prevCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodex
    if (prevGrok === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prevGrok
    removeTree(tmp)
  }
}

asyncSections()
  .catch((error) => {
    failed++
    console.log(`  FAIL 非同步測試拋錯 — ${error && error.stack}`)
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
