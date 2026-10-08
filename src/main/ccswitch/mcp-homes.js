'use strict'

/**
 * 四家 AI CLI 的 MCP 伺服器管理（Main Process）。
 *
 * Canonical spec 沿用 `mcp.js` 的形狀（`{ type: stdio|http|sse, command, args, env, url, headers }`），
 * 各家只差落盤格式，UI 永遠只認同一種：
 *
 * | 家 | 檔案 | 原生形狀 |
 * |---|---|---|
 * | claude | `~/.claude.json` 的 `mcpServers` | 直接沿用 `mcp.js`，這裡只轉發 |
 * | codex | `<home>/config.toml` 的 `[mcp_servers.<id>]`＋`[.<id>.env]` | 只支援 stdio；沒有 enabled 欄位，停用放我方 store |
 * | grok | `<home>/config.toml` 的 `[mcp_servers.<id>]` | stdio 吃 `.env`、remote 吃 `.headers`；原生 `enabled` |
 * | opencode | `<configDir>/opencode.json` 的 `mcp` | local／remote＋`environment`＋原生 `enabled` |
 *
 * 兩條保命規則（跟 `mcp.js`／`claude-settings.js` 同一套）：
 * 1. 壞掉的 TOML／JSON 一律拋錯，絕不覆寫——否則一次寫入就把使用者原本的設定洗掉。
 * 2. 寫前備份、原子替換；讀不到的鍵（`startup_timeout_sec`、`env_vars`、`cwd`、`oauth`…）
 *    原樣帶回去，不改的就是不動。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const toml = require('smol-toml')
const mcp = require('./mcp')
const claudeSettings = require('./claude-settings')

const MAX_TOML_BYTES = 4 * 1024 * 1024
const MAX_BACKUPS = 20

/** @type {string} */
let homeOverride = ''
/** @type {(() => Promise<import('electron-store')>) | null} */
let getStore = null

/**
 * @param {{ homeDir?: string, getStore?: () => Promise<import('electron-store')> }} options
 */
function configure(options = {}) {
  if (typeof options.homeDir === 'string') homeOverride = options.homeDir
  if (typeof options.getStore === 'function') {
    getStore = options.getStore
    mcp.configure(options.getStore)
  }
}

/** @returns {string} */
function baseHome() {
  return homeOverride || os.homedir()
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function envHome(value, fallback) {
  const dir = typeof value === 'string' ? value.trim() : ''
  return dir || path.join(baseHome(), fallback)
}

/** @returns {string} */
function codexHome() {
  return envHome(process.env.CODEX_HOME, '.codex')
}

/** @returns {string} */
function grokHome() {
  return envHome(process.env.GROK_HOME, '.grok')
}

/** @returns {string} */
function opencodeDir() {
  const custom = typeof process.env.OPENCODE_CONFIG === 'string' ? process.env.OPENCODE_CONFIG.trim() : ''
  if (custom && custom.toLowerCase().endsWith('.json')) return path.dirname(custom)
  return path.join(baseHome(), '.config', 'opencode')
}

/**
 * @param {'claude' | 'codex' | 'grok' | 'opencode'} home
 * @returns {string}
 */
function mcpFile(home) {
  if (home === 'claude') return claudeSettings.claudeJsonPath()
  if (home === 'codex' || home === 'grok') {
    const dir = home === 'codex' ? codexHome() : grokHome()
    return path.join(dir, 'config.toml')
  }
  return path.join(opencodeDir(), 'opencode.json')
}

/**
 * @returns {Array<{ id: string, label: string, path: string, stdioOnly: boolean }>}
 */
function homes() {
  return [
    { id: 'claude', label: 'Claude Code', path: mcpFile('claude'), stdioOnly: false },
    { id: 'codex', label: 'Codex', path: mcpFile('codex'), stdioOnly: true },
    { id: 'grok', label: 'Grok', path: mcpFile('grok'), stdioOnly: false },
    { id: 'opencode', label: 'OpenCode', path: mcpFile('opencode'), stdioOnly: false }
  ]
}

/**
 * @param {unknown} id
 * @returns {'claude' | 'codex' | 'grok' | 'opencode'}
 */
function assertHome(id) {
  if (id === 'claude' || id === 'codex' || id === 'grok' || id === 'opencode') return id
  const error = new Error('MCP_HOME_UNKNOWN')
  error.code = 'MCP_HOME_UNKNOWN'
  error.userMessage = '不支援這個 AI 家目錄'
  throw error
}

// ===== 錯誤 =====

/**
 * @param {string} code
 * @param {string} userMessage
 * @returns {Error}
 */
function fail(code, userMessage) {
  const error = new Error(code)
  error.code = code
  error.userMessage = userMessage
  return error
}

// ===== TOML I/O（codex／grok） =====

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readTomlFile(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw fail('MCP_HOME_READ_FAILED', `讀取 ${path.basename(file)} 失敗`)
  }
  if (stat.size > MAX_TOML_BYTES) throw fail('MCP_HOME_TOO_LARGE', `${path.basename(file)} 太大，請先檢查該檔案`)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch {
    throw fail('MCP_HOME_READ_FAILED', `讀取 ${path.basename(file)} 失敗`)
  }
  if (!raw.trim()) return {}
  try {
    const parsed = toml.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    return /** @type {Record<string, unknown>} */ (parsed)
  } catch {
    throw fail('MCP_HOME_TOML_INVALID', `${path.basename(file)} 解析失敗，請先修好再操作（不會覆寫）`)
  }
}

/**
 * @param {string} file
 * @param {string} tag
 * @returns {string | null}
 */
function backupToml(file, tag) {
  if (!fs.existsSync(file)) return null
  const dir = claudeSettings.backupDir()
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `${tag}-${stamp}.toml`)
  fs.copyFileSync(file, target)
  try {
    const names = fs.readdirSync(dir).filter((name) => name.startsWith(`${tag}-`) && name.endsWith('.toml')).sort()
    for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
      try {
        fs.unlinkSync(path.join(dir, name))
      } catch {
        // 刪不掉就算了
      }
    }
  } catch {
    // 備份目錄讀不到不擋寫入
  }
  return target
}

/**
 * @param {string} file
 * @param {Record<string, unknown>} data
 * @param {string} tag
 */
function writeTomlFile(file, data, tag) {
  let text
  try {
    text = toml.stringify(data)
  } catch {
    throw fail('MCP_HOME_TOML_STRINGIFY', '設定寫不回去（該檔案有本工具不認得的格式），沒有動到原檔')
  }
  backupToml(file, tag)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.axondeck-tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 暫存檔清不掉不影響結果
    }
    throw error
  }
}

/**
 * @param {Record<string, unknown>} root
 * @returns {Record<string, Record<string, unknown>>}
 */
function tomlServers(root) {
  const node = root.mcp_servers
  if (node == null) return {}
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw fail('MCP_HOME_SHAPE', 'config.toml 的 mcp_servers 被改成非表格，請先修好再操作')
  }
  return /** @type {Record<string, Record<string, unknown>>} */ (node)
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function tomlStringMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key || typeof key !== 'string' || value == null || typeof value === 'object') continue
    out[key] = String(value)
  }
  return out
}

// ===== 各家格式轉換 =====

/**
 * TOML 讀進來的單台 canonical 化。未知鍵留在 `rest`，寫回時原樣帶回去。
 * @param {'codex' | 'grok'} home
 * @param {unknown} raw
 * @returns {{ spec: Record<string, unknown> | null, enabled: boolean, rest: Record<string, unknown> }}
 */
function fromTomlServer(home, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { spec: null, enabled: true, rest: {} }
  const node = /** @type {Record<string, unknown>} */ ({ ...raw })
  const enabled = node.enabled !== false
  delete node.enabled
  let tableEnv = {}
  if (home === 'codex') {
    Object.assign(tableEnv, tomlStringMap(node.env))
    delete node.env
  } else if (typeof node.url === 'string' && node.url) {
    Object.assign(tableEnv, tomlStringMap(node.headers))
    delete node.headers
  } else {
    Object.assign(tableEnv, tomlStringMap(node.env))
    delete node.env
  }
  const rest = { ...node }
  delete rest.command
  delete rest.args
  delete rest.url
  const draft = { ...rest, env: tableEnv }
  // command／url 既是原生鍵也是 canonical 鍵：rest 拿掉是為了寫回時重建，這裡要加回來才驗得過
  if (typeof node.command === 'string' && node.command) draft.command = node.command
  if (Array.isArray(node.args)) draft.args = node.args
  if (typeof node.url === 'string' && node.url) draft.url = node.url
  // Codex 只認 command：帶 url 的那筆直接視為不支援，不硬轉（轉了也跑不起來）
  if (typeof node.command === 'string' && node.command) {
    draft.type = 'stdio'
  } else if (typeof node.url === 'string' && node.url && home !== 'codex') {
    draft.type = 'http'
    // http 吃的是 headers 表（sanitizeSpec 只認 headers，不認 env）
    draft.headers = tableEnv
    delete draft.env
  }
  let spec = null
  try {
    if (draft.type === 'stdio' || draft.type === 'http') spec = mcp.sanitizeSpec(draft)
  } catch {
    spec = null
  }
  return { spec, enabled, rest }
}

/**
 * @param {'codex' | 'grok'} home
 * @param {Record<string, unknown>} spec canonical（已過 sanitizeSpec）
 * @param {Record<string, unknown>} rest 讀回來的未知鍵
 * @param {boolean} enabled
 * @returns {Record<string, unknown>}
 */
function toTomlServer(home, spec, rest, enabled) {
  if (home === 'codex' && spec.type !== 'stdio') {
    throw fail('MCP_HOME_TYPE', 'Codex 只支援 command 啟動的本機伺服器')
  }
  const out = { ...rest }
  delete out.command
  delete out.args
  delete out.url
  delete out.env
  delete out.headers
  delete out.enabled
  if (spec.type === 'stdio') {
    out.command = spec.command
    if (Array.isArray(spec.args) && spec.args.length) out.args = [...spec.args]
    if (spec.env && Object.keys(spec.env).length) out.env = { ...spec.env }
  } else {
    out.url = spec.url
    const headers = spec.headers && typeof spec.headers === 'object' ? { ...spec.headers } : null
    if (headers && Object.keys(headers).length) out.headers = headers
  }
  if (home === 'grok') out.enabled = enabled
  return out
}

/**
 * OpenCode 原生：local 的 command 是陣列、env 叫 environment。
 * @param {unknown} raw
 * @returns {{ spec: Record<string, unknown> | null, enabled: boolean, rest: Record<string, unknown> }}
 */
function fromOpenCodeServer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { spec: null, enabled: true, rest: {} }
  const node = /** @type {Record<string, unknown>} */ ({ ...raw })
  const enabled = node.disabled === true ? false : node.enabled !== false
  const rest = { ...node }
  delete rest.type
  delete rest.command
  delete rest.environment
  delete rest.url
  delete rest.headers
  delete rest.enabled
  delete rest.disabled
  /** @type {Record<string, unknown>} */
  const draft = { env: {} }
  if (node.type === 'local' && Array.isArray(node.command) && node.command.length) {
    const [command, ...args] = node.command.map(String)
    draft.type = 'stdio'
    draft.command = command
    if (args.length) draft.args = args
    Object.assign(draft.env, tomlStringMap(node.environment))
  } else if (node.type === 'remote' && typeof node.url === 'string' && node.url) {
    draft.type = 'http'
    draft.url = node.url
    draft.headers = tomlStringMap(node.headers)
    Object.assign(draft.env, tomlStringMap(node.environment))
  }
  let spec = null
  try {
    if (draft.type) spec = mcp.sanitizeSpec(draft)
  } catch {
    spec = null
  }
  return { spec, enabled, rest }
}

/**
 * @param {Record<string, unknown>} spec
 * @param {Record<string, unknown>} rest
 * @param {boolean} enabled
 * @returns {Record<string, unknown>}
 */
function toOpenCodeServer(spec, rest, enabled) {
  const out = { ...rest }
  delete out.type
  delete out.command
  delete out.environment
  delete out.url
  delete out.headers
  delete out.enabled
  delete out.disabled
  if (spec.type === 'stdio') {
    out.type = 'local'
    out.command = [spec.command, ...(Array.isArray(spec.args) ? spec.args : [])]
    if (spec.env && Object.keys(spec.env).length) out.environment = { ...spec.env }
  } else {
    out.type = 'remote'
    out.url = spec.url
    if (spec.headers && Object.keys(spec.headers).length) out.headers = { ...spec.headers }
    if (spec.env && Object.keys(spec.env).length) out.environment = { ...spec.env }
  }
  out.enabled = enabled
  return out
}

// ===== codex 停用清單（store；config.toml 沒有 enabled 欄位） =====

/** @returns {Promise<Record<string, Record<string, unknown>>>} */
async function readCodexDisabled() {
  if (!getStore) return {}
  const store = await getStore()
  return mcp.sanitizeMap(store.get('disabledMcpCodex', {}))
}

/** @param {Record<string, Record<string, unknown>>} map */
async function writeCodexDisabled(map) {
  if (!getStore) return
  const store = await getStore()
  store.set('disabledMcpCodex', map)
}

// ===== 對外 =====

/**
 * @param {'codex' | 'grok'} home
 * @returns {Promise<{ path: string, servers: Array<{ id: string, enabled: boolean, spec: object }> }>}
 */
async function listToml(home) {
  const file = mcpFile(home)
  const servers = tomlServers(readTomlFile(file))
  const disabled = home === 'codex' ? await readCodexDisabled() : {}
  const rows = []
  let count = 0
  for (const [key, raw] of Object.entries(servers)) {
    if (count >= mcp.MAX_SERVERS) break
    let id = ''
    try {
      id = mcp.sanitizeId(key)
    } catch {
      continue
    }
    const parsed = fromTomlServer(home, raw)
    if (!parsed.spec) continue
    count++
    if (home === 'codex' && disabled[id]) continue
    rows.push({
      id,
      enabled: home === 'codex' ? true : parsed.enabled,
      spec: parsed.spec
    })
  }
  if (home === 'codex') {
    for (const [id, spec] of Object.entries(disabled)) {
      if (id in servers || rows.some((row) => row.id === id)) continue
      if (rows.length >= mcp.MAX_SERVERS) break
      rows.push({ id, enabled: false, spec })
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return { path: file, servers: rows }
}

/**
 * @param {'codex' | 'grok'} home
 */
async function upsertToml(home, rawId, rawSpec, enabled = true) {
  const id = mcp.sanitizeId(rawId)
  const spec = mcp.sanitizeSpec(rawSpec)
  const file = mcpFile(home)
  const root = readTomlFile(file)
  const servers = tomlServers(root)
  const existing = servers[id] && typeof servers[id] === 'object' && !Array.isArray(servers[id])
    ? /** @type {Record<string, unknown>} */ (servers[id])
    : {}
  const parsed = fromTomlServer(home, existing)
  if (home === 'codex') {
    const disabled = await readCodexDisabled()
    const liveCount = Object.keys(servers).length - (id in servers ? 1 : 0)
    if (enabled && !(id in servers) && liveCount >= mcp.MAX_SERVERS) {
      throw fail('MCP_LIMIT', `MCP 伺服器最多 ${mcp.MAX_SERVERS} 台`)
    }
    if (enabled) {
      delete disabled[id]
      await writeCodexDisabled(disabled)
      writeTomlFile(file, { ...root, mcp_servers: { ...servers, [id]: toTomlServer(home, spec, parsed.rest, true) } }, `mcp-${home}`)
    } else {
      if (id in servers) {
        const next = { ...servers }
        delete next[id]
        writeTomlFile(file, { ...root, mcp_servers: next }, `mcp-${home}`)
      }
      await writeCodexDisabled({ ...disabled, [id]: spec })
    }
    return { id, enabled }
  }
  const liveCount = Object.keys(servers).length - (id in servers ? 1 : 0)
  if (!(id in servers) && liveCount >= mcp.MAX_SERVERS) {
    throw fail('MCP_LIMIT', `MCP 伺服器最多 ${mcp.MAX_SERVERS} 台`)
  }
  writeTomlFile(file, { ...root, mcp_servers: { ...servers, [id]: toTomlServer(home, spec, parsed.rest, Boolean(enabled)) } }, `mcp-${home}`)
  return { id, enabled: Boolean(enabled) }
}

/**
 * @param {'codex' | 'grok'} home
 */
async function toggleToml(home, rawId, enabled) {
  const id = mcp.sanitizeId(rawId)
  const file = mcpFile(home)
  const servers = tomlServers(readTomlFile(file))
  if (home === 'codex') {
    const disabled = await readCodexDisabled()
    const live = servers[id] && typeof servers[id] === 'object' ? fromTomlServer(home, servers[id]) : null
    const spec = (live && live.spec) || disabled[id]
    if (!spec) throw fail('NOT_FOUND', '找不到這台 MCP 伺服器')
    return upsertToml(home, id, spec, Boolean(enabled))
  }
  if (!(id in servers)) throw fail('NOT_FOUND', '找不到這台 MCP 伺服器')
  const parsed = fromTomlServer(home, servers[id])
  if (!parsed.spec) throw fail('NOT_FOUND', '找不到這台 MCP 伺服器')
  return upsertToml(home, id, parsed.spec, Boolean(enabled))
}

/**
 * @param {'codex' | 'grok'} home
 */
async function removeToml(home, rawId) {
  const id = mcp.sanitizeId(rawId)
  const file = mcpFile(home)
  const root = readTomlFile(file)
  const servers = tomlServers(root)
  if (id in servers) {
    const next = { ...servers }
    delete next[id]
    writeTomlFile(file, { ...root, mcp_servers: next }, `mcp-${home}`)
  }
  if (home === 'codex') {
    const disabled = await readCodexDisabled()
    if (id in disabled) {
      delete disabled[id]
      await writeCodexDisabled(disabled)
    }
  }
  return true
}

/**
 * @returns {{ shaped: 'flat' | 'servers', map: Record<string, unknown> }}
 */
function readOpenCodeMap() {
  const file = mcpFile('opencode')
  const root = claudeSettings.readJsonFile(file)
  const node = root.mcp
  if (node == null) return { shaped: 'flat', map: {} }
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const typed = /** @type {Record<string, unknown>} */ (node)
    if (typed.servers && typeof typed.servers === 'object' && !Array.isArray(typed.servers)) {
      return { shaped: 'servers', map: /** @type {Record<string, unknown>} */ (typed.servers) }
    }
    return { shaped: 'flat', map: typed }
  }
  throw fail('MCP_HOME_SHAPE', 'opencode.json 的 mcp 被改成非物件，請先修好再操作')
}

/**
 * @param {'flat' | 'servers'} shaped
 * @param {Record<string, unknown>} map
 */
function writeOpenCodeMap(shaped, map) {
  const file = mcpFile('opencode')
  const root = claudeSettings.readJsonFile(file)
  const next = { ...root }
  next.mcp = shaped === 'servers' ? { ...((root.mcp && typeof root.mcp === 'object') ? root.mcp : {}), servers: map } : map
  claudeSettings.backupFile(file, 'mcp-opencode')
  claudeSettings.writeJsonFile(file, next)
}

/**
 * @returns {Promise<{ path: string, servers: Array<{ id: string, enabled: boolean, spec: object }> }>}
 */
async function listOpenCode() {
  const { map } = readOpenCodeMap()
  const rows = []
  let count = 0
  for (const [key, raw] of Object.entries(map)) {
    if (count >= mcp.MAX_SERVERS) break
    let id = ''
    try {
      id = mcp.sanitizeId(key)
    } catch {
      continue
    }
    const parsed = fromOpenCodeServer(raw)
    if (!parsed.spec) continue
    count++
    rows.push({ id, enabled: parsed.enabled, spec: parsed.spec })
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return { path: mcpFile('opencode'), servers: rows }
}

async function upsertOpenCode(rawId, rawSpec, enabled = true) {
  const id = mcp.sanitizeId(rawId)
  const spec = mcp.sanitizeSpec(rawSpec)
  const { shaped, map } = readOpenCodeMap()
  if (!(id in map) && Object.keys(map).length >= mcp.MAX_SERVERS) {
    throw fail('MCP_LIMIT', `MCP 伺服器最多 ${mcp.MAX_SERVERS} 台`)
  }
  const existing = map[id] && typeof map[id] === 'object' ? fromOpenCodeServer(map[id]) : null
  writeOpenCodeMap(shaped, { ...map, [id]: toOpenCodeServer(spec, (existing && existing.rest) || {}, Boolean(enabled)) })
  return { id, enabled: Boolean(enabled) }
}

async function toggleOpenCode(rawId, enabled) {
  const id = mcp.sanitizeId(rawId)
  const { shaped, map } = readOpenCodeMap()
  if (!(id in map)) throw fail('NOT_FOUND', '找不到這台 MCP 伺服器')
  const parsed = fromOpenCodeServer(map[id])
  if (!parsed.spec) throw fail('NOT_FOUND', '找不到這台 MCP 伺服器')
  writeOpenCodeMap(shaped, { ...map, [id]: toOpenCodeServer(parsed.spec, parsed.rest, Boolean(enabled)) })
  return { id, enabled: Boolean(enabled) }
}

async function removeOpenCode(rawId) {
  const id = mcp.sanitizeId(rawId)
  const { shaped, map } = readOpenCodeMap()
  if (id in map) {
    const next = { ...map }
    delete next[id]
    writeOpenCodeMap(shaped, next)
  }
  return true
}

/**
 * @param {string} rawHome
 * @returns {Promise<{ path: string, servers: Array<{ id: string, enabled: boolean, spec: object }> }>}
 */
function list(rawHome = 'claude') {
  const home = assertHome(rawHome)
  if (home === 'claude') return mcp.list()
  if (home === 'opencode') return listOpenCode()
  return listToml(home)
}

/**
 * @param {string} rawHome
 */
function upsert(rawHome = 'claude', rawId, rawSpec, enabled = true) {
  const home = assertHome(rawHome)
  if (home === 'claude') return mcp.upsert(rawId, rawSpec, enabled !== false)
  if (home === 'opencode') return upsertOpenCode(rawId, rawSpec, enabled !== false)
  return upsertToml(home, rawId, rawSpec, enabled !== false)
}

/**
 * @param {string} rawHome
 */
function toggle(rawHome = 'claude', rawId, enabled) {
  const home = assertHome(rawHome)
  if (home === 'claude') return mcp.toggle(rawId, enabled)
  if (home === 'opencode') return toggleOpenCode(rawId, enabled)
  return toggleToml(home, rawId, enabled)
}

/**
 * @param {string} rawHome
 */
function remove(rawHome = 'claude', rawId) {
  const home = assertHome(rawHome)
  if (home === 'claude') return mcp.remove(rawId)
  if (home === 'opencode') return removeOpenCode(rawId)
  return removeToml(home, rawId)
}

module.exports = {
  TEMPLATES: mcp.TEMPLATES,
  configure,
  homes,
  mcpFile,
  list,
  upsert,
  toggle,
  remove
}
