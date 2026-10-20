#!/usr/bin/env node
'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const http = require('http')
const path = require('path')
const vm = require('vm')
const { setTimeout: delay } = require('timers/promises')
const { tempDir, removeTree } = require('./lib/test-temp')
const { createChecker } = require('../src/main/ccswitch/mcp-check')
const homes = require('../src/main/ccswitch/mcp-homes')
const settings = require('../src/main/ccswitch/claude-settings')

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-check', 'server.js')
const tmp = tempDir('mcp-check-')
const previous = process.env.GROK_HOME
process.env.GROK_HOME = tmp
settings.configure({ backupDir: path.join(tmp, 'backups') })
homes.configure({ homeDir: tmp, getStore: async () => ({ get: (key, fallback) => fallback, set: () => {} }) })
let passed = 0
let failed = 0
const runners = []
const servers = []

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`) }
  catch (error) { failed++; console.log(`  FAIL ${name}\n${error.stack}`) }
}

function runner(options = {}) {
  const check = createChecker({ stdioMs: 2500, httpMs: 1500, ...options })
  runners.push(check)
  return check
}

async function stdio(mode, check = runner(), env = {}, command = process.execPath, args = [FIXTURE, mode]) {
  await homes.upsert('grok', mode, { type: 'stdio', command, args, env })
  return check.check({ home: 'grok', id: mode })
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('fixture 狀態未就緒')
    await delay(25)
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function stdioTests() {
  await test('stdio initialize → initialized → tools/list、只回第一段 200 字', async () => {
    const result = await stdio('ok')
    assert.equal(result.ok, true)
    assert.equal(result.count, 1)
    assert.equal(result.tools[0].description.length, 200)
    assert.equal(result.tools[0].description.includes('第二段'), false)
  })
  await test('stdio 分頁跟 nextCursor', async () => {
    const result = await stdio('pages')
    assert.equal(result.count, 2)
    assert.deepEqual(result.tools.map(tool => tool.name), ['first-tool', 'second-tool'])
  })
  await test('最多五頁、200 個工具', async () => {
    assert.equal((await stdio('endless')).count, 5)
    assert.equal((await stdio('many')).count, 200)
  })
  await test('啟動即退出與不存在指令均回固定啟動失敗', async () => {
    assert.equal((await stdio('exit')).code, 'START')
    assert.equal((await stdio('missing', runner(), {}, path.join(tmp, 'not-present.exe'))).reason, '啟動失敗')
  })
  await test('initialize 與 tools/list 各自逾時', async () => {
    const check = runner({ stdioMs: 600 })
    assert.equal((await stdio('silent', check)).reason, '逾時於 initialize')
    assert.equal((await stdio('hang-tools', check)).reason, '逾時於 tools/list')
  })
  await test('stdout、JSON-RPC error、初始化／工具壞格式不外洩', async () => {
    for (const mode of ['bad', 'invalid-init', 'bad-tools', 'rpc-error']) {
      assert.deepEqual(await stdio(mode), { ok: false, code: 'FORMAT', reason: '回應格式不對' })
    }
  })
  await test('stdio env 與帶空白參數照設定傳入', async () => {
    const args = ['hello world', '中文']
    const result = await stdio('args', runner(), { MCP_CHECK_ENV: 'env-value' }, process.execPath, [FIXTURE, 'args', ...args])
    assert.equal(result.tools[0].description, JSON.stringify(args) + '|env-value')
  })
}

async function processTests() {
  await test('逾時清掉整棵程序樹', async () => {
    const pidFile = path.join(tmp, 'timeout.pid')
    const childFile = path.join(tmp, 'timeout-child.pid')
    const check = runner({ stdioMs: 1500 })
    const promise = stdio('silent', check, { MCP_CHECK_PID_FILE: pidFile, MCP_CHECK_CHILD_PID_FILE: childFile })
    await until(() => fs.existsSync(childFile))
    const pids = [pidFile, childFile].map(file => Number(fs.readFileSync(file, 'utf8')))
    assert.equal((await promise).code, 'INITIALIZE_TIMEOUT')
    await until(() => pids.every(pid => !alive(pid)))
  })
  await test('重測先停止舊程序；shutdown 停止本次程序', async () => {
    const pidFile = path.join(tmp, 'retest.pid')
    await homes.upsert('grok', 'retest', { command: process.execPath, args: [FIXTURE, 'silent'], env: { MCP_CHECK_PID_FILE: pidFile } })
    const check = runner({ stdioMs: 10_000 })
    const old = check.check({ home: 'grok', id: 'retest' })
    await until(() => fs.existsSync(pidFile))
    const oldPid = Number(fs.readFileSync(pidFile, 'utf8'))
    const next = check.check({ home: 'grok', id: 'retest' })
    assert.equal((await old).code, 'CANCELLED')
    assert.equal(alive(oldPid), false)
    await until(() => Number(fs.readFileSync(pidFile, 'utf8')) !== oldPid)
    const newPid = Number(fs.readFileSync(pidFile, 'utf8'))
    await check.shutdown()
    assert.equal((await next).code, 'CANCELLED')
    await until(() => !alive(newPid))
  })
  await test('renderer 只能指定 home／id，額外指令或網址不執行', async () => {
    const check = runner({ list: () => { throw new Error('不應該讀取設定') } })
    for (const req of [null, { home: 'bad', id: 'ok' }, { home: 'grok', id: 'ok', command: 'evil' },
      { home: 'grok', id: 'ok', url: 'http://evil' }, { home: 'grok', id: '__proto__' }]) {
      assert.equal((await check.check(req)).code, 'FORMAT')
    }
  })
  await test('舊式 SSE 明確回暫不支援', async () => {
    await homes.upsert('grok', 'legacy', { type: 'sse', url: 'http://127.0.0.1:1/sse' })
    // Grok 原生 remote 是 HTTP；Claude 形狀的 SSE 由受信任讀取器提供。
    const check = runner({ list: async () => ({ servers: [{ id: 'legacy', spec: { type: 'sse', url: 'http://127.0.0.1:1/sse' } }] }) })
    assert.equal((await check.check({ home: 'claude', id: 'legacy' })).reason, '暫不支援測試')
  })
}

async function ipcTests() {
  await test('IPC 擋非主視窗，設定只從 main 讀取', async () => {
    const handlers = new Map()
    const sender = {}
    let reads = 0
    require('../src/main/ccswitch/ipc').registerCcSwitchIpc({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, isMainSender: event => event === sender,
      service: { listMcp: async home => { reads++; assert.equal(home, 'claude'); return {
        servers: [{ id: 'saved', spec: { type: 'sse', url: 'http://127.0.0.1:1/sse' } }]
      } } }
    })
    const handler = handlers.get('ccswitch:testMcp')
    assert.equal((await handler({}, { home: 'claude', id: 'saved' })).error.code, 'FORBIDDEN')
    assert.equal((await handler(sender, { home: 'claude', id: 'saved', command: 'evil' })).data.code, 'FORMAT')
    assert.equal(reads, 0)
    assert.equal((await handler(sender, { home: 'claude', id: 'saved' })).data.code, 'UNSUPPORTED')
    assert.equal(reads, 1)
  })
}

async function windowsTests() {
  if (process.platform !== 'win32') return
  await test('Windows PATH／PATHEXT 找 .cmd，保留空白與特殊字元', async () => {
    const dir = path.join(tmp, 'shim space & name')
    fs.mkdirSync(dir)
    const file = path.join(dir, 'probe.cmd')
    fs.writeFileSync(file, `@"${process.execPath}" "${FIXTURE}" %*\r\n`)
    const args = ['hello world', 'a&b', 'a|b', 'a"b', 'x%PATH%x', 'a^b', 'a!b', 'C:\\tail\\']
    const env = { pAtH: dir, pAtHeXt: '.CMD', MCP_CHECK_ENV: 'env' }
    const result = await stdio('cmd-path', runner(), env, 'probe', ['args', ...args])
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.tools[0].description, JSON.stringify(args) + '|env')
    const wrapped = await stdio('cmd-wrapped', runner(), env, 'cmd', ['/c', 'probe', 'args', ...args])
    assert.equal(wrapped.tools[0].description, JSON.stringify(args) + '|env')
  })
}

function httpHandler(records) {
  return (req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const message = JSON.parse(body)
      records.push({ path: req.url, message, headers: req.headers })
      if (req.url === '/401' || req.url === '/403') { res.writeHead(Number(req.url.slice(1))); res.end('secret-token'); return }
      if (req.url === '/bad') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('secret-token'); return }
      if (req.url === '/empty') { res.writeHead(204); res.end(); return }
      if (req.url === '/init-timeout' || req.url === '/tools-timeout' && message.method === 'tools/list') return
      if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
      let result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } }
        : { tools: [{ name: 'remote-tool', description: 'remote description\n\nprivate second paragraph' }] }
      if (req.url === '/pages' && message.method === 'tools/list' && !message.params.cursor) result.nextCursor = 'next-page'
      if (req.url === '/invalid-tools' && message.method === 'tools/list') result = { tools: 'secret-token' }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
      const sse = req.url === '/sse'
      res.writeHead(200, { 'Content-Type': sse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'private-session' })
      if (!sse) { res.end(reply); return }
      res.write(': heartbeat\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n')
      const split = reply.indexOf(',') + 1
      res.write(`event: message\r\ndata: ${reply.slice(0, split)}\r\ndata: ${reply.slice(split)}\r\n\r\n`)
      // 故意不結束 SSE，收到指定 id 就應完成，不等 socket 關閉。
    })
  }
}

async function httpTests() {
  const records = []
  const server = http.createServer(httpHandler(records))
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  async function remote(route, check = runner()) {
    await homes.upsert('grok', 'remote', { type: 'http', url: base + route, headers: { Authorization: 'Bearer private-token', 'X-Custom': 'value' } })
    return check.check({ home: 'grok', id: 'remote' })
  }
  for (const route of ['/json', '/sse']) {
    await test(`HTTP ${route} 成功、帶 headers／session／協議版本`, async () => {
      const result = await remote(route)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.deepEqual(result.tools, [{ name: 'remote-tool', description: 'remote description' }])
      const calls = records.filter(record => record.path === route)
      assert.deepEqual(calls.map(call => call.message.method), ['initialize', 'notifications/initialized', 'tools/list'])
      for (const call of calls) {
        assert.equal(call.headers.accept, 'application/json, text/event-stream')
        assert.equal(call.headers.authorization, 'Bearer private-token')
        assert.equal(call.headers['x-custom'], 'value')
      }
      assert.equal(calls[1].headers['mcp-session-id'], 'private-session')
      assert.equal(calls[2].headers['mcp-protocol-version'], '2025-06-18')
      assert.equal(JSON.stringify(result).includes('private-'), false)
    })
  }
  await test('HTTP tools/list 分頁', async () => { assert.equal((await remote('/pages')).count, 2) })
  await test('HTTP 401／403 回固定需要登入，不回 body', async () => {
    for (const route of ['/401', '/403']) assert.deepEqual(await remote(route), { ok: false, code: 'AUTH', reason: '需要登入（401/403）' })
  })
  await test('HTTP 壞 JSON 與壞 tools 格式不回 body', async () => {
    for (const route of ['/bad', '/empty', '/invalid-tools']) assert.deepEqual(await remote(route), { ok: false, code: 'FORMAT', reason: '回應格式不對' })
  })
  await test('HTTP initialize 與 tools/list 各自逾時', async () => {
    const check = runner({ httpMs: 150 })
    assert.equal((await remote('/init-timeout', check)).code, 'INITIALIZE_TIMEOUT')
    assert.equal((await remote('/tools-timeout', check)).code, 'TOOLS_TIMEOUT')
  })
}

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.textContent = '' }
  append(...items) { this.children.push(...items) }
  prepend(item) { this.children.unshift(item) }
  replaceChildren(...items) { this.children = items; this.textContent = '' }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener(key, fn) { this.handlers[key] = fn }
}

async function rendererTests() {
  await test('UI 按鈕常駐、只送 home/id、重畫不丟進行中結果、工具可展開', async () => {
    let finish
    const calls = []
    const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, window: { electronAPI: {
      ccswitch: { testMcp: req => { calls.push(req); return new Promise(resolve => { finish = resolve }) } }
    } } })
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/cc-mcp-check.js'), 'utf8').replace(/^export /gm, '')
    vm.runInContext(source, context)
    const mount = () => { const main = new Element('div'); const actions = new Element('div'); context.mountMcpCheck(main, actions, 'grok', 'example'); return { main, actions } }
    const first = mount()
    assert.equal(first.actions.children[0].textContent, '測試')
    const pending = first.actions.children[0].handlers.click()
    await Promise.resolve(); await Promise.resolve()
    assert.equal(first.actions.children[0].disabled, true)
    assert.equal(JSON.stringify(calls), '[{"home":"grok","id":"example"}]')
    const second = mount()
    assert.equal(second.actions.children[0].textContent, '測試中…')
    finish({ ok: true, data: { ok: true, count: 1, tools: [{ name: '<unsafe>', description: '說明' }] } })
    await pending
    const details = second.main.children[0].children[0]
    assert.equal(details.tagName, 'details')
    assert.equal(details.children[0].textContent, '可用 · 1 個工具')
    assert.equal(details.children[1].children[0].children[0].textContent, '<unsafe>')
    context.forgetMcpCheck('grok', 'example')
    assert.equal(mount().main.children[0].children.length, 0)
  })
}

async function main() {
  try {
    await stdioTests()
    await processTests()
    await ipcTests()
    await windowsTests()
    await httpTests()
    await rendererTests()
  } finally {
    await Promise.all(runners.map(check => check.shutdown()))
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (previous === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = previous
    removeTree(tmp)
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error.stack); process.exitCode = 1 })
