'use strict'

const { randomUUID } = require('crypto')
const { createProxyServer, readBody: readRequestBody, sendJson, sendProtocolError: sendError } = require('../local-proxy-http')
const anthropic = require('./anthropic')
const catalog = require('./catalog')
const logs = require('./logs')
const openai = require('./openai')
const upstream = require('./upstream')
const { firstCandidate, splitParts, unwrapEnvelope } = require('./gemini')
const { DEFAULT_IMAGE_MODEL, isImageModel, listModels, resolveModel } = require('./model-map')

const MAX_BODY_BYTES = 32 * 1024 * 1024

const ADAPTERS = Object.freeze({
  openai: { protocol: 'openai', mapper: openai },
  anthropic: { protocol: 'anthropic', mapper: anthropic }
})

/**
 * 上游注入點：正式執行時是空物件（走真的 cloudcode-pa 與本機憑證），
 * e2e 用它把 baseUrl 與憑證鏈指向 mock。不經過 IPC，renderer 碰不到。
 */
let upstreamOptions = {}

function configureUpstream(options) {
  upstreamOptions = options && typeof options === 'object' ? options : {}
}

// ===== 共用小工具 =====

const readBody = (req) => readRequestBody(req, MAX_BODY_BYTES)

/**
 * 上游狀態碼 → 回給客戶端的狀態碼。
 * 只有 429 值得原樣透傳（客戶端知道要等）；其餘一律收斂成 502，
 * 直接把上游的 401／403 丟回去會讓客戶端誤判成自己的 API key 有問題。
 */
function statusFor(error, code) {
  if (code === 'BODY_TOO_LARGE') return 413
  if (code === 'NO_CREDENTIAL' || code === 'TOKEN_EXPIRED') return 503
  if (code === 'CLIENT_ABORTED') return 499
  if (error?.status === 429) return 429
  return 502
}

// ===== 請求管線 =====

/**
 * 兩個協議共用：讀 body → 轉 Gemini → 呼叫上游 → 轉回目標協議 → 記日誌。
 * 差別只在傳進來的 adapter。
 */
async function handleCompletion(req, res, adapter) {
  const startedMs = Date.now()
  const { protocol, mapper } = adapter
  const entry = {
    id: randomUUID(),
    ts: startedMs,
    protocol,
    path: req.url.split('?')[0],
    status: 0,
    durationMs: 0,
    stream: false
  }

  let collector = null
  let wroteHeaders = false

  try {
    const raw = await readBody(req)
    if (proxy.getSettings().logBodies) entry.requestBody = raw

    let body
    try {
      body = JSON.parse(raw)
    } catch {
      entry.status = 400
      entry.errorCode = 'INVALID_JSON'
      sendError(res, protocol, 400, 'INVALID_JSON', '請求不是合法的 JSON')
      return
    }

    const { model, mapped } = resolveModel(body.model, await catalog.snapshot({ options: upstreamOptions }))
    entry.model = model
    entry.mappedModel = mapped
    entry.stream = body.stream === true

    const inner = mapper.toGeminiRequest(body, mapped)
    collector = mapper.createCollector(model || mapped)

    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    if (!entry.stream) {
      const payload = await upstream.once({ inner, model: mapped, signal: controller.signal, options: upstreamOptions })
      mapper.consume(collector, payload)
      const response = mapper.toResponse(collector)
      entry.status = 200
      if (proxy.getSettings().logBodies) entry.responseBody = JSON.stringify(response)
      sendJson(res, 200, response)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    wroteHeaders = true
    entry.status = 200

    await upstream.stream({
      inner,
      model: mapped,
      signal: controller.signal,
      options: upstreamOptions,
      onFrame: (payload) => {
        const chunk = mapper.consume(collector, payload)
        if (chunk && !res.writableEnded) res.write(chunk)
      }
    })
    if (!res.writableEnded) res.write(mapper.closeStream(collector))
    if (proxy.getSettings().logBodies) entry.responseBody = collector.text
  } catch (error) {
    const code = error?.code || (error?.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR')
    entry.errorCode = code
    const status = statusFor(error, code)
    entry.status = status

    if (wroteHeaders) {
      // 已經回過 200，只能用串流內的錯誤格告知客戶端
      if (!res.writableEnded) res.write(mapper.errorStream(collector, code))
    } else if (!res.writableEnded) {
      const message = code === 'NO_CREDENTIAL' || code === 'TOKEN_EXPIRED'
        ? error.message
        : `上游請求失敗（${code}）`
      if (error?.retryAfter) res.setHeader('retry-after', error.retryAfter)
      sendError(res, protocol, status, code, message)
    }
  } finally {
    if (!res.writableEnded) res.end()
    entry.durationMs = Date.now() - startedMs
    if (collector?.usage) {
      entry.inputTokens = collector.usage.input
      entry.outputTokens = collector.usage.output
      entry.thoughtTokens = collector.usage.thought
      entry.cachedTokens = collector.usage.cached
    }
    logs.append(entry)
  }
}

async function handleCountTokens(req, res) {
  try {
    const body = JSON.parse(await readBody(req))
    const { mapped } = resolveModel(body.model, await catalog.snapshot({ options: upstreamOptions }))
    const inner = anthropic.toGeminiRequest(body, mapped)
    const total = await upstream.countTokens({ inner, model: mapped, options: upstreamOptions })
    sendJson(res, 200, { input_tokens: total })
  } catch (error) {
    // 走 statusFor，跟另外兩個端點同一套：上游狀態碼不透傳。
    // 原本 `error.status >= 400 ? error.status : 502` 會把上游的 401／403 原樣丟回去，
    // 客戶端（Claude Code CLI 就是靠 count_tokens 估上下文的）會誤判成自己的 API key 壞了。
    const code = error?.code || 'INTERNAL_ERROR'
    if (error?.retryAfter) res.setHeader('retry-after', error.retryAfter)
    sendError(res, 'anthropic', statusFor(error, code), code, `無法計算 token（${code}）`)
  }
}

/** OpenAI 的 size → 上游 imageConfig.aspectRatio；不認得就不帶（上游預設 1:1） */
const IMAGE_ASPECTS = Object.freeze({
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1024x1792': '9:16'
})
const MAX_IMAGES = 4

/** OpenAI /v1/images/generations：每張圖各打一次上游（上游一次只回一張） */
async function handleImages(req, res) {
  const startedMs = Date.now()
  const entry = { id: randomUUID(), ts: startedMs, protocol: 'openai', path: '/v1/images/generations', status: 0, durationMs: 0, stream: false }
  try {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      if (error?.message === 'BODY_TOO_LARGE') throw error
      entry.status = 400
      entry.errorCode = 'INVALID_JSON'
      sendError(res, 'openai', 400, 'INVALID_JSON', '請求不是合法的 JSON')
      return
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) {
      entry.status = 400
      entry.errorCode = 'INVALID_PROMPT'
      sendError(res, 'openai', 400, 'INVALID_PROMPT', 'prompt 不可為空')
      return
    }
    const resolved = resolveModel(body.model || DEFAULT_IMAGE_MODEL, await catalog.snapshot({ options: upstreamOptions })).mapped
    const mapped = isImageModel(resolved) ? resolved : DEFAULT_IMAGE_MODEL
    entry.model = typeof body.model === 'string' ? body.model : ''
    entry.mappedModel = mapped

    const aspectRatio = IMAGE_ASPECTS[body.size]
    const inner = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}) }
    }
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    const count = Math.min(MAX_IMAGES, Math.max(1, Math.floor(Number(body.n)) || 1))
    const data = []
    for (let i = 0; i < count; i += 1) {
      const payload = await upstream.once({ inner, model: mapped, signal: controller.signal, options: upstreamOptions })
      const { images } = splitParts(firstCandidate(unwrapEnvelope(payload)))
      for (const image of images) {
        data.push(body.response_format === 'url'
          ? { url: `data:${image.mimeType};base64,${image.data}` }
          : { b64_json: image.data })
      }
    }
    if (!data.length) {
      // 通常是安全過濾擋掉，上游只回文字或空內容
      entry.status = 502
      entry.errorCode = 'NO_IMAGE'
      sendError(res, 'openai', 502, 'NO_IMAGE', '上游沒有產生圖片（可能被內容過濾擋下）')
      return
    }
    entry.status = 200
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data })
  } catch (error) {
    const code = error?.code || (error?.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR')
    entry.errorCode = code
    entry.status = statusFor(error, code)
    if (error?.retryAfter) res.setHeader('retry-after', error.retryAfter)
    if (!res.writableEnded) sendError(res, 'openai', entry.status, code, `生圖失敗（${code}）`)
  } finally {
    if (!res.writableEnded) res.end()
    entry.durationMs = Date.now() - startedMs
    logs.append(entry)
  }
}

/**
 * 靜態表只是退路：它列過會 404／500 的模型，而且缺整個新世代。
 * 客戶端拿這份填下拉選單，給錯清單等於讓使用者選到不能用的模型。
 */
function handleModels(req, res) {
  return catalog.listForApi({ options: upstreamOptions })
    .then((live) => sendJson(res, 200, { object: 'list', data: live || listModels() }))
    .catch(() => sendJson(res, 200, { object: 'list', data: listModels() }))
}

const proxy = createProxyServer({
  'GET /v1/models': handleModels,
  'GET /v1/models/claude': handleModels,
  'POST /v1/chat/completions': (req, res) => handleCompletion(req, res, ADAPTERS.openai),
  'POST /v1/images/generations': handleImages,
  'POST /v1/messages': (req, res) => handleCompletion(req, res, ADAPTERS.anthropic),
  'POST /v1/messages/count_tokens': handleCountTokens
})

/** e2e 注入的上游設定；型錄也要走同一份，否則測試會打到真實上游 */
function getUpstreamOptions() {
  return upstreamOptions
}

module.exports = {
  getUpstreamOptions,
  HOST: proxy.HOST,
  MAX_BODY_BYTES,
  applySettings: proxy.applySettings,
  configureUpstream,
  start: proxy.start,
  status: proxy.status,
  stop: proxy.stop
}
