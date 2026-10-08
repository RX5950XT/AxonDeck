'use strict'

/**
 * Linux 右鍵的壓縮／解壓縮（取代 Windows 殼層的 7-Zip 選單）。
 *
 * 工具優先序：7-Zip（`7zz` → `7z` → `7za`）→ `bsdtar`（libarchive）→ GNU `tar`／`zip`／`unzip`。
 * 找不到能做的工具就不列那個動作（shell-linux.js 另列一行灰色提示）。
 *
 * 安全與不覆寫：
 * - 壓縮先寫到同資料夾的隱藏暫存檔（`.axd-partial-*.zip`），完成才改名成 `名稱.zip`；
 *   同名就變 `名稱 (2).zip`，**不覆寫既有檔案**。取消／失敗刪掉暫存檔。
 * - 解壓縮一律先解到目的地資料夾裡的隱藏暫存資料夾（`.axd-extract-*`），完成才搬到位；
 *   「解壓縮到這裡」遇到同名項目要使用者確認（shell-linux.js 先問），確認後舊的丟進回收筒，不是刪掉。
 * - 壓縮檔內的 `..`／絕對路徑只會落在暫存資料夾底下（各工具本身也會剝掉）；搬到位只搬暫存資料夾的第一層。
 *
 * 外部程序一律 `spawn(..., { shell: false })`＋陣列參數；檔名一律以 `./名稱` 或 `--` 之後傳入，避免被當成選項。
 */

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const fsp = require('../raw-fs').promises
const path = require('path')

const SEVEN_ZIP = ['7zz', '7z', '7za']
const TAR_KINDS = new Set(['tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst'])
const KIND_BY_EXT = [
  [/\.(tar\.gz|tgz)$/i, 'tar.gz'], [/\.(tar\.bz2|tbz2?)$/i, 'tar.bz2'], [/\.(tar\.xz|txz)$/i, 'tar.xz'],
  [/\.(tar\.zst|tzst)$/i, 'tar.zst'], [/\.tar$/i, 'tar'], [/\.zip$/i, 'zip'], [/\.7z$/i, '7z'], [/\.rar$/i, 'rar']
]
/** 壓縮的三種格式：選單順序就是這個順序 */
const FORMATS = Object.freeze(['zip', '7z', 'tar.gz'])
const TOOL_CACHE_MS = 30_000

let toolCache = null

/** @param {string} name @param {NodeJS.ProcessEnv} env */
function which(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) {
    const full = path.join(dir, name)
    try { fs.accessSync(full, fs.constants.X_OK); return full } catch { /* 下一個 */ }
  }
  return ''
}

/**
 * 這台機器有哪些壓縮工具（快取 30 秒，裝了新工具不用重開 App）。
 * @param {{ env?: NodeJS.ProcessEnv, fresh?: boolean }} [opts]
 */
function detectTools(opts = {}) {
  if (!opts.fresh && !opts.env && toolCache && Date.now() - toolCache.at < TOOL_CACHE_MS) return toolCache.tools
  const env = opts.env || process.env
  const sevenName = SEVEN_ZIP.find((name) => which(name, env)) || ''
  const tools = {
    sevenZip: sevenName ? which(sevenName, env) : '',
    bsdtar: which('bsdtar', env),
    tar: which('tar', env),
    zip: which('zip', env),
    unzip: which('unzip', env),
    gnuTar: false
  }
  tools.gnuTar = Boolean(tools.tar) && isGnuTar(tools.tar)
  if (!opts.env) toolCache = { at: Date.now(), tools }
  return tools
}

/** GNU tar 才有 `--quoting-style`（BusyBox／bsdtar 冒充的 tar 沒有） */
function isGnuTar(exe) {
  try {
    return /GNU tar/.test(execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return false
  }
}

/** GNU tar 預設會把非 ASCII／反斜線檔名跳脫成 `\345…`，清單與 -v 輸出要原樣 */
function tarQuoting(toolKey, tools) {
  return toolKey === 'tar' && tools.gnuTar ? ['--quoting-style=literal'] : []
}

/** @param {string} name @returns {string} 壓縮檔種類；不是壓縮檔回空字串 */
function archiveKind(name) {
  const hit = KIND_BY_EXT.find(([re]) => re.test(String(name)))
  return hit ? hit[1] : ''
}

/** 去掉壓縮檔副檔名（`a.tar.gz` → `a`） */
function stripArchiveExt(name) {
  const hit = KIND_BY_EXT.find(([re]) => re.test(String(name)))
  return hit ? String(name).replace(hit[0], '') || String(name) : String(name)
}

/** 壓縮成某格式要用哪支工具；沒有回空字串 */
function compressTool(format, tools) {
  if (format === 'zip') return tools.sevenZip ? 'sevenZip' : tools.zip ? 'zip' : tools.bsdtar ? 'bsdtar' : ''
  if (format === '7z') return tools.sevenZip ? 'sevenZip' : tools.bsdtar ? 'bsdtar' : ''
  if (format === 'tar.gz') return tools.tar ? 'tar' : tools.bsdtar ? 'bsdtar' : ''
  return ''
}

/** 解壓縮某種壓縮檔要用哪支工具；沒有回空字串 */
function extractTool(kind, tools) {
  if (TAR_KINDS.has(kind)) return tools.tar ? 'tar' : tools.bsdtar ? 'bsdtar' : tools.sevenZip && kind === 'tar' ? 'sevenZip' : ''
  if (kind === 'zip') return tools.sevenZip ? 'sevenZip' : tools.bsdtar ? 'bsdtar' : tools.unzip ? 'unzip' : ''
  if (kind === '7z' || kind === 'rar') return tools.sevenZip ? 'sevenZip' : tools.bsdtar ? 'bsdtar' : ''
  return ''
}

/** 缺工具時的安裝提示（只講套件名，不代裝） */
function missingHint(tools) {
  const missing = []
  if (!compressTool('7z', tools)) missing.push('7z 格式')
  if (!compressTool('zip', tools)) missing.push('ZIP 壓縮')
  if (!compressTool('tar.gz', tools)) missing.push('tar.gz')
  if (!missing.length) return ''
  return `${missing.join('、')}需要 7-Zip（7zip／p7zip-full）、zip 或 libarchive-tools（bsdtar）`
}

/**
 * 不覆寫的目的地：`名稱.zip` → `名稱 (2).zip`（複合副檔名 `.tar.gz` 保持在尾巴）。
 * @param {string} dir @param {string} stem @param {string} ext 含點，可為空
 */
function uniquePath(dir, stem, ext) {
  for (let n = 1; n < 10000; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`
    const full = path.join(dir, name)
    try { fs.lstatSync(full) } catch { return full }
  }
  const error = new Error('exists')
  error.code = 'EXISTS'
  error.userMessage = '那裡已經有太多同名的東西了'
  throw error
}

/** 壓縮檔的檔名：單選＝去掉副檔名的名稱（資料夾就是本名），多選＝所在資料夾的名稱 */
function compressStem(sources) {
  if (sources.length === 1) {
    const base = path.basename(sources[0])
    let isDir = false
    try { isDir = fs.statSync(sources[0]).isDirectory() } catch { /* 當檔案 */ }
    const ext = isDir ? '' : path.extname(base)
    return (ext && ext !== base ? base.slice(0, -ext.length) : base) || '封存'
  }
  return path.basename(path.dirname(sources[0])) || '封存'
}

function tempName(prefix) {
  return `${prefix}${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function fail(code, userMessage) {
  const error = new Error(code)
  error.code = code
  error.userMessage = userMessage
  return error
}

/**
 * 跑一支外部工具：逐行回報輸出（7-Zip 的 `-bsp1` 用 \b／\r 覆寫同一行，也切開），可取消。
 * @param {string} exe @param {string[]} args
 * @param {{ cwd?: string, signal?: AbortSignal, onLine?: (line: string) => void, spawnFn?: typeof spawn }} opts
 * @returns {Promise<void>}
 */
function runTool(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(fail('CANCELLED', '操作已取消')); return }
    let child
    try {
      child = (opts.spawnFn || spawn)(exe, args, { cwd: opts.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } })
    } catch { reject(fail('SPAWN_FAILED', '壓縮工具無法執行')); return }
    let buf = ''
    const feed = (chunk) => {
      buf += chunk.toString('utf8')
      const parts = buf.split(/[\r\n\b]+/)
      buf = parts.pop() || ''
      for (const line of parts) if (line.trim()) opts.onLine?.(line)
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const onAbort = () => { try { child.kill('SIGTERM') } catch { /* 已結束 */ } }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => reject(fail('SPAWN_FAILED', '壓縮工具無法執行')))
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (buf.trim()) opts.onLine?.(buf)
      if (opts.signal?.aborted) reject(fail('CANCELLED', '操作已取消'))
      else if (code === 0) resolve()
      else reject(fail('ARCHIVE_FAILED', `壓縮工具失敗（結束碼 ${code}）`))
    })
  })
}

/**
 * 進度：7-Zip 給百分比；其他工具每處理一個項目印一行，用「行數／項目總數」估。
 * @param {string} toolKey @param {number} totalEntries @param {(fraction: number) => void} onFraction
 */
function progressParser(toolKey, totalEntries, onFraction) {
  let seen = 0
  return (line) => {
    if (toolKey === 'sevenZip') {
      const match = /(\d{1,3})%/.exec(line)
      if (match) onFraction(Math.min(1, Number(match[1]) / 100))
      return
    }
    if (!totalEntries) return
    if (/^(adding|updating|inflating|extracting|creating|linking):|^[ax] |^[^ ]/.test(line.trim())) {
      seen += 1
      onFraction(Math.min(0.99, seen / totalEntries))
    }
  }
}

/** 7-Zip `l -slt` 的輸出 → 項目路徑（分隔線之後的 `Path = `） */
function parseSevenList(out) {
  const body = String(out).split(/^-{10,}$/m).slice(1).join('\n')
  return [...body.matchAll(/^Path = (.+)$/gm)].map((m) => m[1])
}

/**
 * 列出壓縮檔內容（算進度、找同名衝突）。
 * @param {string} archive @param {string} toolKey @param {ReturnType<typeof detectTools>} tools
 * @returns {Promise<string[]>}
 */
async function listEntries(archive, toolKey, tools, opts = {}) {
  const lines = []
  const exe = tools[toolKey]
  const args = toolKey === 'sevenZip' ? ['l', '-slt', '--', archive]
    : toolKey === 'unzip' ? ['-Z1', archive]
      : [...tarQuoting(toolKey, tools), '-tf', archive]
  await runTool(exe, args, { ...opts, onLine: (line) => lines.push(line) })
  const names = toolKey === 'sevenZip' ? parseSevenList(lines.join('\n')) : lines
  return names.map((n) => n.replace(/^(\.\/)+/, '').replace(/^\/+/, '')).filter((n) => n && n !== '.')
}

/** 第一層名稱（同名衝突只看這一層） */
function topLevel(entries) {
  return [...new Set(entries.map((e) => e.split('/')[0]).filter((n) => n && n !== '.' && n !== '..'))]
}

/** 壓縮來源的檔案數與總大小（不跟隨符號連結）；可取消 */
async function measure(sources, signal) {
  let bytes = 0
  let count = 0
  const walk = async (full) => {
    if (signal?.aborted) throw fail('CANCELLED', '操作已取消')
    let st
    try { st = await fsp.lstat(full) } catch { return }
    count += 1
    if (st.isDirectory()) {
      let kids = []
      try { kids = await fsp.readdir(full) } catch { return }
      for (const kid of kids) await walk(path.join(full, kid))
    } else if (st.isFile()) bytes += st.size
  }
  for (const source of sources) await walk(source)
  return { bytes, count }
}

function compressArgs(toolKey, format, partial, names, tools = {}) {
  const rel = names.map((n) => `./${n}`)
  if (toolKey === 'sevenZip') return ['a', `-t${format}`, '-bsp1', '-bso0', '-snl', '-y', partial, '--', ...names]
  if (toolKey === 'zip') return ['-r', '-y', partial, ...rel]
  if (toolKey === 'bsdtar') {
    const fmt = format === 'zip' ? ['--format', 'zip'] : format === '7z' ? ['--format', '7zip'] : ['-z']
    return ['-c', '-v', ...fmt, '-f', partial, ...rel]
  }
  return [...tarQuoting(toolKey, tools), '-czvf', partial, '--', ...names]
}

/**
 * 壓縮。全部來源要在同一個資料夾（shell-linux.js 已檢查）。
 * @param {{ sources: string[], format: string, tools?: object, signal?: AbortSignal, onTotal?: Function, onProgress?: Function }} spec
 * @returns {Promise<{ path: string }>}
 */
async function compress(spec) {
  const tools = spec.tools || detectTools()
  const toolKey = compressTool(spec.format, tools)
  if (!toolKey) throw fail('UNSUPPORTED', '找不到能壓縮成這個格式的工具')
  const dir = path.dirname(spec.sources[0])
  const names = spec.sources.map((s) => path.basename(s))
  const { bytes, count } = await measure(spec.sources, spec.signal)
  spec.onTotal?.(bytes)
  const ext = `.${spec.format}`
  const partial = path.join(dir, `${tempName('.axd-partial-')}${ext}`)
  const parse = progressParser(toolKey, count, (f) => spec.onProgress?.(Math.round(bytes * f)))
  try {
    await runTool(tools[toolKey], compressArgs(toolKey, spec.format, partial, names, tools), { cwd: dir, signal: spec.signal, onLine: parse })
    const dest = uniquePath(dir, compressStem(spec.sources), ext)
    await fsp.rename(partial, dest)
    spec.onProgress?.(bytes)
    return { path: dest }
  } catch (error) {
    await fsp.rm(partial, { force: true }).catch(() => {})
    throw error
  }
}

function extractArgs(toolKey, archive, staging, tools = {}) {
  if (toolKey === 'sevenZip') return ['x', '-bsp1', '-bso0', '-y', `-o${staging}`, '--', archive]
  if (toolKey === 'unzip') return ['-o', archive, '-d', staging]
  return [...tarQuoting(toolKey, tools), '-x', '-v', '-f', archive, '-C', staging]
}

async function removeStaging(staging) {
  // 只會是我們自己剛建的 `.axd-extract-*`；用 safe-rm 的同步版（不穿過符號連結）
  try { require('../safe-rm').removeTreeSync(staging) } catch { /* 下次再清 */ }
}

/**
 * 預先檢查：要用哪支工具、第一層有哪些名稱、跟目的地衝突的有哪些。
 * @param {string} archive @param {string} destDir
 */
async function planExtract(archive, destDir, opts = {}) {
  const tools = opts.tools || detectTools()
  const kind = archiveKind(archive)
  const toolKey = extractTool(kind, tools)
  if (!toolKey) throw fail('UNSUPPORTED', '找不到能解開這種壓縮檔的工具')
  const entries = await listEntries(archive, toolKey, tools, { signal: opts.signal })
  const top = topLevel(entries)
  const conflicts = top.filter((name) => { try { fs.lstatSync(path.join(destDir, name)); return true } catch { return false } })
  return { tools, toolKey, entries: entries.length, top, conflicts }
}

/**
 * 解壓縮。`mode: 'here'` 解到壓縮檔所在資料夾：同名項目只有列在 `replace`（使用者已確認）裡的才會
 * 把舊的丟進回收筒再放新的，其他（例如確認之後才冒出來的）一律改成 `名稱 (2)`，**不覆寫**。
 * `mode: 'folder'` 解到新的 `名稱/`（同名變 `名稱 (2)/`；壓縮檔只有一個同名資料夾時不重複包一層）。
 * @param {{ archive: string, mode: 'here'|'folder', replace?: string[], plan?: object, signal?: AbortSignal,
 *   onTotal?: Function, onProgress?: Function, trash?: (full: string) => Promise<void> }} spec
 * @returns {Promise<{ path: string, items: string[] }>}
 */
async function extract(spec) {
  const dir = path.dirname(spec.archive)
  const plan = spec.plan || await planExtract(spec.archive, dir, { signal: spec.signal })
  const size = (await fsp.stat(spec.archive)).size
  spec.onTotal?.(size)
  const staging = path.join(dir, tempName('.axd-extract-'))
  await fsp.mkdir(staging)
  const parse = progressParser(plan.toolKey, plan.entries, (f) => spec.onProgress?.(Math.round(size * f)))
  try {
    await runTool(plan.tools[plan.toolKey], extractArgs(plan.toolKey, spec.archive, staging, plan.tools), { cwd: staging, signal: spec.signal, onLine: parse })
    if (spec.signal?.aborted) throw fail('CANCELLED', '操作已取消')
    const placed = spec.mode === 'here' ? await placeHere(staging, dir, spec) : await placeFolder(staging, dir, spec.archive)
    spec.onProgress?.(size)
    return placed
  } finally {
    if (fs.existsSync(staging)) await removeStaging(staging)
  }
}

async function placeHere(staging, dir, spec) {
  const items = []
  const replace = new Set(Array.isArray(spec.replace) ? spec.replace : [])
  const trash = spec.trash || ((full) => require('./recycle').trash(full))
  for (const name of await fsp.readdir(staging)) {
    let dest = path.join(dir, name)
    let exists = false
    try { await fsp.lstat(dest); exists = true } catch { /* 沒有 */ }
    if (exists && replace.has(name)) {
      require('./paths').assertMutable(dest)
      await trash(dest)
    }
    else if (exists) {
      const ext = path.extname(name)
      dest = uniquePath(dir, ext && ext !== name ? name.slice(0, -ext.length) : name, ext && ext !== name ? ext : '')
    }
    await fsp.rename(path.join(staging, name), dest)
    items.push(dest)
  }
  return { path: dir, items }
}

async function placeFolder(staging, dir, archive) {
  const stem = stripArchiveExt(path.basename(archive)) || '解壓縮'
  const dest = uniquePath(dir, stem, '')
  const kids = await fsp.readdir(staging)
  if (kids.length === 1 && kids[0] === stem) {
    const only = path.join(staging, kids[0])
    if ((await fsp.lstat(only)).isDirectory()) {
      await fsp.rename(only, dest)
      return { path: dest, items: [dest] }
    }
  }
  await fsp.rename(staging, dest)
  return { path: dest, items: [dest] }
}

module.exports = {
  FORMATS,
  which,
  detectTools,
  archiveKind,
  stripArchiveExt,
  compressTool,
  extractTool,
  missingHint,
  uniquePath,
  compressStem,
  listEntries,
  topLevel,
  progressParser,
  parseSevenList,
  planExtract,
  compress,
  extract
}
