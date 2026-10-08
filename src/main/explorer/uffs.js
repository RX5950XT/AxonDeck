'use strict'

/**
 * UFFS 客戶端（Main Process）。
 *
 * 不把 Rust 引擎 vendoring 進來：找本機 `uffs.exe`、代跑 CLI。進檔案頁自動
 * 從 GitHub Releases 下載 zip、一次 UAC 裝 Access Broker、拉起 daemon。
 * 搜尋後閒置及關 App 會休眠用過的索引，保留 daemon 與磁碟快取。
 */

const fs = require('../raw-fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { downloadFile } = require('../hfmodels/download')
const { fail, realOf } = require('./paths')
const platform = require('../platform')
const { sanitizeSearchFilters, matchesSearchFilters } = require('./search-filter')
const linuxSearch = require('./linux-search')

/** Linux 整機檔名搜尋（plocate／App 自建索引）；第一次用到才載入 */
function linuxMachine() {
  return require('./linux-machine-search').machineSearch()
}

const MAX_PATTERN = 200
const SEARCH_LIMIT = 200
/** UFFS 先多取幾筆，篩選後才截給 UI，避免篩選器把前 200 筆吃掉。 */
const SEARCH_SCAN_LIMIT = 2000
const SEARCH_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 8_000
const SEARCH_IDLE_MS = 60_000
const MAX_STDOUT = 8 * 1024 * 1024
const MAX_ZIP_BYTES = 64 * 1024 * 1024
const ZIP_NAME = 'uffs-windows-x64.zip'
const ZIP_URL = 'https://github.com/skyllc-ai/UltraFastFileSearch/releases/latest/download/uffs-windows-x64.zip'
const SUMS_URL = 'https://github.com/skyllc-ai/UltraFastFileSearch/releases/latest/download/CHECKSUMS.txt'

/** @type {string} */
let userDataPath = ''
/** @type {import('child_process').ChildProcess | null} */
let searchChild = null
/** @type {AbortController | null} */
let downloadCtl = null
/** @type {Promise<object> | null} */
let ensureInflight = null
let hasUsedDaemon = false
let idleTimer = null
let releasing = null
const activeSearches = new Set()
let searchVersion = 0

function linuxUnsupported(code = 'UFFS_MISSING') {
  throw fail(code, '整機快速搜尋（UFFS）目前僅支援 Windows；Linux 請用資料夾內篩選。')
}


function scheduleRelease() {
  clearTimeout(idleTimer)
  idleTimer = null
  if (!hasUsedDaemon || activeSearches.size) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    void releaseMemory().catch(() => console.warn('[explorer] 索引記憶體釋放失敗'))
  }, SEARCH_IDLE_MS)
  idleTimer.unref?.()
}

/** 保留索引快取，下次搜尋由 UFFS 自動載回。從未使用過的外部 daemon 不碰。 */
async function releaseMemory() {
  clearTimeout(idleTimer)
  idleTimer = null
  if (!hasUsedDaemon || activeSearches.size) return false
  if (releasing) return releasing
  const exe = findUffs()
  if (!exe) return false
  releasing = run(exe, ['--daemon', 'hibernate'], { timeoutMs: 30_000 }).then(result => {
    if (result.code !== 0) throw fail('UFFS_FAILED', '搜尋記憶體釋放失敗')
    return true
  }).finally(() => { releasing = null })
  return releasing
}

async function shutdown() {
  if (platform.isLinux) {
    cancelSearch()
    return linuxMachine().stop()
  }
  clearTimeout(idleTimer)
  cancelSearch()
  await Promise.all([...activeSearches].map(child => new Promise(resolve => child.once('close', resolve))))
  return releaseMemory()
}

/** @param {string} dir */
function configure(dir) {
  userDataPath = typeof dir === 'string' ? dir : ''
  // 暫存 userData（CDP／沙箱）不建整機索引，也不落盤
  if (platform.isLinux) linuxMachine().configure(inTempUserData() ? '' : userDataPath)
}

function installDir() {
  return userDataPath ? path.join(userDataPath, 'uffs') : ''
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizePattern(raw) {
  if (typeof raw !== 'string') throw fail('BAD_QUERY', '搜尋條件不合法')
  const q = raw.trim()
  if (!q || q.length > MAX_PATTERN) throw fail('BAD_QUERY', '搜尋條件不合法')
  if (q.includes('\0') || q.startsWith('>') || q.startsWith('-')) {
    throw fail('BAD_QUERY', '搜尋條件不合法')
  }
  return q
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 在目錄樹裡找 uffs.exe（下載解壓後層級不固定）。
 * @param {string} dir
 * @returns {string}
 */
function findExeIn(dir) {
  if (!dir) return ''
  const direct = path.join(dir, 'uffs.exe')
  if (isFile(direct)) return direct
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const nested = path.join(dir, ent.name, 'uffs.exe')
    if (isFile(nested)) return nested
  }
  return ''
}

/** @returns {string} */
function findUffs() {
  return findExeIn(installDir())
}

function brokerPath(uffsExe) {
  if (!uffsExe) return ''
  const file = path.join(path.dirname(uffsExe), 'uffs-broker.exe')
  return isFile(file) ? file : ''
}

/**
 * CDP 暫存 userData 在 %TEMP%，自動授權會卡住測試。沒設定也當成暫存。
 * @returns {boolean}
 */
function inTempUserData() {
  if (!userDataPath) return true
  const tmp = String(os.tmpdir() || '').replace(/[\\/]+$/, '').toLowerCase()
  const dir = String(userDataPath).replace(/[\\/]+$/, '').toLowerCase()
  if (!tmp || !dir) return true
  return dir === tmp || dir.startsWith(tmp + path.sep)
}

/**
 * 進頁要不要自己把搜尋引擎拉起來。
 * @param {{ installed?: boolean, broker?: { present?: boolean, installed?: boolean }, daemon?: { running?: boolean } } | null} st
 * @param {{ auto?: boolean }} [opts]
 */
function needsEnsure(st, opts = {}) {
  if (opts.auto === false) return false
  if (!st || !st.installed) return true
  if (st.broker && st.broker.present && !st.broker.installed) return true
  if (!st.daemon || !st.daemon.running) return true
  return false
}

/**
 * @param {string} exe
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(exe, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || STATUS_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: false
      })
    } catch {
      reject(fail('UFFS_FAILED', '搜尋失敗'))
      return
    }
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let timed = false
    const timer = setTimeout(() => {
      timed = true
      try { child.kill() } catch { /* 已經停了 */ }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk])
      if (out.length > MAX_STDOUT) {
        try { child.kill() } catch { /* 已經停了 */ }
      }
    })
    child.stderr.on('data', (chunk) => {
      err = Buffer.concat([err, chunk], Math.min(err.length + chunk.length, 4096))
    })
    child.on('error', () => {
      clearTimeout(timer)
      reject(fail('UFFS_FAILED', '搜尋失敗'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timed) {
        reject(fail('UFFS_TIMEOUT', '搜尋逾時'))
        return
      }
      resolve({
        code: Number(code) || 0,
        stdout: out.toString('utf8'),
        stderr: err.toString('utf8')
      })
    })
  })
}

function cancelSearch(keepVersion = false) {
  if (!keepVersion) searchVersion += 1
  if (!searchChild) return
  try { searchChild.kill() } catch { /* 已經停了 */ }
  searchChild = null
}

/**
 * @param {string} stdout
 * @returns {object[]}
 */
function parseJsonRows(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.rows)) return parsed.rows
    if (parsed && Array.isArray(parsed.results)) return parsed.results
  } catch {
    // 改走 NDJSON
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      // 跳過壞行
    }
  }
  return rows
}

/**
 * @param {object} row
 * @returns {{ name: string, path: string, dir: boolean, size: number, mtimeMs: number } | null}
 */
/**
 * `uffs --status --json` 的機器可讀狀態。欄位名跟 UFFS 走，缺的當沒裝／沒跑。
 * @param {string} stdout
 */
function parseStatusJson(stdout) {
  let parsed = {}
  try {
    parsed = JSON.parse(String(stdout || '{}'))
  } catch {
    parsed = {}
  }
  if (!parsed || typeof parsed !== 'object') parsed = {}
  const daemon = parsed.daemon && typeof parsed.daemon === 'object' ? parsed.daemon : parsed
  const broker = parsed.broker && typeof parsed.broker === 'object' ? parsed.broker : {}
  const state = String(daemon.status?.status?.state || daemon.status?.state || daemon.status || '').toLowerCase()
  const warming = state.includes('load') || state.includes('start')
    || (state.includes('warm') && state !== 'warm' && state !== 'hot')
  return {
    daemon: {
      running: daemon.running === true,
      warming: warming || (Array.isArray(daemon.drives) && daemon.drives.some(drive => drive.loading === true)),
      drives: Array.isArray(daemon.drives) ? daemon.drives.length : Number(daemon.drives) || 0,
      records: Number((daemon.stats && daemon.stats.total_records) || daemon.records) || 0
    },
    broker: {
      installed: broker.installed === true
    }
  }
}

/**
 * 搜尋失敗時只回固定 kind，stderr（含 uffsd 路徑）不准進 UI。
 * @param {unknown} code
 * @param {unknown} stderr
 * @returns {{ kind: 'ok'|'warming'|'broker'|'failed' }}
 */
function classifySearchError(code, stderr) {
  const text = String(stderr || '').toLowerCase()
  if (text.includes('warming') || text.includes('starting up') || text.includes('starting')) {
    return { kind: 'warming' }
  }
  if (!Number(code)) return { kind: 'ok' }
  if (/admin|elevat|privileg|broker|master file table/.test(text)) {
    return { kind: 'broker' }
  }
  return { kind: 'failed' }
}

function sanitizeHit(row) {
  if (!row || typeof row !== 'object') return null
  const full = typeof row.path === 'string'
    ? row.path
    : typeof row.Path === 'string' ? row.Path : ''
  if (!full) return null
  let abs
  try {
    abs = require('./paths').resolveAbs(full)
  } catch {
    return null
  }
  const name = typeof row.name === 'string' && row.name
    ? row.name
    : path.basename(abs)
  const type = String(row.type || row.Type || '').toLowerCase()
  const dir = type === 'dir' || type === 'directory' || row.directory === true || row.is_directory === true
  const size = Number(row.size || row.Size) || 0
  const written = row.written || row.Written || row.modified || row.mtime
  const parsedTime = typeof written === 'number'
    ? written === row.modified ? written / 10000 - 11644473600000 : 0 // UFFS modified 是 Windows FILETIME。
    : written ? Date.parse(String(written)) || 0 : 0
  const mtimeMs = Number.isFinite(parsedTime) && parsedTime > 0 && parsedTime <= 8640000000000000 ? parsedTime : 0
  const ext = dir ? '' : path.extname(name).slice(1).toLowerCase()
  return { name, path: abs, dir, size, mtimeMs, ext }
}

function dateFilterArg(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/**
 * 先讓 UFFS 在 MFT 端縮小結果，再用 matchesSearchFilters 做最後防線。
 * 未支援原生的 `other` 類型仍由本地分類，整個流程沒有自行走訪磁碟。
 * @param {object} rawFilters
 * @returns {string[]}
 */
function searchFilterArgs(rawFilters) {
  const filters = sanitizeSearchFilters(rawFilters)
  const args = []
  if (filters.type === 'file') args.push('--files-only')
  else if (filters.type === 'folder') args.push('--dirs-only')
  else {
    const nativeType = {
      image: 'picture',
      video: 'video',
      audio: 'audio',
      document: 'document',
      archive: 'archive',
      code: 'code'
    }[filters.type]
    if (nativeType) args.push('--type', nativeType)
  }
  if (filters.minSize !== null) args.push('--min-size', String(filters.minSize))
  if (filters.maxSize !== null) args.push('--max-size', String(filters.maxSize))
  const newer = dateFilterArg(filters.fromMs)
  if (newer) args.push('--newer', newer)
  const older = dateFilterArg(filters.toMs)
  if (older) args.push('--older', older)
  if (filters.location) args.push('--in-path', `*${filters.location}*`)
  return args
}

/**
 * @returns {Promise<{
 *   installed: boolean, version: string,
 *   daemon: { running: boolean, warming: boolean, drives: number, records: number },
 *   broker: { present: boolean }
 * }>}
 */
async function status() {
  if (platform.isLinux) {
    // 暫存 userData 不建整機索引：維持原本的資料夾樹搜尋
    if (inTempUserData()) {
      return {
        installed: true,
        version: 'folder',
        daemon: { running: true, warming: false, drives: 0, records: 0 },
        broker: { present: false, installed: false },
        unsupported: false,
        mode: 'folder',
        message: '目前資料夾樹檔名搜尋（非整機索引）'
      }
    }
    return linuxMachine().status()
  }
  if (!platform.isWindows) {
    return {
      installed: false,
      version: '',
      daemon: { running: false, warming: false, drives: 0, records: 0 },
      broker: { present: false, installed: false },
      unsupported: true,
      message: 'UFFS 整機搜尋尚未移植到此平台'
    }
  }
  const exe = findUffs()
  const empty = {
    installed: false,
    version: '',
    daemon: { running: false, warming: false, drives: 0, records: 0 },
    broker: { present: false, installed: false }
  }
  if (!exe) return empty
  empty.installed = true
  empty.broker.present = Boolean(brokerPath(exe))
  try {
    const ver = await run(exe, ['--version'], { timeoutMs: 4000 })
    empty.version = String(ver.stdout || '').trim().split(/\r?\n/)[0].slice(0, 80)
  } catch {
    empty.version = ''
  }
  try {
    const raw = await run(exe, ['--status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS })
    const parsed = parseStatusJson(raw.stdout)
    empty.daemon = parsed.daemon
    empty.broker.installed = parsed.broker.installed
  } catch {
    // daemon 沒在跑不算錯誤
  }
  return empty
}

/**
 * @param {unknown} raw
 * @param {unknown} rawFilters
 * @returns {Promise<{ hits: object[], truncated: boolean, warming: boolean }>}
 */
async function search(raw, rawFilters) {
  if (platform.isLinux) {
    const version = ++searchVersion
    const isCancelled = () => version !== searchVersion
    if (inTempUserData()) return linuxSearch.searchLocal(raw, rawFilters, { isCancelled })
    return linuxMachine().search(raw, rawFilters, { isCancelled })
  }
  if (!platform.isWindows) linuxUnsupported()
  sanitizePattern(raw)
  const version = ++searchVersion
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  while (version === searchVersion && Date.now() < deadline) {
    const result = await searchOnce(raw, rawFilters, version, deadline)
    if (version !== searchVersion) break
    let warming = result.warming
    try {
      const rawStatus = await run(findUffs(), ['--status', '--json'])
      warming ||= parseStatusJson(rawStatus.stdout).daemon.warming
    } catch { /* 搜尋已成功；狀態查詢失敗時仍回傳這次命中。 */ }
    if (version !== searchVersion) break
    if (!warming) return result
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (version !== searchVersion) return { hits: [], truncated: false, warming: false, cancelled: true }
  throw fail('UFFS_TIMEOUT', '搜尋逾時')
}

async function searchOnce(raw, rawFilters, version, deadline) {
  const pattern = sanitizePattern(raw)
  const filters = sanitizeSearchFilters(rawFilters)
  const exe = findUffs()
  if (!exe) throw fail('UFFS_MISSING', '尚未安裝快速搜尋')
  clearTimeout(idleTimer)
  if (releasing) await releasing.catch(() => {}) // 休眠失敗不阻止正常搜尋。
  if (version !== searchVersion) return { hits: [], truncated: false, warming: false, cancelled: true }
  cancelSearch(true)
  // ponytail: UFFS 0.6.40 帶點查詢會漏檔；文字／基本 glob 改用受控 regex，上游修正後移除。
  // 進階 glob 與路徑 glob 仍交給上游，避免自己重寫整套語法。
  let query = pattern
  const glob = /[*?]/.test(pattern)
  if (pattern.includes('.') && !/[\[\]{}|]/.test(pattern) && (!glob || !/[\\/]/.test(pattern))) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    query = glob
      ? `>(?:^|[\\\\/])${escaped.replace(/\\\*/g, '[^\\\\/]*').replace(/\\\?/g, '[^\\\\/]')}$`
      : `>.*${escaped}.*`
  }
  const args = [
    query,
    '--format', 'json',
    '--limit', String(SEARCH_SCAN_LIMIT),
    '--columns', 'path,name,size,written,type',
    '--hide-system',
    '--hide-ads'
  ]
  args.push(...searchFilterArgs(filters))
  const result = await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      reject(fail('UFFS_FAILED', '搜尋失敗'))
      return
    }
    searchChild = child
    hasUsedDaemon = true
    activeSearches.add(child)
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let timed = false
    const timer = setTimeout(() => {
      timed = true
      try { child.kill() } catch { /* 已經停了 */ }
    }, Math.max(1, deadline - Date.now()))
    child.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk])
      if (out.length > MAX_STDOUT) {
        try { child.kill() } catch { /* 已經停了 */ }
      }
    })
    child.stderr.on('data', (chunk) => {
      err = Buffer.concat([err, chunk], Math.min(err.length + chunk.length, 4096))
    })
    child.on('error', () => {
      clearTimeout(timer)
      if (searchChild === child) searchChild = null
      activeSearches.delete(child)
      scheduleRelease()
      reject(fail('UFFS_FAILED', '搜尋失敗'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (searchChild === child) searchChild = null
      activeSearches.delete(child)
      scheduleRelease()
      if (timed) {
        reject(fail('UFFS_TIMEOUT', '搜尋逾時'))
        return
      }
      resolve({
        code: Number(code) || 0,
        stdout: out.toString('utf8'),
        stderr: err.toString('utf8')
      })
    })
  })
  const kind = classifySearchError(result.code, result.stderr).kind
  if (kind === 'warming') return { hits: [], truncated: false, warming: true }
  if (kind === 'broker') throw fail('UFFS_BROKER', '需要授權讀取磁碟')
  if (kind === 'failed') throw fail('UFFS_FAILED', '搜尋失敗')
  const rows = parseJsonRows(result.stdout)
  const hits = []
  for (const row of rows) {
    const hit = sanitizeHit(row)
    if (hit && matchesSearchFilters(hit, filters)) hits.push(hit)
    if (hits.length >= SEARCH_LIMIT) break
  }
  return {
    hits: require('./rank').rankHits(pattern, hits),
    truncated: rows.length >= SEARCH_SCAN_LIMIT || hits.length >= SEARCH_LIMIT,
    warming: false,
    filters
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * @param {string} zipPath
 * @param {string} dest
 */
async function unzip(zipPath, dest) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(dest)} -Force`
  const result = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeoutMs: 120_000
  })
  if (result.code !== 0) throw fail('UFFS_INSTALL', '解壓失敗')
}

/**
 * @param {string} text
 * @param {string} fileName
 * @returns {string}
 */
function checksumFor(text, fileName) {
  const lower = fileName.toLowerCase()
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/([a-fA-F0-9]{64})\s+(\S+)/)
    if (m && m[2].toLowerCase().includes(lower)) return m[1].toLowerCase()
  }
  return ''
}

/**
 * checksum 缺或對不上都失敗（不可 fail-open）。
 * @param {string} file
 * @param {string} sumsText
 * @param {string} fileName
 */
function verifyZipHash(file, sumsText, fileName) {
  const expected = checksumFor(sumsText, fileName)
  if (!expected) throw fail('UFFS_INSTALL', '下載檔案驗證失敗')
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  if (hash.digest('hex') !== expected) throw fail('UFFS_INSTALL', '下載檔案驗證失敗')
}

/**
 * @param {(info: { received: number, total: number }) => void} [onProgress]
 */
async function download(onProgress) {
  if (!platform.isWindows) linuxUnsupported('UFFS_INSTALL')
  const destDir = installDir()
  if (!destDir) throw fail('UFFS_INSTALL', '找不到安裝位置')
  if (downloadCtl) throw fail('UFFS_INSTALL', '下載進行中')
  fs.mkdirSync(destDir, { recursive: true })
  const controller = new AbortController()
  downloadCtl = controller
  const zipPath = path.join(destDir, ZIP_NAME)
  try {
    await downloadFile({ url: ZIP_URL, dest: zipPath, signal: controller.signal, onProgress, maxBytes: MAX_ZIP_BYTES })
    // checksum 是信任來源，只向官方取；ZIP 才可使用下載加速節點。
    const sums = await fetch(SUMS_URL, { signal: controller.signal, redirect: 'follow' })
    verifyZipHash(zipPath, sums.ok ? await sums.text() : '', ZIP_NAME)
    if (controller.signal.aborted) throw fail('UFFS_INSTALL', '下載已取消')
    await unzip(zipPath, destDir)
    const exe = findExeIn(destDir)
    if (!exe) throw fail('UFFS_INSTALL', '解壓後找不到 uffs')
    const destReal = path.resolve(destDir).toLowerCase()
    const exeReal = (realOf(exe) || path.resolve(exe)).toLowerCase()
    if (exeReal !== destReal && !exeReal.startsWith(destReal + path.sep)) {
      throw fail('UFFS_INSTALL', '解壓後找不到 uffs')
    }
    return status()
  } catch (error) {
    throw error?.code === 'UFFS_INSTALL' ? error : fail('UFFS_INSTALL', '下載失敗')
  } finally {
    for (const file of [zipPath, `${zipPath}.part`]) {
      try { fs.unlinkSync(file) } catch { /* 清掉 ZIP 與半套；已刪除或仍鎖住則略過 */ }
    }
    if (downloadCtl === controller) downloadCtl = null
  }
}

function cancelDownload() {
  if (downloadCtl) downloadCtl.abort()
  return true
}

/**
 * 安裝 Access Broker（一次 UAC）。
 */
async function installBroker() {
  const exe = findUffs()
  const broker = brokerPath(exe)
  if (!broker) throw fail('UFFS_MISSING', '尚未安裝快速搜尋')
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(
    `Start-Process -FilePath ${psQuote(broker)} -ArgumentList '--install' -Verb RunAs -Wait`,
    'utf16le'
  ).toString('base64')
  const result = await run(ps, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { timeoutMs: 120_000 })
  if (result.code !== 0) throw fail('UFFS_BROKER', '授權安裝已取消或失敗')
  return status()
}

/**
 * @param {{ elevate?: boolean }} [opts]
 */
async function startDaemon(opts = {}) {
  const exe = findUffs()
  if (!exe) throw fail('UFFS_MISSING', '尚未安裝快速搜尋')
  const args = ['--daemon', 'start']
  if (opts.elevate) args.push('--elevate')
  const result = await run(exe, args, { timeoutMs: 90_000 })
  const kind = classifySearchError(result.code, result.stderr).kind
  if (kind === 'warming') return true
  if (kind === 'broker') throw fail('UFFS_BROKER', '需要授權讀取磁碟')
  if (result.code !== 0) throw fail('UFFS_FAILED', '搜尋引擎啟動失敗')
  return true
}

/**
 * 下載（若缺）→ 一次 UAC 裝 broker → 拉起 daemon。進頁才呼叫。
 * @param {{ auto?: boolean, onProgress?: (info: { received: number, total: number }) => void }} [opts]
 */
async function ensureReady(opts = {}) {
  if (platform.isLinux && opts.auto !== false && !inTempUserData()) {
    return linuxMachine().ensure({ onProgress: opts.onProgress })
  }
  if (!platform.isWindows) return status()
  if (opts.auto === false) return status()
  if (ensureInflight) return ensureInflight
  ensureInflight = runEnsure(opts).finally(() => { ensureInflight = null })
  return ensureInflight
}

/**
 * @param {{ onProgress?: (info: { received: number, total: number }) => void }} opts
 */
async function runEnsure(opts) {
  let st = await status()
  if (!needsEnsure(st, { auto: true })) return st
  if (!st.installed) {
    st = await download(typeof opts.onProgress === 'function' ? opts.onProgress : undefined)
  }
  if (st.broker.present && !st.broker.installed) {
    st = await installBroker()
  }
  if (st.installed && !st.daemon.running && !st.broker.installed) {
    await startDaemon({ elevate: !st.broker.installed })
    hasUsedDaemon = true
    scheduleRelease()
    st = await status()
  }
  return st
}

module.exports = {
  MAX_PATTERN,
  SEARCH_LIMIT,
  SEARCH_SCAN_LIMIT,
  MAX_ZIP_BYTES,
  sanitizePattern,
  configure,
  findUffs,
  inTempUserData,
  needsEnsure,
  status,
  search,
  cancelSearch,
  download,
  cancelDownload,
  installBroker,
  startDaemon,
  ensureReady,
  releaseMemory,
  shutdown,
  parseJsonRows,
  parseStatusJson,
  classifySearchError,
  sanitizeHit,
  searchFilterArgs,
  checksumFor,
  verifyZipHash
}
