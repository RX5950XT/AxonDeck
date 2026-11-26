'use strict'

/** 本機代理（CC Proxy 轉換閘道、AGY／Grok 反代）共用的 HTTP 小工具。 */

const http = require('http')
const { timingSafeEqual } = require('crypto')

/** 只接受指向本機的 Host，擋 DNS rebinding（惡意網域解析到 127.0.0.1） */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function hostAllowed(req) {
  const host = String(req.headers.host || '')
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return ALLOWED_HOSTS.has(name)
}

/**
 * Claude Code 送 `x-api-key`；有些客戶端送 Bearer。
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function presentedKey(req) {
  const header = String(req.headers.authorization || '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' ? apiKey.trim() : ''
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/**
 * 讀完整個 body（字串）。超過上限就中斷連線；錯誤的 message 與 code 都是錯誤代碼。
 * @param {import('http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes) {
  const fail = (code) => Object.assign(new Error(code), { code })
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(fail('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(fail('BODY_READ_FAILED')))
  })
}

/**
 * 錯誤回應要長成各協議自己的形狀，否則客戶端會解析失敗。
 * @param {import('http').ServerResponse} res
 * @param {'openai'|'anthropic'} protocol
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function sendProtocolError(res, protocol, status, code, message) {
  const text = message || code
  if (protocol === 'anthropic') {
    sendJson(res, status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message: text } })
    return
  }
  sendJson(res, status, { error: { message: text, type: status < 500 ? 'invalid_request_error' : 'api_error', code } })
}

/**
 * 反代（AGY、Grok）共用的本機 HTTP 服務：只綁 127.0.0.1、Host 必須是本機、強制金鑰。
 * `/health` 不需鑑權（客戶端與設定頁都靠它探測）；其餘照 `routes['<METHOD> <path>']` 分派。
 * @param {Record<string, (req: import('http').IncomingMessage, res: import('http').ServerResponse) => unknown>} routes
 */
function createProxyServer(routes) {
  const HOST = '127.0.0.1'
  let server = null
  let settings = { port: 0, apiKey: '', logBodies: false }
  let startedAt = 0
  let activeRequests = 0

  function handle(req, res) {
    const pathname = String(req.url || '').split('?')[0]
    if (pathname === '/health' || pathname === '/healthz') {
      sendJson(res, 200, { ok: true, uptimeMs: startedAt ? Date.now() - startedAt : 0 })
      return
    }
    if (!hostAllowed(req)) {
      sendProtocolError(res, 'openai', 403, 'FORBIDDEN_HOST', '只接受本機連線')
      return
    }
    const protocol = pathname.startsWith('/v1/messages') ? 'anthropic' : 'openai'
    if (!settings.apiKey || !safeEqual(presentedKey(req), settings.apiKey)) {
      sendProtocolError(res, protocol, 401, 'UNAUTHORIZED', 'API key 不正確')
      return
    }
    const handler = routes[`${req.method} ${pathname}`]
    if (!handler) {
      sendProtocolError(res, protocol, 404, 'NOT_FOUND', '端點不存在')
      return
    }
    void Promise.resolve().then(() => handler(req, res)).catch(() => {
      if (!res.headersSent) sendProtocolError(res, protocol, 500, 'INTERNAL_ERROR', '內部錯誤')
      else if (!res.writableEnded) res.end()
    })
  }

  /** @param {{ port: number, apiKey: string, logBodies: boolean }} next */
  function applySettings(next) {
    settings = {
      port: Number(next.port) || settings.port,
      apiKey: typeof next.apiKey === 'string' ? next.apiKey : settings.apiKey,
      logBodies: next.logBodies === true
    }
  }

  function start(next) {
    applySettings(next)
    if (server) return Promise.resolve({ ok: true, port: settings.port })
    if (!settings.apiKey) return Promise.resolve({ ok: false, error: 'NO_API_KEY' })
    return new Promise((resolve) => {
      const instance = http.createServer((req, res) => {
        activeRequests += 1
        res.on('close', () => { activeRequests -= 1 })
        handle(req, res)
      })
      // 單一請求可能跑很久（長回覆），關掉 Node 預設的 socket 逾時
      instance.requestTimeout = 0
      instance.headersTimeout = 60_000
      instance.keepAliveTimeout = 75_000
      instance.once('error', (error) => {
        if (server === instance) server = null
        resolve({ ok: false, error: error?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'LISTEN_FAILED' })
      })
      instance.listen(settings.port, HOST, () => {
        server = instance
        startedAt = Date.now()
        resolve({ ok: true, port: settings.port })
      })
    })
  }

  function stop() {
    if (!server) return Promise.resolve(true)
    const instance = server
    server = null
    startedAt = 0
    return new Promise((resolve) => {
      instance.closeAllConnections?.()
      instance.close(() => resolve(true))
      // close 在還有 keep-alive 連線時可能不回呼，給它一個上限
      setTimeout(() => resolve(true), 2000).unref?.()
    })
  }

  function status() {
    // 回實際監聽到的埠，不是設定值：port 0 由 OS 指派，兩者會不同
    const bound = server?.address?.()
    return {
      running: !!server,
      host: HOST,
      port: bound && typeof bound === 'object' ? bound.port : settings.port,
      uptimeMs: startedAt ? Date.now() - startedAt : 0,
      activeRequests
    }
  }

  return { HOST, applySettings, getSettings: () => settings, start, stop, status }
}

/**
 * 逐格讀上游 SSE，每格 JSON 交給 onPayload；`[DONE]` 與非 JSON 心跳略過。
 * onPayload 丟出的錯（上游回報失敗）不吞，要讓呼叫端回錯誤而不是假成功。
 * @param {Response} response
 * @param {(payload: object, raw: string) => void} onPayload
 * @param {() => void} [onActivity] 每收到一塊資料呼叫一次（重設閒置計時）
 */
async function readSse(response, onPayload, onActivity) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (!done) onActivity?.()
      buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        const data = line.startsWith('data:') ? line.slice(5).trim() : ''
        if (data && data !== '[DONE]') {
          let payload = null
          try {
            payload = JSON.parse(data)
          } catch {
            // 心跳或註解行
          }
          if (payload) onPayload(payload, data)
        }
        index = buffer.indexOf('\n')
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}

const PING_TIMEOUT_MS = 60_000
const PING_PROMPT = '請只回覆「OK」兩個字。'

/**
 * 反代的端到端自我測試：從**本機閘道**真的送一則訊息出去。
 *
 * 刻意走 loopback HTTP 而不是直接呼叫上游：客戶端走的是
 * 「HTTP → 金鑰鑑權 → 模型映射 → 憑證 → 上游」整條路，只測上游等於漏掉前半段。
 * 失敗只回代碼與 server 自己寫的白名單訊息，不是上游原文。
 * @param {{ host: string, port: number }} serverStatus
 * @param {string} apiKey
 * @param {string} model
 * @param {Function} [fetchImpl]
 */
async function pingGateway(serverStatus, apiKey, model, fetchImpl = globalThis.fetch) {
  const startedMs = Date.now()
  let response
  try {
    response = await fetchImpl(`http://${serverStatus.host}:${serverStatus.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // 推理模型的思考也算在 max_tokens 裡（Hydrogen low 約 100），給太少會只剩空白回覆
      body: JSON.stringify({ model, messages: [{ role: 'user', content: PING_PROMPT }], max_tokens: 512, stream: false }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, code: 'UNREACHABLE', model, durationMs: Date.now() - startedMs, message: '連不上本機閘道，請確認監聽埠沒有被其他程式占用。' }
  }
  const durationMs = Date.now() - startedMs
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`
    const message = typeof payload?.error?.message === 'string' ? payload.error.message : '閘道回報請求失敗。'
    return { ok: false, code, model, status: response.status, durationMs, message }
  }
  const reply = String(payload?.choices?.[0]?.message?.content || '').trim().slice(0, 120)
  return { ok: true, model, status: 200, durationMs, reply }
}

module.exports = { safeEqual, hostAllowed, presentedKey, sendJson, readBody, readSse, sendProtocolError, createProxyServer, pingGateway }
