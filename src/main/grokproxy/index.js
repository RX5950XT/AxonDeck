'use strict'

const { randomBytes } = require('crypto')
const catalog = require('./catalog')
const logs = require('./logs')
const server = require('./server')
const { pingGateway } = require('../local-proxy-http')
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

/** 測試用最便宜的組合：最新模型、low 思考 */
const TEST_MODEL = `${catalog.DEFAULT_MODEL}-low`

/**
 * 端到端自我測試：從本機閘道走 Chat Completions 真的送一則訊息（跟 AGY 一樣測整條路）。
 * @param {{ fetchImpl?: Function }} [options]
 */
async function selfTest(options = {}) {
  const serverStatus = server.status()
  if (!serverStatus.running) return { ok: false, code: 'NOT_RUNNING', message: '服務尚未啟動，請先按「啟動服務」。' }

  const models = await catalog.snapshot({ options: server.getUpstreamOptions() })
  const first = models[0]
  const model = first ? (first.efforts.includes('low') ? `${first.id}-low` : first.id) : TEST_MODEL
  return pingGateway(serverStatus, readSettings().grokProxyApiKey, model, options.fetchImpl)
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
