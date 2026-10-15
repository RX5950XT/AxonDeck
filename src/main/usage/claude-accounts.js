'use strict'

/**
 * Claude Code 官方訂閱多帳號（Main Process）。
 *
 * 做法跟 GitHub 上的 claude-swap／clauth 同一套：Claude Code 的登入只有兩處——
 * `<設定資料夾>/.credentials.json` 的 `claudeAiOauth`（token）與 `.claude.json` 的 `oauthAccount`（是誰）。
 * 每個帳號存一份這兩塊的快照，切換＝把目標那份寫回去，其他欄位（`mcpOAuth`、專案設定…）原樣保留。
 *
 * **refresh token 會輪替**，所以誰是「最新的那一代」要講清楚：
 *  - 使用中的帳號：以 CLI 的檔案為準。每次同步／切換前都先把檔案抄回快照（`captureLive`），
 *    快照永遠不拿去續期——續了等於把 CLI 手上那顆作廢。
 *  - 沒在用的帳號：只有我們拿著，查額度前快過期就自己續、寫回快照。
 *  - 續期、抄快照、切換全部排同一條隊（`serial`），不會一邊續一邊被切進檔案。
 *
 * 新增帳號：在暫存的 `CLAUDE_CONFIG_DIR` 跑官方 `claude auth login --claudeai`，登入完把那份抄進來，
 * 目前使用中的登入完全不碰。
 *
 * token 存在自己的 electron-store（`claude-accounts.json`），**不進 allowlist**，只走列舉過的 `usage:*` IPC；
 * 回給 renderer 的清單不含 token。
 */

const { spawn } = require('child_process')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { acquireLocks, configDirOf, isExpiring, postRefresh } = require('./claude-auth')
const { applyClaudeUsage, requestClaudeUsage } = require('./claude')
const { UsageError } = require('./shared')
const { removeTreeSync } = require('../safe-rm')

const MAX_ACCOUNTS = 10
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** @type {{ getStore: (() => Promise<object>) | null, spawnImpl: Function }} */
const deps = { getStore: null, spawnImpl: spawn }
let storePromise = null
let chain = Promise.resolve()
/** @type {{ child: import('child_process').ChildProcess, cancelled: boolean } | null} */
let login = null

/** 測試注入 store／spawn */
function configure(options = {}) {
  if (typeof options.getStore === 'function') deps.getStore = options.getStore
  if (typeof options.spawnImpl === 'function') deps.spawnImpl = options.spawnImpl
}

function getStore() {
  if (deps.getStore) return deps.getStore()
  if (!storePromise) {
    storePromise = import('electron-store').then(({ default: Store }) => new Store({ name: 'claude-accounts' }))
  }
  return storePromise
}

/** 讀寫快照、切換檔案一律排隊 */
function serial(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/** `.claude.json`：有設 CLAUDE_CONFIG_DIR 就在那個資料夾裡，否則在家目錄 */
function globalConfigOf(homeDir, env = process.env) {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(configDirOf(homeDir, env), '.claude.json')
    : path.join(homeDir, '.claude.json')
}

async function readObject(file) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new UsageError('FILE_READ_FAILED', '無法讀取 Claude Code 登入資料')
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 下面一起丟 */ }
  throw new UsageError('INVALID_JSON', 'Claude Code 登入資料格式錯誤')
}

/** 先寫暫存檔再 rename，CLI 不會讀到寫一半的檔 */
async function writeAtomic(file, data) {
  const tmp = `${file}.axondeck-${process.pid}-${Date.now()}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fsp.rename(tmp, file)
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    throw new UsageError('FILE_WRITE_FAILED', '無法寫入 Claude Code 登入資料')
  }
}

/**
 * 某個設定資料夾目前登入的是誰。沒登入（或缺身分）回 null。
 * @param {string} credentialsFile @param {string} configFile
 */
async function readLogin(credentialsFile, configFile) {
  const creds = await readObject(credentialsFile).catch(() => null)
  const config = await readObject(configFile).catch(() => null)
  const oauth = creds?.claudeAiOauth
  const account = config?.oauthAccount
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null
  if (typeof account?.accountUuid !== 'string' || !account.accountUuid) return null
  return { oauth, account }
}

function readLive(homeDir, env) {
  return readLogin(path.join(configDirOf(homeDir, env), '.credentials.json'), globalConfigOf(homeDir, env))
}

/** 存檔裡的一筆 → 驗過的形狀（壞的丟掉） */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 100) : ''
  if (!id || typeof raw.oauth?.accessToken !== 'string' || !raw.oauth.accessToken) return null
  if (!raw.oauthAccount || typeof raw.oauthAccount !== 'object') return null
  return {
    id,
    email: typeof raw.email === 'string' ? raw.email.slice(0, 200) : '',
    oauth: raw.oauth,
    oauthAccount: raw.oauthAccount,
    savedAt: Number(raw.savedAt) || 0
  }
}

async function readItems() {
  const raw = (await getStore()).get('accounts', [])
  return Array.isArray(raw) ? raw.map(sanitizeItem).filter(Boolean) : []
}

async function writeItems(items) {
  ;(await getStore()).set('accounts', items.slice(0, MAX_ACCOUNTS))
}

/** 同一個人（accountUuid）就蓋掉舊那份；token 沒變就不寫 */
async function upsert({ oauth, account }) {
  const items = await readItems()
  const id = account.accountUuid.slice(0, 100)
  const old = items.find((item) => item.id === id)
  if (old && old.oauth.accessToken === oauth.accessToken && old.oauth.refreshToken === oauth.refreshToken &&
    old.email === (account.emailAddress || '')) return old
  if (!old && items.length >= MAX_ACCOUNTS) throw new UsageError('TOO_MANY_ACCOUNTS', `最多存 ${MAX_ACCOUNTS} 個帳號`)
  const next = { id, email: String(account.emailAddress || '').slice(0, 200), oauth, oauthAccount: account, savedAt: Date.now() }
  await writeItems(old ? items.map((item) => (item.id === id ? next : item)) : [...items, next])
  return next
}

function planOf(item) {
  const type = String(item.oauth?.subscriptionType || '').toLowerCase()
  return applyClaudeUsage({}, 0, type).planName
}

function toPublic(item, activeId) {
  return {
    id: item.id,
    email: item.email,
    orgName: typeof item.oauthAccount?.organizationName === 'string' ? item.oauthAccount.organizationName.slice(0, 200) : '',
    planName: planOf(item),
    active: item.id === activeId
  }
}

/** 使用中的排第一，其餘照加入順序 */
function activeFirst(items) {
  return [...items.filter((item) => item.active), ...items.filter((item) => !item.active)]
}

/** 把使用中的登入抄進快照（新登入的帳號也是這樣自動加進來的） */
async function captureLive(homeDir, env) {
  const live = await readLive(homeDir, env)
  if (!live) return ''
  await upsert(live)
  return live.account.accountUuid
}

/**
 * @param {{ homeDir: string, env?: object }} args
 */
function list({ homeDir, env = process.env }) {
  return serial(async () => {
    const activeId = await captureLive(homeDir, env)
    return activeFirst((await readItems()).map((item) => toPublic(item, activeId)))
  })
}

/**
 * 切到某個存起來的帳號：先抄回使用中的最新 token，再把目標寫進 CLI 的兩個檔。
 * 跟 Claude Code 續期用同兩把鎖，不會跟它的續期撞在一起。
 * @param {unknown} id
 * @param {{ homeDir: string, env?: object }} args
 */
function switchTo(id, { homeDir, env = process.env }) {
  return serial(async () => {
    if (typeof id !== 'string' || !id) throw new UsageError('NO_ACCOUNT', '找不到這個帳號，請重新整理')
    const configDir = configDirOf(homeDir, env)
    await fsp.mkdir(configDir, { recursive: true })
    const release = await acquireLocks(configDir)
    try {
      const activeId = await captureLive(homeDir, env)
      const target = (await readItems()).find((item) => item.id === id)
      if (!target) throw new UsageError('NO_ACCOUNT', '找不到這個帳號，請重新整理')
      if (activeId === id) return toPublic(target, id)
      const credsFile = path.join(configDir, '.credentials.json')
      const configFile = globalConfigOf(homeDir, env)
      // 讀不懂的檔不蓋（readObject 會丟錯），不存在才從空的開始
      const creds = (await readObject(credsFile)) || {}
      const config = (await readObject(configFile)) || {}
      await writeAtomic(credsFile, { ...creds, claudeAiOauth: target.oauth })
      try {
        await writeAtomic(configFile, { ...config, oauthAccount: target.oauthAccount })
      } catch (error) {
        // 只換一半的話，下次抄快照會把新帳號的 token 存到舊帳號名下
        await writeAtomic(credsFile, creds)
        throw error
      }
      return toPublic(target, id)
    } finally {
      await release()
    }
  })
}

/**
 * 只刪快照；使用中的不能刪（刪了下一次同步又會被抄回來）。
 * @param {unknown} id
 * @param {{ homeDir: string, env?: object }} args
 */
function remove(id, { homeDir, env = process.env }) {
  return serial(async () => {
    const activeId = (await readLive(homeDir, env))?.account.accountUuid || ''
    if (id === activeId) throw new UsageError('ACTIVE_ACCOUNT', '使用中的帳號不能移除，先切到別的帳號')
    const items = await readItems()
    await writeItems(items.filter((item) => item.id !== id))
    return true
  })
}

/** Claude Code 執行檔：官方安裝器放 `~/.local/bin`，其次找 PATH */
function findClaude(homeDir, env) {
  const candidates = [path.join(homeDir, '.local', 'bin', 'claude.exe')]
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'claude.exe'))
  }
  return candidates.find((file) => { try { return fs.statSync(file).isFile() } catch { return false } }) || ''
}

/**
 * 登入一個新帳號（不影響使用中的登入）。等使用者在瀏覽器登完才回；`cancelLogin()` 可以中止。
 * @param {{ homeDir: string, env?: object }} args
 */
async function beginLogin({ homeDir, env = process.env }) {
  if (login) throw new UsageError('LOGIN_BUSY', '已經有一個登入在進行中')
  const exe = findClaude(homeDir, env)
  if (!exe) throw new UsageError('NO_CLI', '找不到 Claude Code，請先到設定頁安裝')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'axondeck-claude-login-'))
  try {
    // stdin 要 ignore：留一條收不到 EOF 的管線會讓 CLI 卡著等輸入（AGENTS.md 有記）
    const child = deps.spawnImpl(exe, ['auth', 'login', '--claudeai'], {
      env: { ...env, CLAUDE_CONFIG_DIR: dir },
      cwd: homeDir,
      stdio: 'ignore',
      windowsHide: true
    })
    login = { child, cancelled: false }
    const current = login
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS)
      child.once('error', () => { clearTimeout(timer); resolve() })
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    if (current.cancelled) throw new UsageError('LOGIN_CANCELLED', '已取消登入')
    const fresh = await readLogin(path.join(dir, '.credentials.json'), path.join(dir, '.claude.json'))
    if (!fresh) throw new UsageError('LOGIN_FAILED', '登入沒有完成，請再試一次')
    const saved = await serial(() => upsert(fresh))
    const activeId = (await readLive(homeDir, env))?.account.accountUuid || ''
    return toPublic(saved, activeId)
  } finally {
    login = null
    try { removeTreeSync(dir) } catch { /* 暫存資料夾刪不掉不影響結果 */ }
  }
}

function cancelLogin() {
  if (!login) return false
  login.cancelled = true
  login.child.kill()
  return true
}

/**
 * 沒在用的帳號：快過期（或 401）就自己續，續完寫回快照。在隊伍裡做，而且再確認一次它還沒被切成使用中。
 * @returns {Promise<string>} 可用的 access token
 */
function refreshStored(id, homeDir, env, { force = false, fetchImpl } = {}) {
  return serial(async () => {
    const item = (await readItems()).find((entry) => entry.id === id)
    if (!item) throw new UsageError('NO_ACCOUNT', '帳號已移除')
    const live = await readLive(homeDir, env)
    if (live?.account.accountUuid === id) return live.oauth.accessToken
    if (!force && !isExpiring(item.oauth, Date.now())) return item.oauth.accessToken
    if (!item.oauth.refreshToken) throw new UsageError('NO_REFRESH_TOKEN', '登入已過期，請重新登入這個帳號')
    const update = await postRefresh(item.oauth, { fetchImpl })
    const items = await readItems()
    await writeItems(items.map((entry) => (entry.id === id ? { ...entry, oauth: { ...entry.oauth, ...update } } : entry)))
    return update.accessToken
  })
}

/** 一個沒在用的帳號的額度 */
async function usageOf(item, { homeDir, env, nowMs, fetchImpl, authFetchImpl, log }) {
  const base = { id: item.id, email: item.email, planName: planOf(item), active: false, windows: [], lastUpdated: new Date(nowMs).toISOString() }
  try {
    let token = await refreshStored(item.id, homeDir, env, { fetchImpl: authFetchImpl })
    let raw
    try {
      raw = await requestClaudeUsage(token, { fetchImpl, cooldownScope: item.id })
    } catch (error) {
      if (error.status !== 401) throw error
      token = await refreshStored(item.id, homeDir, env, { force: true, fetchImpl: authFetchImpl })
      raw = await requestClaudeUsage(token, { fetchImpl, cooldownScope: item.id })
    }
    const account = applyClaudeUsage(raw, nowMs, item.oauth.subscriptionType)
    return { ...base, status: account.status, windows: account.windows, notes: '' }
  } catch (error) {
    log(`claude: stored account failed ${error.status ? `HTTP ${error.status}` : error.code || 'unknown'}`)
    // 續期被 4xx 打回（invalid_grant）＝這組 refresh token 已經作廢；5xx／網路問題只是暫時的
    const expired = error.status === 401 || error.code === 'NO_REFRESH_TOKEN' ||
      (error.code === 'REFRESH_FAILED' && error.status >= 400 && error.status < 500)
    return {
      ...base,
      status: expired ? 'disconnected' : 'connected',
      notes: expired ? '登入已失效，請重新登入這個帳號。' : error.status === 429 ? '查詢太頻繁，稍後自動再試。' : '暫時查不到額度。'
    }
  }
}

/**
 * 把各帳號的額度掛到 Claude Code 那張卡上（`profiles`）。存了兩個以上才掛，一個帳號時畫面跟以前一樣。
 * @param {object} account `syncClaude` 的結果（使用中那個帳號）
 * @param {{ homeDir: string, env?: object, nowMs: number, fetchImpl?: Function, authFetchImpl?: Function, log?: Function }} args
 */
async function withProfiles(account, args) {
  const { homeDir, env = process.env, log = () => {} } = args
  let activeId = ''
  let items = []
  try {
    activeId = await serial(() => captureLive(homeDir, env))
    items = await readItems()
  } catch {
    log('claude: account snapshots unavailable')
    return account
  }
  if (items.length < 2) return account
  const profiles = await Promise.all(items.map((item) => (item.id === activeId
    ? {
        id: item.id,
        email: item.email,
        planName: account.planName,
        active: true,
        status: account.status,
        windows: account.windows,
        notes: account.windows.length ? '' : account.notes,
        lastUpdated: account.lastUpdated
      }
    : usageOf(item, { ...args, env, log }))))
  return { ...account, profiles: activeFirst(profiles) }
}

function resetForTests() {
  chain = Promise.resolve()
  login = null
  storePromise = null
  deps.getStore = null
  deps.spawnImpl = spawn
}

module.exports = {
  beginLogin,
  cancelLogin,
  configure,
  list,
  remove,
  resetForTests,
  switchTo,
  withProfiles
}
