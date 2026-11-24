'use strict'

const http = require('http')
const { randomUUID } = require('crypto')
const { safeEqual, hostAllowed, presentedKey, sendJson } = require('../local-proxy-http')
const convert = require('../ccswitch/gateway/convert')
const catalog = require('./catalog')
const logs = require('./logs')
const openai = require('./openai')
const upstream = require('./upstream')

/**
 * Grok 反代的本機 HTTP 服務。防護照 AGY：只綁 127.0.0.1、Host 必須是本機、強制金鑰、
 * body 有上限；上游狀態碼不透傳（只有 429 照回），錯誤訊息只用我們自己寫的字。
 *
 * 三種客戶端協議，上游一律是 Grok 的 Responses 串流：
 * - `/v1/chat/completions`（OpenAI Chat）→ 轉 Responses，再把串流轉回 Chat
 * - `/v1/messages`（Anthropic，Claude Code）→ 共用 CC Proxy 閘道的轉換器
 * - `/v1/responses`（OpenAI Responses，Codex 之類）→ 只換模型名，串流原樣轉送
 */

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 32 * 1024 * 1024
const FIRST_TOKEN_MS = 120_000
const IDLE_MS = 180_000

let server = null
let settings = { port: 0, apiKey: '', logBodies: false }
let startedAt = 0
let activeRequests = 0
/** e2e 注入點（baseUrl／fetchImpl／credential），不經 IPC */
let upstreamOptions = {}

function configureUpstream(options) {
  upstreamOptions = options && typeof options === 'object' ? options : {}
}

function getUpstreamOptions() {
  return upstreamOptions
}

function sendError(res, protocol, status, code, message) {
  if (protocol === 'anthropic') {
    sendJson(res, status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message } })
    return
  }
  sendJson(res, status, { error: { message, type: status === 401 ? 'invalid_request_error' : 'api_error', code } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(Object.assign(new Error('BODY_READ_FAILED'), { code: 'BODY_READ_FAILED' })))
  })
}

function statusFor(code) {
  if (code === 'BODY_TOO_LARGE') return 413
  if (code === 'INVALID_JSON') return 400
  if (code === 'NO_CREDENTIAL' || code === 'TOKEN_EXPIRED') return 503
  if (code === 'RATE_LIMITED') return 429
  if (code === 'CLIENT_ABORTED') return 499
  return 502
}

const MESSAGES = Object.freeze({
  QUOTA_EXHAUSTED: 'Grok 本週額度已用完，等重置後再試',
  RATE_LIMITED: '上游要求稍後再試',
  UPSTREAM_AUTH: '上游拒絕了 Grok 登入（可能要重新登入 grok）',
  UPSTREAM_TIMEOUT: '上游太久沒有回應',
  UPSTREAM_IDLE: '上游串流太久沒有動靜',
  UPSTREAM_FAILED: '上游回報這次生成失敗',
  BODY_TOO_LARGE: '請求太大',
  INVALID_JSON: '請求不是合法的 JSON'
})

/**
 * 依協議組上游請求與收集器。
 * @param {'openai'|'anthropic'|'responses'} protocol
 * @param {object} body
 * @param {{ model: string, mapped: string, effort: string }} resolved
 */
function adapterFor(protocol, body, resolved) {
  const { model, mapped, effort } = resolved
  if (protocol === 'openai') {
    return {
      request: openai.toResponsesRequest(body, mapped, effort),
      collector: openai.createCollector(model, body?.stream_options?.include_usage === true),
      mapper: openai
    }
  }
  if (protocol === 'anthropic') {
    const request = convert.toResponsesRequest(body, mapped)
    if (effort) request.reasoning = { effort }
    return { request, collector: convert.createCollector(model), mapper: convert }
  }
  const request = { ...body, model: mapped }
  if (effort) request.reasoning = { ...(body?.reasoning || {}), effort }
  return { request, collector: { usage: null, finish: '', final: null, text: '' }, mapper: null }
}

/** Responses 原樣轉送時，從事件裡撿用量與最後的 response 物件 */
function trackResponses(collector, payload) {
  const type = String(payload?.type || '')
  if (type === 'response.output_text.delta' && typeof payload.delta === 'string') collector.text += payload.delta
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    collector.final = payload.response || null
    collector.finish = type
    const usage = payload.response?.usage
    if (usage) {
      collector.usage = {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cached: Number(usage.input_tokens_details?.cached_tokens) || 0,
        thought: Number(usage.output_tokens_details?.reasoning_tokens) || 0
      }
    }
  }
}

/**
 * 三種協議共用的管線：讀 body → 解析模型 → 打上游串流 → 轉回客戶端協議 → 記日誌。
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {'openai'|'anthropic'|'responses'} protocol
 */
async function handleCompletion(req, res, protocol) {
  const startedMs = Date.now()
  const entry = { id: randomUUID(), ts: startedMs, protocol, path: String(req.url || '').split('?')[0], status: 0, durationMs: 0, stream: false }
  let adapter = null
  let wroteHeaders = false
  const controller = new AbortController()
  let timer = null
  let timeoutCode = ''
  const arm = (ms, code) => {
    clearTimeout(timer)
    timer = setTimeout(() => { timeoutCode = code; controller.abort() }, ms)
  }
  res.on('close', () => {
    clearTimeout(timer)
    if (!res.writableEnded) controller.abort()
  })

  try {
    const raw = await readBody(req)
    if (settings.logBodies) entry.requestBody = raw
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      throw Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON' })
    }

    const resolved = catalog.resolveModel(body?.model, await catalog.snapshot({ options: upstreamOptions }))
    entry.model = resolved.model
    entry.mappedModel = resolved.effort ? `${resolved.mapped} · ${resolved.effort}` : resolved.mapped
    entry.stream = body?.stream === true
    adapter = adapterFor(protocol, body, resolved)

    arm(FIRST_TOKEN_MS, 'UPSTREAM_TIMEOUT')
    const response = await upstream.responses(adapter.request, { signal: controller.signal, options: upstreamOptions })
    const state = convert.newConsumeState()
    const write = (text) => { if (text && !res.writableEnded) res.write(text) }

    if (entry.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      wroteHeaders = true
    }
    entry.status = 200

    await upstream.readSse(response, (payload, rawData) => {
      if (!adapter.mapper) {
        trackResponses(adapter.collector, payload)
        if (entry.stream) write(`event: ${payload.type || 'message'}\ndata: ${rawData}\n\n`)
        return
      }
      for (const delta of convert.consumeResponses(payload, state)) {
        const chunk = adapter.mapper.apply(adapter.collector, delta)
        if (entry.stream) write(chunk)
      }
    }, () => arm(IDLE_MS, 'UPSTREAM_IDLE'))
    clearTimeout(timer)

    if (!adapter.collector.finish) throw Object.assign(new Error('UPSTREAM_FAILED'), { code: 'UPSTREAM_FAILED' })
    if (entry.stream) {
      if (adapter.mapper) write(adapter.mapper.closeStream(adapter.collector))
    } else if (adapter.mapper) {
      sendJson(res, 200, adapter.mapper.toResponse(adapter.collector))
    } else if (adapter.collector.final) {
      sendJson(res, 200, adapter.collector.final)
    } else {
      throw Object.assign(new Error('UPSTREAM_FAILED'), { code: 'UPSTREAM_FAILED' })
    }
    if (settings.logBodies) entry.responseBody = adapter.collector.text
  } catch (error) {
    clearTimeout(timer)
    const own = typeof error?.code === 'string' ? error.code : ''
    const code = timeoutCode || (controller.signal.aborted ? 'CLIENT_ABORTED' : '') ||
      (error?.message === 'UPSTREAM_FAILED' ? 'UPSTREAM_FAILED' : own) || 'INTERNAL_ERROR'
    entry.errorCode = code
    entry.status = statusFor(code)
    if (wroteHeaders) {
      if (adapter?.mapper && !res.writableEnded) res.write(adapter.mapper.errorStream(adapter.collector, code))
    } else if (!res.writableEnded && !res.headersSent) {
      if (error?.retryAfter) res.setHeader('retry-after', error.retryAfter)
      sendError(res, protocol === 'anthropic' ? 'anthropic' : 'openai', entry.status, code,
        error?.userMessage || MESSAGES[code] || `上游請求失敗（${code}）`)
    }
  } finally {
    if (!res.writableEnded) res.end()
    entry.durationMs = Date.now() - startedMs
    const usage = adapter?.collector?.usage
    if (usage) {
      entry.inputTokens = usage.input
      entry.outputTokens = usage.output
      entry.cachedTokens = usage.cached
      entry.thoughtTokens = usage.thought || 0
    }
    logs.append(entry)
  }
}

/**
 * Claude Code 會呼叫 count_tokens 估上下文。上游沒有這支，用字數粗估（約 4 字元一 token），
 * 比回 404 讓它整段功能失效好。
 */
async function handleCountTokens(req, res) {
  try {
    const body = JSON.parse(await readBody(req))
    const size = JSON.stringify([body?.system ?? '', body?.messages ?? [], body?.tools ?? []]).length
    sendJson(res, 200, { input_tokens: Math.ceil(size / 4) })
  } catch (error) {
    const code = error?.code || 'INVALID_JSON'
    sendError(res, 'anthropic', statusFor(code), code, MESSAGES[code] || '無法計算 token')
  }
}

function route(req, res) {
  const pathname = String(req.url || '').split('?')[0]
  if (pathname === '/health' || pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptimeMs: startedAt ? Date.now() - startedAt : 0 })
    return
  }
  if (!hostAllowed(req)) {
    sendError(res, 'openai', 403, 'FORBIDDEN_HOST', '只接受本機連線')
    return
  }
  const protocol = pathname.startsWith('/v1/messages') ? 'anthropic' : 'openai'
  if (!settings.apiKey || !safeEqual(presentedKey(req), settings.apiKey)) {
    sendError(res, protocol, 401, 'UNAUTHORIZED', 'API key 不正確')
    return
  }

  if (req.method === 'GET' && pathname === '/v1/models') {
    void catalog.listForApi({ options: upstreamOptions })
      .then((data) => sendJson(res, 200, { object: 'list', data }))
      .catch(() => sendError(res, 'openai', 502, 'UPSTREAM_ERROR', '無法取得模型清單'))
    return
  }
  if (req.method === 'POST' && pathname === '/v1/chat/completions') return void handleCompletion(req, res, 'openai')
  if (req.method === 'POST' && pathname === '/v1/responses') return void handleCompletion(req, res, 'responses')
  if (req.method === 'POST' && pathname === '/v1/messages') return void handleCompletion(req, res, 'anthropic')
  if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') return void handleCountTokens(req, res)
  sendError(res, protocol, 404, 'NOT_FOUND', '端點不存在')
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
      try {
        route(req, res)
      } catch {
        if (!res.writableEnded) sendError(res, 'openai', 500, 'INTERNAL_ERROR', '內部錯誤')
      }
    })
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
    setTimeout(() => resolve(true), 2000).unref?.()
  })
}

function status() {
  const bound = server?.address?.()
  return {
    running: !!server,
    host: HOST,
    port: bound && typeof bound === 'object' ? bound.port : settings.port,
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
    activeRequests
  }
}

module.exports = {
  HOST,
  MAX_BODY_BYTES,
  applySettings,
  configureUpstream,
  getUpstreamOptions,
  start,
  status,
  stop
}
