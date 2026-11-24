'use strict'

const { setTimeout: delay } = require('timers/promises')
const credential = require('../ccswitch/gateway/credential')

/**
 * Grok 訂閱（SuperGrok）的上游：Grok CLI 自己打的 `cli-chat-proxy.grok.com`。
 *
 * 實測（2026-11-19）：
 * - 只有 `/v1/responses`（串流）能用；`/v1/chat/completions` 一律 403 spending-limit，
 *   所以 OpenAI Chat／Anthropic 兩種客戶端都要在本機轉成 Responses。
 * - 不帶 `x-grok-client-version` 會 426；只驗「夠不夠新」，不比對本機裝的版本。
 * - 每週額度用完回 402 `Grok Build usage balance exhausted`。
 *
 * 憑證沿用 `~/.grok/auth.json`（Grok CLI 登入的那組），過期交給 CLI 續期——跟 CC Proxy 閘道同一套。
 */

const BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
const GROK_CLI_VERSION = '1.0.13'
const PROVIDER = 'grok-build'

/**
 * @typedef {object} UpstreamOptions e2e 注入點；正式執行是空物件
 * @property {string} [baseUrl]
 * @property {Function} [fetchImpl]
 * @property {{ acquire: Function, invalidate: Function }} [credential]
 */

class UpstreamError extends Error {
  /** @param {string} code @param {number} status @param {string} [retryAfter] */
  constructor(code, status, retryAfter) {
    super(code)
    this.code = code
    this.status = status
    if (retryAfter) this.retryAfter = retryAfter
  }
}

/** @param {UpstreamOptions} options */
function credOf(options) {
  return options?.credential || credential
}

/**
 * @param {UpstreamOptions} options
 * @param {boolean} force
 * @returns {Promise<Record<string, string>>}
 */
async function authHeaders(options, force) {
  try {
    const { token } = await credOf(options).acquire(PROVIDER, { force })
    return { Authorization: `Bearer ${token}`, 'x-grok-client-version': GROK_CLI_VERSION }
  } catch (error) {
    // 只往外帶我們自己寫的訊息（credentialError 的 userMessage），代碼統一收斂
    const code = error?.code === 'NO_CREDENTIAL' ? 'NO_CREDENTIAL' : 'TOKEN_EXPIRED'
    const wrapped = new Error(error?.userMessage || 'Grok 登入無法使用，請在終端機重跑一次 grok')
    wrapped.code = code
    wrapped.userMessage = wrapped.message
    throw wrapped
  }
}

/** 上游狀態碼 → 我們的錯誤代碼（不透傳上游 body） */
function codeForStatus(status) {
  if (status === 402) return 'QUOTA_EXHAUSTED'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 401 || status === 403) return 'UPSTREAM_AUTH'
  return `UPSTREAM_${status}`
}

/**
 * 打一次上游，401 換 token 重來、502／503／504 等半秒重試一次。
 * 回傳的 Response 一定是 ok；失敗一律丟 UpstreamError。
 * @param {string} path
 * @param {{ method?: string, body?: object, signal?: AbortSignal, accept?: string, options?: UpstreamOptions }} params
 * @returns {Promise<Response>}
 */
async function request(path, { method = 'GET', body, signal, accept = 'application/json', options = {} }) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const url = `${options.baseUrl || BASE_URL}${path}`
  let force = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: accept,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(await authHeaders(options, force))
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal
    })
    if (response.ok) return response
    try {
      await response.body?.cancel()
    } catch {
      // 已經關了
    }
    const retryable = attempt === 0 && (response.status === 401 || [502, 503, 504].includes(response.status))
    if (!retryable) {
      throw new UpstreamError(codeForStatus(response.status), response.status, response.headers?.get?.('retry-after') || '')
    }
    force = response.status === 401
    if (force) credOf(options).invalidate(PROVIDER)
    else await delay(500, undefined, { signal })
  }
  throw new UpstreamError('UPSTREAM_UNREACHABLE', 502)
}

/**
 * 送 Responses 請求（一律串流），回傳 ok 的 Response，body 是 SSE。
 * @param {object} body
 * @param {{ signal?: AbortSignal, options?: UpstreamOptions }} params
 */
function responses(body, { signal, options } = {}) {
  return request('/responses', { method: 'POST', body: { ...body, stream: true }, signal, accept: 'text/event-stream', options })
}

/**
 * @param {{ signal?: AbortSignal, options?: UpstreamOptions }} params
 * @returns {Promise<object>}
 */
async function models({ signal, options } = {}) {
  const response = await request('/models', { signal, options })
  return response.json()
}

/**
 * 每週額度（跟額度儀表板同一支 billing API）。
 * @param {{ signal?: AbortSignal, options?: UpstreamOptions }} params
 * @returns {Promise<object>}
 */
async function billing({ signal, options } = {}) {
  const response = await request('/billing?format=credits', { signal, options })
  return response.json()
}

/**
 * 憑證檢查：讀得到、沒過期就算連上。不打網路（狀態每 5 秒輪詢一次）。
 * @param {UpstreamOptions} [options]
 * @returns {Promise<{ connected: boolean, code: string, message: string, sources: { cli: boolean } }>}
 */
async function credentialStatus(options = {}) {
  const sources = { cli: credOf(options) === credential ? credential.detect().grok : true }
  try {
    await authHeaders(options, false)
    return { connected: true, code: '', message: '', sources }
  } catch (error) {
    return { connected: false, code: error.code, message: error.userMessage, sources }
  }
}

/**
 * 逐格讀 SSE，每格 JSON 交給 onPayload；`[DONE]` 與非 JSON 心跳略過。
 * @param {Response} response
 * @param {(payload: object, raw: string) => void} onPayload
 * @param {() => void} [onActivity]
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
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data && data !== '[DONE]') {
            let payload = null
            try {
              payload = JSON.parse(data)
            } catch {
              // 心跳或註解行
            }
            if (payload) onPayload(payload, data)
          }
        }
        index = buffer.indexOf('\n')
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}

module.exports = {
  BASE_URL,
  GROK_CLI_VERSION,
  UpstreamError,
  billing,
  credentialStatus,
  models,
  readSse,
  responses
}
