'use strict'

const { spawn } = require('child_process')
const fs = require('../raw-fs')
const os = require('os')
const path = require('path')
const homes = require('./mcp-homes')
const { sanitizeId } = require('./mcp')
const { withPath } = require('./cli-install')

const VERSION = '2025-06-18'
const MAX_BYTES = 4 * 1024 * 1024
const REASONS = Object.freeze({
  START: '啟動失敗', INITIALIZE_TIMEOUT: '逾時於 initialize', TOOLS_TIMEOUT: '逾時於 tools/list',
  AUTH: '需要登入（401/403）', FORMAT: '回應格式不對', UNSUPPORTED: '暫不支援測試', CANCELLED: '測試已停止'
})

function failure(code) {
  const error = new Error('MCP_CHECK_FAILED')
  error.code = Object.hasOwn(REASONS, code) ? code : 'FORMAT'
  return error
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function resultOf(message, id) {
  if (!object(message) || message.jsonrpc !== '2.0' || message.id !== id ||
      Object.hasOwn(message, 'error') || !object(message.result)) throw failure('FORMAT')
  return message.result
}

function json(text) {
  try { return JSON.parse(text) } catch { throw failure('FORMAT') }
}

function request(id, method, params) {
  return { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }
}

async function step(action, ms, signal, code) {
  if (signal.aborted) throw failure('CANCELLED')
  let timer
  let abort
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(failure(code)), ms)
      abort = () => reject(failure('CANCELLED'))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

function environment(spec) {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(spec.env || {})) {
    const existing = process.platform === 'win32' ? Object.keys(env).find(old => old.toLowerCase() === key.toLowerCase()) : key
    if (process.platform === 'win32') {
      for (const old of Object.keys(env)) if (old.toLowerCase() === key.toLowerCase()) delete env[old]
    }
    env[existing || key] = value
  }
  return process.platform === 'win32' ? withPath(env) : env
}

async function resolveCommand(command, env) {
  const value = name => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1]
  const dirs = /[\\/]/.test(command) ? [''] : String(value('path') || '').split(';').filter(Boolean)
  const extensions = path.extname(command) ? [''] : (value('pathext') || '.COM;.EXE;.BAT;.CMD').split(';')
  for (const dir of dirs) {
    for (const ext of extensions) {
      const file = path.resolve(os.homedir(), dir.replace(/^"|"$/g, ''), command + ext)
      try { if ((await fs.promises.stat(file)).isFile()) return file } catch { /* 繼續找下一個 PATH */ }
    }
  }
  throw failure('START')
}

function cmdArgument(value) {
  const meta = /([()\][%!^"`<>&|;, *?])/g
  let quoted = '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
  quoted = quoted.replace(meta, '^$1')
  return quoted.replace(meta, '^$1')
}

async function launch(spec, env) {
  let command = spec.command
  let args = spec.args || []
  if (process.platform !== 'win32') return { command, args, options: {} }
  // 舊設定曾由 mcp.js 包成 cmd /c；拆回參數後統一處理引號。
  if (/^(?:cmd|cmd\.exe)$/i.test(path.basename(command)) && /^\/(?:d|s|c)$/i.test(args[0] || '')) {
    const at = args.findIndex(arg => /^\/c$/i.test(arg))
    if (at >= 0 && args.length > at + 1) [command, ...args] = args.slice(at + 1)
  }
  const file = await resolveCommand(command, env)
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args, options: {} }
  if ([file, ...args].some(value => /[\r\n\0]/.test(value))) throw failure('START')
  const escaped = file.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1')
  // 批次檔通常用 %* 再轉交一次；兩層都要跳脫，否則 ^、& 等會被吃掉。
  const line = [escaped, ...args.map(cmdArgument)].join(' ')
  return { command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } }
}

function stopTree(child) {
  if (!child?.pid) return Promise.resolve()
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
    const finish = () => { clearTimeout(timer); child.kill(); resolve() }
    const timer = setTimeout(finish, 3000)
    killer.once('error', finish)
    killer.once('close', finish)
  })
}

function readStdio(child, fail, receive) {
  let buffer = ''
  child.once('error', () => fail('START'))
  child.once('close', () => fail('START'))
  child.stdin.on('error', () => fail('START'))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_BYTES) { buffer = ''; fail('FORMAT'); return }
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line) receive(line)
    }
  })
}

function stdioTransport(spec, signal) {
  let child
  let pending
  let broken = ''
  let closing
  let stopped = false
  const fail = code => { broken = code; pending?.reject(failure(code)); pending = null }
  const receive = line => {
    try {
      const message = json(line)
      if (!object(message) || message.jsonrpc !== '2.0') throw failure('FORMAT')
      if (pending && !Object.hasOwn(message, 'method') && message.id === pending.id) {
        const waiting = pending
        const result = resultOf(message, waiting.id)
        pending = null
        waiting.resolve(result)
      }
    } catch { fail('FORMAT') }
  }
  async function start() {
    const env = environment(spec)
    const target = await launch(spec, env)
    if (stopped || signal.aborted) throw failure('CANCELLED')
    child = spawn(target.command, target.args, { ...target.options, env, cwd: os.homedir(),
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] })
    readStdio(child, fail, receive)
  }
  function send(message) {
    if (broken) return Promise.reject(failure(broken))
    if (message.id === undefined) {
      return new Promise((resolve, reject) => child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(failure('START')) : resolve()))
    }
    return new Promise((resolve, reject) => {
      pending = { id: message.id, resolve, reject }
      child.stdin.write(JSON.stringify(message) + '\n', error => { if (error) fail('START') })
    })
  }
  function close() {
    stopped = true
    if (!closing) { fail('CANCELLED'); closing = stopTree(child) }
    return closing
  }
  return { start, send, close }
}

function sseMessage(event, id) {
  const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n')
  if (!data) return null
  const message = json(data)
  if (!object(message) || message.jsonrpc !== '2.0') throw failure('FORMAT')
  return !Object.hasOwn(message, 'method') && message.id === id ? resultOf(message, id) : null
}

async function readReply(response, id) {
  const type = response.headers.get('content-type') || ''
  const sse = /^text\/event-stream\b/i.test(type)
  if (!response.body || !sse && !/^application\/json\b/i.test(type)) throw failure('FORMAT')
  let buffer = ''
  let size = 0
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_BYTES) throw failure('FORMAT')
    buffer += decoder.decode(chunk, { stream: true })
    if (!sse) continue
    let match
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const result = sseMessage(event, id)
      if (result) return result
    }
  }
  if (sse) throw failure('FORMAT')
  return resultOf(json(buffer + decoder.decode()), id)
}

function httpTransport(spec) {
  const controllers = new Set()
  let session = ''
  let version = ''
  function headers() {
    const out = new Headers(spec.headers || {})
    out.set('Content-Type', 'application/json')
    out.set('Accept', 'application/json, text/event-stream')
    if (session) out.set('Mcp-Session-Id', session)
    if (version) out.set('MCP-Protocol-Version', version)
    return out
  }
  async function send(message) {
    const controller = new AbortController()
    controllers.add(controller)
    let response
    try {
      const url = new URL(spec.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('FORMAT')
      response = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(message),
        signal: controller.signal, redirect: 'error' })
      if ([401, 403].includes(response.status)) throw failure('AUTH')
      if (!response.ok) throw failure('FORMAT')
      if (message.id === undefined) return
      session = response.headers.get('mcp-session-id') || session
      const result = await readReply(response, message.id)
      if (message.method === 'initialize') version = result.protocolVersion
      return result
    } finally {
      controller.abort()
      controllers.delete(controller)
    }
  }
  function close() { for (const controller of controllers) controller.abort() }
  return { start: async () => {}, send, close }
}

function toolSummary(tool) {
  if (!object(tool) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 1024 ||
      (tool.description !== undefined && typeof tool.description !== 'string')) throw failure('FORMAT')
  const paragraph = (tool.description || '').trim().split(/\r?\n\s*\r?\n/, 1)[0].replace(/\s+/g, ' ')
  return { name: tool.name, description: Array.from(paragraph).slice(0, 200).join('') }
}

async function discover(transport, ms, signal) {
  const init = await step(async () => {
    await transport.start()
    return transport.send(request(1, 'initialize', { protocolVersion: VERSION, capabilities: {},
      clientInfo: { name: 'AxonDeck', version: '1.0.0' } }))
  }, ms, signal, 'INITIALIZE_TIMEOUT')
  if (!object(init) || typeof init.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion) ||
      !object(init.capabilities) || !object(init.serverInfo) || typeof init.serverInfo.name !== 'string' ||
      typeof init.serverInfo.version !== 'string') throw failure('FORMAT')
  await step(() => transport.send(request(undefined, 'notifications/initialized')), ms, signal, 'INITIALIZE_TIMEOUT')
  const tools = []
  let cursor
  for (let page = 0; page < 5 && tools.length < 200; page++) {
    const result = await step(() => transport.send(request(page + 2, 'tools/list', cursor ? { cursor } : {})), ms, signal, 'TOOLS_TIMEOUT')
    if (!Array.isArray(result.tools) || (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')) throw failure('FORMAT')
    for (const tool of result.tools.slice(0, 200 - tools.length)) tools.push(toolSummary(tool))
    if (!result.nextCursor || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  return { ok: true, tools, count: tools.length }
}

function selection(req) {
  if (!object(req) || Object.keys(req).some(key => !['home', 'id'].includes(key)) ||
      !['claude', 'codex', 'grok', 'opencode'].includes(req.home) || typeof req.id !== 'string' ||
      sanitizeId(req.id) !== req.id) throw failure('FORMAT')
  return JSON.stringify([req.home, req.id])
}

function createChecker({ list = homes.list, stdioMs = 30_000, httpMs = 60_000 } = {}) {
  const jobs = new Map()
  function check(req, read = list) {
    let key
    try { key = selection(req) } catch { return Promise.resolve({ ok: false, code: 'FORMAT', reason: REASONS.FORMAT }) }
    const previous = jobs.get(key)
    previous?.controller.abort()
    const job = { controller: new AbortController(), promise: null }
    jobs.set(key, job)
    job.promise = (async () => {
      let transport
      try {
        await previous?.promise
        if (job.controller.signal.aborted) throw failure('CANCELLED')
        const item = (await read(req.home)).servers.find(row => row.id === req.id)
        if (!item) throw failure('FORMAT')
        if (item.spec.type === 'sse') throw failure('UNSUPPORTED')
        transport = item.spec.type === 'stdio' ? stdioTransport(item.spec, job.controller.signal) : httpTransport(item.spec)
        return await discover(transport, item.spec.type === 'stdio' ? stdioMs : httpMs, job.controller.signal)
      } catch (error) {
        const code = Object.hasOwn(REASONS, error?.code) ? error.code : 'START'
        return { ok: false, code, reason: REASONS[code] }
      } finally {
        await transport?.close()
        if (jobs.get(key) === job) jobs.delete(key)
      }
    })()
    return job.promise
  }
  async function shutdown() {
    const active = [...jobs.values()]
    for (const job of active) job.controller.abort()
    await Promise.all(active.map(job => job.promise))
  }
  return { check, shutdown }
}

// launch 也給 usage/warmup.js 代跑 CLI 用（同一套 PATHEXT 解析與 .cmd 引號）
module.exports = { createChecker, launch, ...createChecker() }
