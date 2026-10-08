'use strict'

/**
 * Claude Code 工作台的門面（Main Process）。
 *
 * 供應商切換／MCP／CLI 版本三塊各自成模組，這裡只負責串起來與注入依賴，
 * 讓 `ipc.js` 有一個扁平的介面可以逐一列舉（比照 `agy/index.js`）。
 */

const path = require('path')
const { randomBytes } = require('crypto')
const claudeSettings = require('./claude-settings')
const presets = require('./presets')
const providers = require('./providers')
const mcp = require('./mcp')
const mcpHomes = require('./mcp-homes')
const skills = require('./skills')
const cliVersion = require('./cli-version')
const gateway = require('./gateway/server')
const gatewayCredential = require('./gateway/credential')
const oauth = require('./gateway/oauth')
const modelsScan = require('./models-scan')

/** 閘道預設監聽埠（0 = 讓系統挑；固定一個比較好填客戶端） */
const DEFAULT_GATEWAY_PORT = 8791

let configured = false
const MODEL_REFRESH_MS = 24 * 60 * 60_000
const modelScans = new Map()
const modelAttempts = new Map()
let modelRefreshTimer = null
/** main 注入的 AGY 反代載入器（晚載：AGY 會開 SQLite，沒用到不該跟著 CC Proxy 一起載） */
let loadAgy = null

/**
 * @param {{ userDataPath: string, openExternal?: (url: string) => unknown, getAgy?: () => Promise<object> }} options
 */
function configure({ userDataPath, openExternal, getAgy }) {
  if (configured) return
  configured = true
  if (typeof getAgy === 'function') loadAgy = getAgy
  claudeSettings.configure({ backupDir: path.join(userDataPath, 'claude-backup') })
  mcp.configure(providers.getStore)
  mcpHomes.configure({ getStore: providers.getStore })
  // 登入要開系統瀏覽器；用注入的而不是在這裡 require electron，模組才 node 直測得動
  oauth.configure({ getStore: providers.getStore, openExternal })
}

/**
 * 本機閘道的連線資訊。Codex／Grok／Ollama Cloud 要靠它把 OpenAI 協議轉成 Anthropic。
 *
 * **沒啟動就回 null**，`resolveEnv` 會拋 `GATEWAY_OFFLINE` 明說「請先啟動閘道」，
 * 而不是寫出一個連不上的 Base URL 讓使用者自己去猜。
 *
 * @returns {{ baseUrl: string, apiKey: string } | null}
 */
function gatewayInfo() {
  const state = gateway.status()
  if (!state.running || !gatewayKey) return null
  return { baseUrl: state.baseUrl, apiKey: gatewayKey }
}

/** @type {string} */
let gatewayKey = ''

/**
 * 讀（必要時產生）閘道金鑰。**每台機器一把**，存在自己的 store，不進 `STORE_ALLOWLIST`。
 * @returns {Promise<string>}
 */
async function ensureGatewayKey() {
  if (gatewayKey) return gatewayKey
  const store = await providers.getStore()
  let key = store.get('gatewayKey', '')
  if (typeof key !== 'string' || key.length < 32) {
    key = randomBytes(24).toString('base64url')
    store.set('gatewayKey', key)
  }
  gatewayKey = key
  return key
}

/**
 * AGY 反代的位址與金鑰（不碰憑證）。沒注入或載入失敗回 null。
 * @returns {Promise<{ running: boolean, baseUrl: string, apiKey: string } | null>}
 */
async function agyInfo() {
  if (!loadAgy) return null
  try {
    return (await loadAgy()).endpoint()
  } catch {
    return null
  }
}

/**
 * 啟動閘道。由切換供應商自動呼叫（要轉換格式的那幾家），使用者不必手動開。
 * @returns {Promise<object>}
 */
async function startGateway() {
  const store = await providers.getStore()
  const port = Number(store.get('gatewayPort', DEFAULT_GATEWAY_PORT)) || DEFAULT_GATEWAY_PORT
  await gateway.start({
    port,
    apiKey: await ensureGatewayKey(),
    // Ollama Cloud 的金鑰是使用者自己填的，由這裡去取；不進 settings.json
    getProviderKey: (presetId) => providers.keyForPreset(presetId),
    // Codex／Grok 綁了本 App 的登入帳號就用那組，沒綁才退回讀 CLI 憑證
    getAccountId: (presetId) => providers.accountForPreset(presetId),
    // 自訂供應商沒有固定表可查，位址由 main 從 store 取（renderer 與客戶端都指定不了）
    resolveRoute: (routeKey) => providers.resolveRoute(routeKey)
  })
  return gatewayStatus()
}

/** @returns {Promise<object>} */
async function stopGateway() {
  await gateway.stop()
  return gatewayStatus()
}

/**
 * 閘道狀態 ＋ 兩家 CLI 憑證在不在。**不回傳任何 token**。
 * @returns {object}
 */
function gatewayStatus() {
  const state = gateway.status()
  return {
    ...state,
    // 金鑰只在啟動時給一次，讓頁面能顯示「客戶端要填什麼」
    apiKey: state.running ? gatewayKey : '',
    credentials: gatewayCredential.detect()
  }
}

// ===== 供應商 =====

function catalog() {
  return {
    presets: presets.catalog(),
    authFields: providers.AUTH_FIELDS,
    // 非官方供應商都能選上游格式；Anthropic 直連，其餘經本機閘道轉換
    apiFormats: providers.API_FORMATS,
    // 哪幾家可以在本 App 直接登入，以及各自是哪種流程（UI 的文案不同）
    oauthFlows: Object.values(oauth.FLOWS).map((flow) => ({
      key: flow.key, label: flow.label, kind: flow.kind
    })),
    mcpTemplates: mcp.TEMPLATES,
    gateway: Boolean(gatewayInfo())
  }
}

async function listProviders() {
  const agy = await agyInfo()
  const result = await providers.list({ gateway: gatewayInfo() || undefined, agy: agy || undefined })
  // AGY 那家沒有 /models 可掃（金鑰是本機的），模型下拉直接拿反代的即時型錄
  if (agy?.running && result.providers.some((item) => item.presetId === 'agy')) {
    // 型錄過期時會等上游；最多等 3 秒，等不到這次就沿用沒有清單（下拉可手動輸入）
    const models = await Promise.race([agyModels(), new Promise((resolve) => setTimeout(resolve, 3000, null))])
    if (models) {
      result.providers = result.providers.map((item) => (
        item.presetId === 'agy' ? { ...item, availableModels: models } : item
      ))
    }
  }
  void refreshProviderModels()
  if (!modelRefreshTimer) {
    modelRefreshTimer = setInterval(() => void refreshProviderModels(), MODEL_REFRESH_MS)
    modelRefreshTimer.unref?.()
  }
  return result
}

/** 每天掃一次；重開 App 沿用上次掃描時間，手動刷新不受此限制。 */
async function refreshProviderModels() {
  try {
    const { providers: items } = await providers.list({ gateway: gatewayInfo() || undefined })
    await Promise.all(items.map(async ({ id }) => {
      const provider = await providers.getRaw(id)
      if (!provider || !modelsScan.resolveScanTarget(provider)) return
      const previous = modelAttempts.get(id)
      const lastAttempt = Math.max(provider.modelsCheckedAt || 0,
        previous?.identity === providers.scanIdentity(provider) ? previous.at : 0)
      if (Date.now() - lastAttempt < MODEL_REFRESH_MS) return
      await scanProviderModels(id)
    }))
  } catch {
    console.warn('[ccswitch] 自動更新模型清單失敗')
  }
}

/** @param {object} req */
function createProvider(req) {
  return providers.create(req)
}

/** @param {string} id @param {object} patch */
function updateProvider(id, patch) {
  return providers.update(id, patch)
}

/** @param {string} id */
function deleteProvider(id) {
  return providers.remove(id)
}

/** @param {string[]} ids */
function reorderProviders(ids) {
  return providers.reorder(ids)
}

/** @returns {Promise<string[] | null>} */
async function agyModels() {
  try {
    const { models } = await (await loadAgy()).listModels()
    return models.filter((model) => model.chatCapable && !model.deprecated).map((model) => model.id)
  } catch {
    return null
  }
}

/**
 * 切換供應商。閘道跟著目標走：要轉換格式就先開、切到直連（含官方訂閱）就關；
 * 切到 AGY 時反代沒開就先開。開在前、關在後——寫 settings.json 失敗時舊的那家還連得上。
 * @param {string} id
 */
async function activateProvider(id) {
  const item = await providers.getRaw(id)
  const preset = item ? presets.getPreset(item.presetId) : null
  const needsGateway = Boolean(preset) && providers.routeFor(item, preset) === 'gateway'
  if (needsGateway && !gateway.status().running) await startGateway()
  if (preset?.auth === 'agy' && loadAgy && !(await agyInfo())?.running) {
    const started = await (await loadAgy()).start()
    if (!started?.ok) {
      const error = new Error('AGY_START_FAILED')
      error.code = 'AGY_START_FAILED'
      error.userMessage = 'AGY 反代啟動失敗，請到「AGY 反代」分頁查看'
      throw error
    }
  }
  const result = await providers.activate(id, {
    gateway: gatewayInfo() || undefined,
    agy: (await agyInfo()) || undefined
  })
  if (!needsGateway && gateway.status().running) await stopGateway()
  return result
}

/**
 * App 啟動時呼叫：目前選用的那家要經閘道就把閘道開起來，不然重開 App 之後
 * Claude Code 會連不上（閘道不再有手動開關）。
 */
async function autoStartGateway() {
  const { providers: items, currentId } = await providers.list({})
  if (items.find((item) => item.id === currentId)?.route !== 'gateway') return false
  await startGateway()
  // 開了才比得出 settings.json 是不是真的指著閘道；被外部改走了就不佔著埠
  const { activeId } = await providers.list({ gateway: gatewayInfo() || undefined })
  if (activeId === currentId) return true
  await stopGateway()
  return false
}

/**
 * 用這一筆目前儲存的上游格式送最小請求；不經本機閘道、不回傳上游 body。
 * @param {string} id
 */
async function testProvider(id) {
  const provider = await providers.getRaw(id)
  if (!provider) {
    const error = new Error('NOT_FOUND')
    error.code = 'NOT_FOUND'
    error.userMessage = '找不到這個供應商'
    throw error
  }
  if (presets.getPreset(provider.presetId)?.auth === 'agy') return testAgy()
  return modelsScan.testProvider(provider)
}

/** AGY 那家借反代自己的端到端自我測試，回成跟 `modelsScan.testProvider` 一樣的形狀 */
async function testAgy() {
  const agy = await agyInfo()
  if (!agy?.running) return { responded: false, ok: false, format: 'anthropic', error: 'AGY 反代沒有啟動' }
  const result = await (await loadAgy()).selfTest()
  return {
    responded: Boolean(result?.status),
    ok: result?.ok === true,
    status: result?.status || 0,
    format: 'anthropic',
    url: agy.baseUrl,
    error: result?.ok ? '' : (result?.message || '測試失敗')
  }
}

/**
 * 從 API 掃這一筆的模型清單（彈窗裡的「從 API 載入模型」）。
 * 只收 providerId，端點與憑證全在 main 決定（跟 `chat:scanModels` 同一條規矩）。
 * @param {string} id
 */
async function scanProviderModels(id) {
  const provider = await providers.getRaw(id)
  if (!provider) {
    const error = new Error('NOT_FOUND')
    error.code = 'NOT_FOUND'
    error.userMessage = '找不到這個供應商'
    throw error
  }
  const identity = providers.scanIdentity(provider)
  const pending = modelScans.get(id)
  if (pending?.identity === identity) return pending.promise
  modelAttempts.set(id, { identity, at: Date.now() })
  const promise = (async () => {
    const result = await modelsScan.scanProviderModels(provider)
    if (!await providers.saveModelScan(provider, result)) {
      return { ok: false, code: 'STALE', error: '供應商已變更，請重新掃描模型' }
    }
    return result
  })()
  modelScans.set(id, { identity, promise })
  try {
    return await promise
  } finally {
    if (modelScans.get(id)?.promise === promise) modelScans.delete(id)
  }
}

// ===== MCP（四家；不帶 home 視同 claude，舊呼叫照樣能動） =====

/** @param {string} [home] */
function mcpHomesList() {
  return mcpHomes.homes()
}

/** @param {string} [home] */
function listMcp(home) {
  return mcpHomes.list(home || 'claude')
}

/** @param {string} home @param {string} id @param {object} spec @param {boolean} enabled */
function saveMcp(home, id, spec, enabled) {
  return mcpHomes.upsert(home || 'claude', id, spec, enabled !== false)
}

/** @param {string} home @param {string} id @param {boolean} enabled */
function toggleMcp(home, id, enabled) {
  return mcpHomes.toggle(home || 'claude', id, enabled)
}

/** @param {string} home @param {string} id */
function deleteMcp(home, id) {
  return mcpHomes.remove(home || 'claude', id)
}

// ===== Skills 與全域記憶檔 =====

/** @returns {Array<object>} */
function skillHomes() {
  return skills.homes().map((row) => ({ ...row, skillsDir: row.dir }))
}

/** @param {string} home */
function listSkills(home) {
  return skills.list(home)
}

/** @param {string} home @param {string} name @param {boolean} enabled */
function setSkillEnabled(home, name, enabled) {
  return skills.setEnabled(home, name, enabled)
}

/** @param {string} home */
function memoryFiles(home) {
  return skills.memoryFiles(home)
}

/** @param {string} home @param {string} file */
function readMemory(home, file) {
  return skills.readMemory(home, file)
}

/** @param {string} home @param {string} file @param {string} content */
function writeMemory(home, file, content) {
  return skills.writeMemory(home, file, content)
}

// ===== OAuth 登入 =====

/**
 * 登入帳號清單。**不含任何 token**。
 * @returns {Promise<Array<object>>}
 */
function listAccounts() {
  return oauth.list()
}

/** @param {string} providerKey */
function beginLogin(providerKey) {
  return oauth.begin(providerKey)
}

/** @param {string} providerKey */
function loginStatus(providerKey) {
  return oauth.status(providerKey)
}

/** @param {string} providerKey */
function cancelLogin(providerKey) {
  return oauth.cancel(providerKey)
}

/**
 * 刪掉一個登入帳號，並把綁著它的供應商解綁。
 * @param {string} accountId
 */
async function removeAccount(accountId) {
  await oauth.remove(accountId)
  await providers.unbindAccount(accountId)
  return true
}

// ===== CLI 版本 =====

function checkVersions() {
  return cliVersion.checkAll()
}

/** @param {string} key */
function runCliTask(key) { return cliVersion.runTask(key) }
function cliTaskStatus(key) { return cliVersion.taskStatus(key) }

module.exports = {
  DEFAULT_GATEWAY_PORT,
  configure,
  gatewayInfo,
  gatewayStatus,
  startGateway,
  stopGateway,
  autoStartGateway,
  catalog,
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  reorderProviders,
  activateProvider,
  testProvider,
  scanProviderModels,
  mcpHomesList,
  listMcp,
  saveMcp,
  toggleMcp,
  deleteMcp,
  skillHomes,
  listSkills,
  setSkillEnabled,
  memoryFiles,
  readMemory,
  writeMemory,
  listAccounts,
  beginLogin,
  loginStatus,
  cancelLogin,
  removeAccount,
  checkVersions,
  runCliTask,
  cliTaskStatus
}
