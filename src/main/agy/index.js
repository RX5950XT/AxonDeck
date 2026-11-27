'use strict'

const { randomBytes } = require('crypto')
const catalog = require('./catalog')
const credential = require('./credential')
const logs = require('./logs')
const server = require('./server')
const { mergeLogs, mergeStats } = require('./merged-logs')
const { pingGateway } = require('../local-proxy-http')
const grokCatalog = require('../grokproxy/catalog')
const grokLogs = require('../grokproxy/logs')
const grokServer = require('../grokproxy/server')
const grokUpstream = require('../grokproxy/upstream')

/**
 * 反代的服務門面：一個本機服務（同一個埠與金鑰）同時轉 Antigravity 與 Grok（`grok-*` 模型），
 * 有登入的那幾家才可用。設定走主 electron-store（由 main.js 注入存取器），日誌兩家各一份 SQLite。
 * renderer 只透過這裡拿去敏後的狀態，永遠碰不到憑證、project id 或上游 URL。
 */

const DEFAULTS = Object.freeze({
  agyEnabled: false,
  agyPort: 8788,
  agyApiKey: '',
  agyLogBodies: false
})

let store = null
let ready = false

function generateApiKey() {
  return `agy-${randomBytes(24).toString('base64url')}`
}

function sanitizePort(raw) {
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULTS.agyPort
}

function readSettings() {
  if (!store) return { ...DEFAULTS }
  return {
    agyEnabled: store.get('agyEnabled', DEFAULTS.agyEnabled) === true,
    agyPort: sanitizePort(store.get('agyPort', DEFAULTS.agyPort)),
    agyApiKey: typeof store.get('agyApiKey', '') === 'string' ? store.get('agyApiKey', '') : '',
    agyLogBodies: store.get('agyLogBodies', DEFAULTS.agyLogBodies) === true
  }
}

/** 首次使用自動配一把 key，使用者不必手動產生就能直接接客戶端 */
function ensureApiKey() {
  const current = readSettings().agyApiKey
  if (current) return current
  const key = generateApiKey()
  store?.set('agyApiKey', key)
  return key
}

/** @param {{ userDataPath: string, store: { get: Function, set: Function } }} options */
function configure(options) {
  store = options.store
  // 日誌不自動刪：用量統計整份重讀時要靠它，刪掉的那段就永遠算不回來（只留手動「清空日誌」）
  ready = logs.init({ userDataPath: options.userDataPath })
  grokLogs.init({ userDataPath: options.userDataPath })
  return ready
}

async function start() {
  const settings = readSettings()
  const result = await server.start({
    port: settings.agyPort,
    apiKey: settings.agyApiKey || ensureApiKey(),
    logBodies: settings.agyLogBodies
  })
  if (result.ok) {
    store?.set('agyEnabled', true)
    require('../cloud-providers').syncAntigravity(store, endpoint())
  }
  return result
}

async function stop() {
  await server.stop()
  store?.set('agyEnabled', false)
  return { ok: true }
}


/** App 啟動時呼叫：上次關閉時是開著的就自動接續 */
async function autoStart() {
  if (!readSettings().agyEnabled) return { ok: false, error: 'DISABLED' }
  return start()
}

async function status() {
  const settings = readSettings()
  const serverStatus = server.status()
  // 服務沒開就不做 acquire：那會讀 Windows Credential Manager（要開 PowerShell）
  // 甚至走一次 OAuth refresh，5 秒一輪的輪詢不該付這個代價。
  // 但 detectSources 只是檢查執行檔存不存在，很便宜，而且模型查詢失敗時
  // renderer 要靠它決定該給哪一種指引，所以停止中也一併給。
  const credentialStatus = serverStatus.running
    ? await credential.status()
    : { connected: false, tier: '', code: 'NOT_RUNNING', message: '', sources: credential.detectSources() }
  // Grok 只讀本機登入檔（過期才叫 grok CLI 續期），停止中只回有沒有裝
  const grokCredential = serverStatus.running
    ? await grokUpstream.credentialStatus(grokServer.getUpstreamOptions())
    : { connected: false, code: 'NOT_RUNNING', message: '', sources: { cli: require('../ccswitch/gateway/credential').detect().grok } }

  return {
    ...serverStatus,
    // 兩個都要給：OpenAI 相容客戶端要 `/v1`（自己接 `/chat/completions`），
    // Claude Code 要根位址（自己接 `/v1/messages`，帶 `/v1` 會變成 `/v1/v1/messages` → 404）
    baseUrl: `http://${serverStatus.host}:${settings.agyPort}/v1`,
    anthropicBaseUrl: `http://${serverStatus.host}:${settings.agyPort}`,
    apiKey: settings.agyApiKey,
    port: settings.agyPort,
    logBodies: settings.agyLogBodies,
    // 頂層沿用 Antigravity 的欄位（指引靠 sources／code）；connected＝任一家可用
    credential: {
      ...credentialStatus,
      connected: credentialStatus.connected || grokCredential.connected,
      agy: credentialStatus,
      grok: grokCredential
    },
    db: logs.health()
  }
}

/**
 * 給 CC Proxy 的便宜版狀態：只看 server 有沒有在聽，不碰憑證（`status()` 會做 acquire）。
 * @returns {{ running: boolean, baseUrl: string, apiKey: string }}
 */
function endpoint() {
  const settings = readSettings()
  const serverStatus = server.status()
  return {
    running: serverStatus.running,
    baseUrl: `http://${serverStatus.host}:${settings.agyPort}`,
    apiKey: settings.agyApiKey
  }
}

async function saveSettings(raw) {
  const next = raw && typeof raw === 'object' ? raw : {}
  const port = sanitizePort(next.port)
  const logBodies = next.logBodies === true

  const previous = readSettings()
  store?.set('agyPort', port)
  store?.set('agyLogBodies', logBodies)

  const needsRestart = server.status().running &&
    (port !== previous.agyPort || logBodies !== previous.agyLogBodies)
  if (needsRestart) {
    await server.stop()
    await start()
  }
  return status()
}

/** 換 key 會讓既有客戶端全部失效，所以一定要重啟服務套用 */
async function regenerateApiKey() {
  const key = generateApiKey()
  store?.set('agyApiKey', key)
  if (server.status().running) {
    await server.stop()
    await start()
  }
  return status()
}

function getLogs(query = {}) {
  const limit = Math.max(1, Math.min(500, Number(query?.limit) || 200))
  return mergeLogs(logs.list(query), grokLogs.list(query), limit)
}

function getStats(query) {
  return mergeStats(logs.stats(query), grokLogs.stats(query))
}

function clearLogs() {
  const agyCleared = logs.clear()
  const grokCleared = grokLogs.clear()
  return { ok: agyCleared && grokCleared }
}

/**
 * App 退出用：關掉 server 但**不動 agyEnabled**。
 * 用 stop() 會把開關寫成 false，下次啟動就不會自動接續了。
 */
async function shutdown() {
  await server.stop()
  logs.close()
  grokLogs.close()
  credential.reset()
}

/** Grok 型錄：沒登入回 null（不打上游） */
async function grokModels(force) {
  const options = grokServer.getUpstreamOptions()
  if (!(await grokUpstream.credentialStatus(options)).connected) return null
  return grokCatalog.list({ force, options })
}

/**
 * 上游模型型錄（Antigravity＋Grok 的 `grok` 欄）。走 server 的上游設定，e2e 注入 mock 時才不會打到真實上游。
 * 只登入其中一家是正常用法：另一家查不到就不列，兩家都查不到才回 Antigravity 的錯誤（給登入指引）。
 * @param {{ force?: boolean }} [params]
 */
async function listModels({ force = false } = {}) {
  const [agy, grok] = await Promise.allSettled([
    catalog.list({ force, options: server.getUpstreamOptions() }),
    grokModels(force)
  ])
  const grokData = grok.status === 'fulfilled' ? grok.value : null
  if (agy.status === 'fulfilled') return { ...agy.value, grok: grokData }
  if (!grokData) throw agy.reason
  return { models: [], defaultModelId: '', cached: grokData.cached, fetchedAt: grokData.fetchedAt, grok: grokData }
}

/**
 * 挑一個拿來試打的模型。
 * 額度已經歸零的直接跳過（打下去必定失敗，測不出「連線有沒有通」）。
 * 優先用 Gemini 4 Hydrogen low：便宜、快，又不吃 Claude 那池的每週額度（使用者指定，2026-11-19）。
 * @param {Array<object>} models
 * @returns {string}
 */
function pickTestModel(models) {
  const chat = models.filter((model) => model.chatCapable && !model.deprecated)
  const usable = chat.filter((model) => model.remainingFraction !== 0)
  const preferred = TEST_MODEL_PREFERENCE.map((id) => usable.find((model) => model.id === id)).find(Boolean)
  return (preferred || usable[0] || chat[0])?.id || ''
}

const TEST_MODEL_PREFERENCE = Object.freeze(['gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium'])

/** Grok 試打用：第一顆模型的 low 檔（最便宜）；沒登入回空字串 */
async function grokTestModel() {
  const options = grokServer.getUpstreamOptions()
  if (!(await grokUpstream.credentialStatus(options)).connected) return ''
  const first = (await grokCatalog.snapshot({ options }))[0]
  if (!first) return `${grokCatalog.DEFAULT_MODEL}-low`
  return first.efforts.includes('low') ? `${first.id}-low` : first.id
}

/** 兩家各一個結果合成一行：都通才算通，失敗的那家放前面 */
function combineResults(results) {
  if (results.length === 1) return results[0]
  const failed = results.find((result) => !result.ok)
  return {
    ok: !failed,
    model: results.map((result) => result.model).join('／'),
    durationMs: Math.max(...results.map((result) => Number(result.durationMs) || 0)),
    reply: results.map((result) => result.reply || '').join('／'),
    ...(failed ? { code: failed.code, status: failed.status, message: `${failed.model}：${failed.message}` } : {})
  }
}

/**
 * 端到端自我測試：有登入的每一家各挑一個模型，從本機閘道真的送一則訊息（見 pingGateway）。
 * @param {{ fetchImpl?: Function }} [options]
 */
async function selfTest(options = {}) {
  const serverStatus = server.status()
  if (!serverStatus.running) {
    return { ok: false, code: 'NOT_RUNNING', message: '服務尚未啟動，請先按「啟動服務」。' }
  }

  const [agy, grok] = await Promise.allSettled([
    catalog.list({ options: server.getUpstreamOptions() }).then(({ models }) => pickTestModel(models)),
    grokTestModel()
  ])
  const models = [agy.status === 'fulfilled' ? agy.value : '', grok.status === 'fulfilled' ? grok.value : ''].filter(Boolean)
  if (!models.length) {
    // Antigravity 憑證錯誤照原樣丟出去，畫面才會跳登入指引
    if (agy.status === 'rejected') throw agy.reason
    return { ok: false, code: 'NO_MODEL', message: '上游沒有回報任何可對話的模型。' }
  }
  const apiKey = readSettings().agyApiKey
  const results = await Promise.all(models.map((model) => pingGateway(serverStatus, apiKey, model, options.fetchImpl)))
  return combineResults(results)
}

module.exports = {
  DEFAULTS,
  listModels,
  autoStart,
  clearLogs,
  configure,
  endpoint,
  getLogs,
  getStats,
  regenerateApiKey,
  sanitizePort,
  saveSettings,
  selfTest,
  shutdown,
  start,
  status,
  stop
}
