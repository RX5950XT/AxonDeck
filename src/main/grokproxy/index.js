'use strict'

const { randomBytes } = require('crypto')
const catalog = require('./catalog')
const logs = require('./logs')
const server = require('./server')
const upstream = require('./upstream')

/**
 * Grok 反代的服務門面（仿 `agy/index.js`）。
 * 設定走主 electron-store（main.js 注入），日誌走自己的 SQLite。
 * renderer 只拿得到去敏後的狀態：沒有 token、沒有上游 URL。
 */

const DEFAULTS = Object.freeze({
  grokProxyEnabled: false,
  grokProxyPort: 8789,
  grokProxyApiKey: '',
  grokProxyLogBodies: false,
  grokProxyLogRetentionDays: 30
})

let store = null

function generateApiKey() {
  return `grok-${randomBytes(24).toString('base64url')}`
}

function sanitizePort(raw) {
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULTS.grokProxyPort
}

function sanitizeRetentionDays(raw) {
  const days = Number(raw)
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULTS.grokProxyLogRetentionDays
}

function readSettings() {
  if (!store) return { ...DEFAULTS }
  const key = store.get('grokProxyApiKey', '')
  return {
    grokProxyEnabled: store.get('grokProxyEnabled', false) === true,
    grokProxyPort: sanitizePort(store.get('grokProxyPort', DEFAULTS.grokProxyPort)),
    grokProxyApiKey: typeof key === 'string' ? key : '',
    grokProxyLogBodies: store.get('grokProxyLogBodies', false) === true,
    grokProxyLogRetentionDays: sanitizeRetentionDays(store.get('grokProxyLogRetentionDays', DEFAULTS.grokProxyLogRetentionDays))
  }
}

function ensureApiKey() {
  const current = readSettings().grokProxyApiKey
  if (current) return current
  const key = generateApiKey()
  store?.set('grokProxyApiKey', key)
  return key
}

/** @param {{ userDataPath: string, store: { get: Function, set: Function } }} options */
function configure(options) {
  store = options.store
  const ready = logs.init({ userDataPath: options.userDataPath })
  if (ready) {
    const days = readSettings().grokProxyLogRetentionDays
    setImmediate(() => {
      try { logs.cleanup(days) } catch { /* 清理失敗不能擋啟動 */ }
    })
  }
  return ready
}

async function start() {
  const settings = readSettings()
  const result = await server.start({
    port: settings.grokProxyPort,
    apiKey: settings.grokProxyApiKey || ensureApiKey(),
    logBodies: settings.grokProxyLogBodies
  })
  if (result.ok) store?.set('grokProxyEnabled', true)
  return result
}

async function stop() {
  await server.stop()
  store?.set('grokProxyEnabled', false)
  return { ok: true }
}

async function autoStart() {
  if (!readSettings().grokProxyEnabled) return { ok: false, error: 'DISABLED' }
  return start()
}

async function status() {
  const settings = readSettings()
  const serverStatus = server.status()
  // 憑證檢查只讀本機檔案（過期才會叫 grok CLI 續期），停止中只回來源偵測
  const credential = serverStatus.running
    ? await upstream.credentialStatus(server.getUpstreamOptions())
    : { connected: false, code: 'NOT_RUNNING', message: '', sources: { cli: require('../ccswitch/gateway/credential').detect().grok } }
  return {
    ...serverStatus,
    baseUrl: `http://${serverStatus.host}:${settings.grokProxyPort}/v1`,
    anthropicBaseUrl: `http://${serverStatus.host}:${settings.grokProxyPort}`,
    apiKey: settings.grokProxyApiKey,
    port: settings.grokProxyPort,
    logBodies: settings.grokProxyLogBodies,
    retentionDays: settings.grokProxyLogRetentionDays,
    credential,
    db: logs.health()
  }
}

async function saveSettings(raw) {
  const next = raw && typeof raw === 'object' ? raw : {}
  const port = sanitizePort(next.port)
  const logBodies = next.logBodies === true
  const retentionDays = sanitizeRetentionDays(next.retentionDays)
  const previous = readSettings()
  store?.set('grokProxyPort', port)
  store?.set('grokProxyLogBodies', logBodies)
  store?.set('grokProxyLogRetentionDays', retentionDays)
  if (retentionDays !== previous.grokProxyLogRetentionDays) logs.cleanup(retentionDays)
  if (server.status().running && (port !== previous.grokProxyPort || logBodies !== previous.grokProxyLogBodies)) {
    await server.stop()
    await start()
  }
  return status()
}

async function regenerateApiKey() {
  store?.set('grokProxyApiKey', generateApiKey())
  if (server.status().running) {
    await server.stop()
    await start()
  }
  return status()
}

function getLogs(query) {
  return logs.list(query)
}

function getStats(query) {
  return logs.stats(query)
}

function clearLogs() {
  return { ok: logs.clear() }
}

/** App 退出：關 server 但不動 grokProxyEnabled，下次啟動才會自動接續 */
async function shutdown() {
  await server.stop()
  logs.close()
}

function listModels({ force = false } = {}) {
  return catalog.list({ force, options: server.getUpstreamOptions() })
}

const TEST_TIMEOUT_MS = 60_000
const TEST_PROMPT = '請只回覆「OK」兩個字。'
/** 測試用最便宜的組合：最新模型、low 思考 */
const TEST_MODEL = `${catalog.DEFAULT_MODEL}-low`

/**
 * 端到端自我測試：從本機閘道走 Chat Completions 真的送一則訊息（跟 AGY 一樣測整條路）。
 * @param {{ fetchImpl?: Function }} [options]
 */
async function selfTest(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const serverStatus = server.status()
  if (!serverStatus.running) return { ok: false, code: 'NOT_RUNNING', message: '服務尚未啟動，請先按「啟動服務」。' }

  const models = await catalog.snapshot({ options: server.getUpstreamOptions() })
  const first = models[0]
  const model = first ? (first.efforts.includes('low') ? `${first.id}-low` : first.id) : TEST_MODEL
  const startedMs = Date.now()
  let response
  try {
    response = await fetchImpl(`http://${serverStatus.host}:${serverStatus.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readSettings().grokProxyApiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: TEST_PROMPT }], max_tokens: 64, stream: false }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, code: 'UNREACHABLE', model, durationMs: Date.now() - startedMs, message: '連不上本機閘道，請確認監聽埠沒有被其他程式占用。' }
  }
  const durationMs = Date.now() - startedMs
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`
    // 訊息是 server.js 自己寫的白名單字串，不是上游原文
    const message = typeof payload?.error?.message === 'string' ? payload.error.message : '閘道回報請求失敗。'
    return { ok: false, code, model, status: response.status, durationMs, message }
  }
  const reply = String(payload?.choices?.[0]?.message?.content || '').trim().slice(0, 120)
  return { ok: true, model, status: 200, durationMs, reply }
}

module.exports = {
  DEFAULTS,
  autoStart,
  clearLogs,
  configure,
  getLogs,
  getStats,
  listModels,
  regenerateApiKey,
  saveSettings,
  selfTest,
  shutdown,
  start,
  status,
  stop
}
