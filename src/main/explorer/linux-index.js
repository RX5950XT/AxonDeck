'use strict'

/**
 * AxonDeck — Linux 整機檔名索引（UFFS 的 Linux 替身，系統沒有可用的 plocate／locate 時才用）。
 *
 * 只記「哪個資料夾裡有哪些名字」，大小／時間在查詢時才 stat 命中的那幾筆（跟 UFFS 一樣不存內容）。
 *
 * 增量更新靠**資料夾 mtime**：新增／刪除／改名都會改到所在資料夾的 mtime，
 * 所以重掃只要 stat 每個已知資料夾、mtime 變了的才重新 readdir。常用資料夾另外掛 inotify
 * （fs.watch，非遞迴）讓剛下載的檔案幾秒內就搜得到。
 *
 * 查詢：所有名字小寫後用 \0 串成一條字串，子字串比對＝一次 indexOf 掃過去（\0 不會出現在檔名裡），
 * 再用二分搜尋把位置換回是哪一筆。萬級到百萬級都是毫秒級。
 *
 * 全程 fs.promises＋定期 setImmediate 讓出主執行緒；不跟 symlink、不跨檔案系統、不進排除清單。
 */

const path = require('path')
const zlib = require('zlib')
const { promisify } = require('util')
const rawFs = require('../raw-fs')

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

const FORMAT = 'AXIDX1'
const MAX_ENTRIES = 3_000_000
const MAX_DEPTH = 40
const YIELD_EVERY = 256
/** 不遞迴進去（名字本身仍可搜） */
const SKIP_DESCEND = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.cache', '.npm', '.yarn',
  '.pnpm-store', '.turbo', '.next', '.gradle', '.m2', '.cargo', '.rustup', 'target-cache',
  'Trash', '.Trash', '.Trash-1000', 'lost+found', '.venv', 'venv', '.tox'
])
/** 整棵不碰的絕對路徑（虛擬檔案系統、執行期狀態） */
const EXCLUDE_ROOTS = ['/proc', '/sys', '/dev', '/run/user', '/run/lock', '/tmp', '/var/tmp', '/snap']

function under(full, root) {
  return full === root || full.startsWith(root === '/' ? '/' : `${root}/`)
}

/**
 * @param {string} full
 * @param {string} [walkRoot] 這次索引的根；根自己就在排除區裡（例如測試放在 /tmp）時不套用該條
 */
function isExcluded(full, walkRoot = '') {
  if (full.startsWith('/run/') && !full.startsWith('/run/media/') && !(walkRoot && under(walkRoot, '/run'))) return true
  return EXCLUDE_ROOTS.some((root) => under(full, root) && !(walkRoot && under(walkRoot, root)))
}

/** 隱藏資料夾不往下走（~/.config、~/.local…動輒數萬筆設定檔）；名字本身照樣索引 */
function shouldDescend(name) {
  return !SKIP_DESCEND.has(name) && !name.startsWith('.')
}

function escapeName(name) {
  return name.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

function unescapeName(text) {
  return text.replace(/\\(\\|t|n|r)/g, (_, c) => ({ '\\': '\\', t: '\t', n: '\n', r: '\r' })[c])
}

/**
 * @param {{ fsp?: any, now?: () => number, maxEntries?: number, yieldEvery?: number }} [deps]
 */
function createFileIndex(deps = {}) {
  const fsp = deps.fsp || rawFs.promises
  const now = deps.now || Date.now
  const maxEntries = Number(deps.maxEntries) > 0 ? Number(deps.maxEntries) : MAX_ENTRIES
  const yieldEvery = Number(deps.yieldEvery) > 0 ? Number(deps.yieldEvery) : YIELD_EVERY

  /** dir → { m: mtimeMs, f: 檔名[], d: 有往下走的子資料夾名[], x: 沒往下走的子資料夾名[] } */
  let dirs = new Map()
  let roots = []
  let records = 0
  let truncated = false
  let flat = null
  let sinceYield = 0
  let generation = 0

  async function pause() {
    sinceYield += 1
    if (sinceYield >= yieldEvery) {
      sinceYield = 0
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** 讀一層。回傳要繼續往下走的子資料夾（同一顆檔案系統、不在排除清單） */
  async function scanDir(dir, rootDev, walkRoot) {
    let st
    let entries
    try {
      st = await fsp.stat(dir)
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    const node = { m: Number(st.mtimeMs) || 0, f: [], d: [], x: [] }
    for (const ent of entries) {
      const name = ent.name
      if (!name || name.includes('\0')) continue
      if (ent.isDirectory()) {
        const full = dir === '/' ? `/${name}` : `${dir}/${name}`
        if (shouldDescend(name) && !isExcluded(full, walkRoot)) node.d.push(name)
        else node.x.push(name)
      } else {
        node.f.push(name)
      }
    }
    // 跨到另一顆檔案系統（掛載點）就只留名字；那一顆若該索引，會是自己的 root
    if (rootDev !== undefined && st.dev !== rootDev) {
      return { node: { m: node.m, f: [], d: [], x: [] }, dev: st.dev, foreign: true }
    }
    return { node, dev: st.dev, foreign: false }
  }

  function countOf(node) {
    return node.f.length + node.d.length + node.x.length
  }

  function put(dir, node) {
    const old = dirs.get(dir)
    if (old) records -= countOf(old)
    dirs.set(dir, node)
    records += countOf(node)
    flat = null
  }

  /** 從 start 往下走；isCancelled 為真就停（結果保留走到的部分） */
  async function walk(start, rootDev, isCancelled, onProgress, depth0 = 0) {
    const walkRoot = rootOf(start) || start
    const queue = [{ dir: start, depth: depth0 }]
    while (queue.length) {
      if (isCancelled()) return false
      if (records >= maxEntries) { truncated = true; return true }
      const { dir, depth } = queue.shift()
      const res = await scanDir(dir, rootDev, walkRoot)
      if (!res) continue
      if (res.foreign && dir !== start) {
        // 掛載點：父層已經記了名字，這裡不展開
        continue
      }
      put(dir, res.node)
      if (depth < MAX_DEPTH) {
        for (const name of res.node.d) queue.push({ dir: dir === '/' ? `/${name}` : `${dir}/${name}`, depth: depth + 1 })
      }
      if (onProgress && dirs.size % 500 === 0) onProgress({ records, dirs: dirs.size })
      await pause()
    }
    return true
  }

  async function build(rootList, opts = {}) {
    const isCancelled = opts.isCancelled || (() => false)
    generation += 1
    dirs = new Map()
    records = 0
    truncated = false
    flat = null
    roots = rootList.slice()
    for (const root of roots) {
      let dev
      try { dev = (await fsp.stat(root)).dev } catch { continue }
      const done = await walk(root, dev, isCancelled, opts.onProgress)
      if (!done) return false
    }
    return true
  }

  function removeSubtree(dir) {
    const prefix = dir === '/' ? '/' : `${dir}/`
    for (const key of [...dirs.keys()]) {
      if (key === dir || key.startsWith(prefix)) {
        records -= countOf(dirs.get(key))
        dirs.delete(key)
      }
    }
    flat = null
  }

  function rootOf(dir) {
    let best = ''
    for (const root of roots) {
      if (under(dir, root) && root.length > best.length) best = root
    }
    return best
  }

  function rootDevOf(dir, devs) {
    return devs.get(rootOf(dir))
  }

  /**
   * 重掃一個已知資料夾：mtime 沒變就跳過（force 除外）。新出現的子資料夾整棵走一遍、消失的整棵拿掉。
   * @returns {Promise<boolean>} 有沒有變動
   */
  async function rescanDir(dir, devs, force = false) {
    const old = dirs.get(dir)
    if (!old) return false
    let st
    try {
      st = await fsp.stat(dir)
    } catch {
      removeSubtree(dir)
      return true
    }
    if (!force && Number(st.mtimeMs) === old.m) return false
    const res = await scanDir(dir, rootDevOf(dir, devs), rootOf(dir))
    if (!res) { removeSubtree(dir); return true }
    const before = new Set(old.d)
    const after = new Set(res.node.d)
    for (const name of before) if (!after.has(name)) removeSubtree(`${dir === '/' ? '' : dir}/${name}`)
    put(dir, res.node)
    for (const name of after) {
      if (before.has(name)) continue
      await walk(`${dir === '/' ? '' : dir}/${name}`, rootDevOf(dir, devs), () => false, null, 1)
    }
    return true
  }

  async function rootDevs() {
    const devs = new Map()
    for (const root of roots) {
      try { devs.set(root, (await fsp.stat(root)).dev) } catch { /* 掛載點拔掉了 */ }
    }
    return devs
  }

  /** mtime 增量重掃整份；回傳變動的資料夾數 */
  async function refresh(opts = {}) {
    const isCancelled = opts.isCancelled || (() => false)
    const devs = await rootDevs()
    let changed = 0
    for (const dir of [...dirs.keys()]) {
      if (isCancelled()) break
      if (!dirs.has(dir)) continue
      if (await rescanDir(dir, devs)) changed += 1
      await pause()
    }
    return changed
  }

  /** 單一資料夾（inotify 通知的那個） */
  async function touch(dir) {
    return rescanDir(dir, await rootDevs(), true)
  }

  function flatten() {
    if (flat) return flat
    const names = []
    const owner = []
    const isDir = []
    const dirList = []
    for (const [dir, node] of dirs) {
      const di = dirList.push(dir) - 1
      for (const n of node.f) { names.push(n); owner.push(di); isDir.push(0) }
      for (const n of node.d) { names.push(n); owner.push(di); isDir.push(1) }
      for (const n of node.x) { names.push(n); owner.push(di); isDir.push(1) }
    }
    const starts = new Int32Array(names.length)
    let pos = 1
    for (let i = 0; i < names.length; i += 1) {
      starts[i] = pos
      pos += names[i].length + 1
    }
    flat = {
      names, isDir: Uint8Array.from(isDir), owner: Int32Array.from(owner), dirList, starts,
      blob: `\0${names.join('\0').toLowerCase()}\0`
    }
    // toLowerCase 可能改變長度（少數 Unicode）；長度不符就退回逐筆比對
    if (flat.blob.length !== pos) flat.blob = ''
    return flat
  }

  function entryAt(f, i) {
    const dir = f.dirList[f.owner[i]]
    return { name: f.names[i], path: dir === '/' ? `/${f.names[i]}` : `${dir}/${f.names[i]}`, dir: f.isDir[i] === 1 }
  }

  function findEntry(starts, offset) {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /**
   * @param {(name: string) => boolean} match 給 glob 用；子字串走快路徑
   * @param {{ needle?: string, limit: number, accept?: (e: object) => boolean }} opts
   */
  function query(match, opts) {
    const f = flatten()
    const out = []
    const accept = opts.accept || (() => true)
    const needle = String(opts.needle || '').toLowerCase()
    if (needle && f.blob && !needle.includes('\0')) {
      let from = 0
      while (out.length < opts.limit) {
        const at = f.blob.indexOf(needle, from)
        if (at < 0) break
        const i = findEntry(f.starts, at)
        const e = entryAt(f, i)
        if (accept(e)) out.push(e)
        from = f.starts[i] + f.names[i].length + 1
      }
      return out
    }
    for (let i = 0; i < f.names.length && out.length < opts.limit; i += 1) {
      if (!match(f.names[i])) continue
      const e = entryAt(f, i)
      if (accept(e)) out.push(e)
    }
    return out
  }

  async function save(file, meta = {}) {
    const lines = [`${FORMAT}\t${now()}\t${JSON.stringify({ roots, truncated, ...meta })}`]
    for (const [dir, node] of dirs) {
      lines.push(`D\t${node.m}\t${escapeName(dir)}`)
      for (const n of node.f) lines.push(`f\t${escapeName(n)}`)
      for (const n of node.d) lines.push(`d\t${escapeName(n)}`)
      for (const n of node.x) lines.push(`x\t${escapeName(n)}`)
    }
    const data = await gzip(Buffer.from(lines.join('\n'), 'utf8'))
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, data)
    await fsp.rename(tmp, file)
    return data.length
  }

  /** @returns {Promise<{ savedAt: number, meta: object } | null>} 檔案不在／格式不符回 null */
  async function load(file) {
    let text
    try {
      text = (await gunzip(await fsp.readFile(file))).toString('utf8')
    } catch {
      return null
    }
    const lines = text.split('\n')
    const head = lines[0].split('\t')
    if (head[0] !== FORMAT) return null
    let meta = {}
    try { meta = JSON.parse(head.slice(2).join('\t')) } catch { return null }
    const next = new Map()
    let count = 0
    let node = null
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const kind = line.slice(0, tab)
      if (kind === 'D') {
        const tab2 = line.indexOf('\t', tab + 1)
        node = { m: Number(line.slice(tab + 1, tab2)) || 0, f: [], d: [], x: [] }
        next.set(unescapeName(line.slice(tab2 + 1)), node)
        if (i % 2000 === 0) await new Promise((resolve) => setImmediate(resolve))
        continue
      }
      if (!node || !node[kind]) continue
      node[kind].push(unescapeName(line.slice(tab + 1)))
      count += 1
    }
    dirs = next
    records = count
    roots = Array.isArray(meta.roots) ? meta.roots.filter((r) => typeof r === 'string') : []
    truncated = meta.truncated === true
    flat = null
    return { savedAt: Number(head[1]) || 0, meta }
  }

  return {
    build, refresh, touch, query, save, load,
    stats: () => ({ records, dirs: dirs.size, roots: roots.slice(), truncated }),
    hasDir: (dir) => dirs.has(dir),
    roots: () => roots.slice(),
    clear() { dirs = new Map(); records = 0; flat = null; roots = [] },
    generation: () => generation
  }
}

module.exports = { createFileIndex, isExcluded, shouldDescend, escapeName, unescapeName, SKIP_DESCEND, EXCLUDE_ROOTS, MAX_ENTRIES }
