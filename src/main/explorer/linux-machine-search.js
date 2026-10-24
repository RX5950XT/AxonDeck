'use strict'

/**
 * AxonDeck — Linux 整機檔名搜尋服務（接在 UFFS 同一條 UI 路徑上：uffs.status／search／ensureReady）。
 *
 * 後端二選一：
 *   1. plocate／locate：裝了而且資料庫新鮮（36 小時內）就直接用（見 linux-locate.js）
 *   2. App 自建索引：$HOME＋外接／掛載的本機磁碟，存在 <userData>/linux-index/（見 linux-index.js）
 *      第一次進檔案頁才在背景建；之後開 App 先載入舊索引、再用資料夾 mtime 增量重掃，
 *      常用資料夾（家目錄、桌面、下載…）掛 inotify，幾秒內就跟上。
 *
 * 索引還沒建好時，搜尋先退回「目前資料夾樹」掃描（原本的 linux-search.js），不讓使用者空等。
 */

const os = require('os')
const path = require('path')
const rawFs = require('../raw-fs')
const { createFileIndex } = require('./linux-index')
const { probeLocate, runLocate } = require('./linux-locate')
const linuxSearch = require('./linux-search')
const { sanitizeSearchFilters, matchesSearchFilters } = require('./search-filter')
const { rankHits } = require('./rank')
const { fail } = require('./paths')

const SEARCH_LIMIT = 200
const SCAN_LIMIT = 2000
const REFRESH_MS = 15 * 60 * 1000
/** 搜尋時若距上次重掃超過這麼久，背景補一輪（不等它） */
const STALE_ON_QUERY_MS = 2 * 60 * 1000
const WATCH_DEBOUNCE_MS = 1500
const STAT_CONCURRENCY = 32
const NETWORK_FS = /^(nfs\d?|cifs|smb3?|smbfs|sshfs|fuse\.sshfs|fuse\.rclone|davfs|fuse\.davfs2|9p|afs|ceph|glusterfs|fuse\.gvfsd-fuse|fuse\.s3fs)$/
const INDEX_FILE = 'index-v1.gz'
/** locate 資料庫偶爾含虛擬檔案系統（PRUNEFS 沒設好）；這幾棵一律丟掉 */
const LOCATE_EXCLUDE = /^\/(proc|sys|dev)(\/|$)|^\/run\/(?!media\/)/

function sanitizePattern(raw) {
  if (typeof raw !== 'string') throw fail('BAD_QUERY', '搜尋條件不合法')
  const pattern = raw.trim()
  if (!pattern || pattern.length > 200 || pattern.includes('\0') || pattern.startsWith('-') || pattern.startsWith('>')) {
    throw fail('BAD_QUERY', '搜尋條件不合法')
  }
  return pattern
}

/** 預設索引範圍：家目錄＋/mnt、/media、/run/media 底下的本機掛載（網路磁碟不掃，NAS 睡著會卡） */
function defaultRoots(deps = {}) {
  const home = deps.home || os.homedir()
  const mounts = deps.mounts || require('../platform').linux.readMounts()
  const roots = home && home.startsWith('/') ? [home] : []
  for (const m of mounts) {
    const p = m.path
    if (!p || p === '/' || NETWORK_FS.test(m.fs || '')) continue
    if (!/^\/(mnt|media|run\/media)\//.test(p) && !(String(m.source || '').startsWith('/dev/') && p !== '/home' && !p.startsWith('/boot'))) continue
    // 家目錄的祖先（例如 /home 獨立掛載）不整顆掃：別人的家目錄讀不到也不該讀
    if (home && (home === p || home.startsWith(`${p}/`))) continue
    if (roots.some((r) => p === r || p.startsWith(`${r}/`))) continue
    roots.push(p)
  }
  return roots
}

/** 常用資料夾（inotify 即時跟上）：家目錄本身＋XDG 桌面／下載／文件／圖片／音樂／影片 */
function hotDirs(home) {
  if (!home) return []
  let xdg = {}
  try { xdg = require('./drives').readXdgUserDirs(home) } catch { xdg = {} }
  const list = [home]
  for (const id of ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos']) {
    const fallback = { desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures', music: 'Music', videos: 'Videos' }[id]
    list.push(xdg[id] || path.join(home, fallback))
  }
  return [...new Set(list)]
}

function createMachineSearch(deps = {}) {
  const fsp = deps.fsp || rawFs.promises
  const watchFn = deps.watch || rawFs.watch
  const now = deps.now || Date.now
  const index = deps.index || createFileIndex({ fsp, now })
  const probe = deps.probeLocate || probeLocate
  const locate = deps.runLocate || runLocate
  const rootsFn = deps.roots || (() => defaultRoots())
  const home = deps.home ?? os.homedir()
  const refreshMs = Number(deps.refreshMs) > 0 ? Number(deps.refreshMs) : REFRESH_MS

  let dataDir = ''
  let locateInfo = null
  let locateCheckedAt = 0
  /** 'idle' | 'loading' | 'building' | 'ready' */
  let phase = 'idle'
  let builtAt = 0
  let refreshedAt = 0
  let buildMs = 0
  let job = null
  let refreshJob = null
  let refreshTimer = null
  let stopped = false
  let saveTimer = null
  const watchers = new Map()
  const pendingTouch = new Map()
  let progress = null

  function indexFile() {
    return dataDir ? path.join(dataDir, 'linux-index', INDEX_FILE) : ''
  }

  async function backend() {
    if (!locateInfo || now() - locateCheckedAt > 10 * 60 * 1000) {
      locateInfo = await probe().catch(() => ({ available: false, fresh: false }))
      locateCheckedAt = now()
    }
    return locateInfo.available && locateInfo.fresh ? 'locate' : 'index'
  }

  function scheduleSave() {
    if (!indexFile() || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      index.save(indexFile(), { builtAt, buildMs }).catch(() => undefined)
    }, 5000)
    saveTimer.unref?.()
  }

  async function runBuild(onProgress) {
    phase = 'building'
    const started = now()
    const roots = rootsFn()
    progress = { records: 0, dirs: 0 }
    const done = await index.build(roots, {
      isCancelled: () => stopped,
      onProgress: (p) => { progress = p; onProgress?.({ kind: 'index', ...p }) }
    })
    if (!done) { phase = 'idle'; return }
    buildMs = now() - started
    builtAt = now()
    refreshedAt = builtAt
    phase = 'ready'
    progress = null
    if (indexFile()) await index.save(indexFile(), { builtAt, buildMs }).catch(() => undefined)
  }

  /** 先試著載入上次的索引（秒開），載不到才整份重建 */
  async function start(onProgress) {
    phase = 'loading'
    const loaded = indexFile() ? await index.load(indexFile()) : null
    const wanted = rootsFn()
    const same = loaded && JSON.stringify(index.roots()) === JSON.stringify(wanted)
    if (same) {
      builtAt = Number(loaded.meta.builtAt) || loaded.savedAt
      buildMs = Number(loaded.meta.buildMs) || 0
      phase = 'ready'
      void refresh()
    } else {
      await runBuild(onProgress)
    }
    if (phase === 'ready' && !stopped) {
      armWatchers()
      armRefreshTimer()
    }
    onProgress?.({ kind: 'index', done: true, status: await status() })
  }

  async function refresh() {
    if (refreshJob || phase !== 'ready') return refreshJob
    refreshJob = (async () => {
      const changed = await index.refresh({ isCancelled: () => stopped })
      refreshedAt = now()
      if (changed) scheduleSave()
      return changed
    })().finally(() => { refreshJob = null })
    return refreshJob
  }

  function armRefreshTimer() {
    if (refreshTimer) return
    refreshTimer = setInterval(() => { void refresh() }, refreshMs)
    refreshTimer.unref?.()
  }

  function armWatchers() {
    for (const dir of hotDirs(home)) {
      if (watchers.has(dir) || !index.hasDir(dir)) continue
      try {
        const w = watchFn(dir, { persistent: false }, () => onHotChange(dir))
        w.on?.('error', () => { try { w.close() } catch { /* 已關 */ } watchers.delete(dir) })
        watchers.set(dir, w)
      } catch { /* inotify 額度用完：退回定期重掃 */ }
    }
  }

  function onHotChange(dir) {
    if (pendingTouch.has(dir)) return
    const t = setTimeout(() => {
      pendingTouch.delete(dir)
      if (stopped || phase !== 'ready') return
      index.touch(dir).then((changed) => { if (changed) scheduleSave() }).catch(() => undefined)
    }, WATCH_DEBOUNCE_MS)
    t.unref?.()
    pendingTouch.set(dir, t)
  }

  /** 進檔案頁時呼叫：locate 可用就什麼都不做；否則背景載入／建索引（不 await） */
  async function ensure(opts = {}) {
    stopped = false
    if (await backend() === 'locate') return status()
    if (!job && phase === 'idle') {
      job = start(opts.onProgress).catch(() => { phase = 'idle' }).finally(() => { job = null })
    }
    return status()
  }

  async function status() {
    const kind = await backend()
    const st = index.stats()
    if (kind === 'locate') {
      const age = Math.max(0, Math.round((now() - locateInfo.dbMtimeMs) / 3_600_000))
      return {
        installed: true, version: locateInfo.name, mode: 'index', backend: 'locate',
        daemon: { running: true, warming: false, drives: 0, records: 0 },
        broker: { present: false, installed: false },
        message: `整機搜尋（${locateInfo.name}，資料庫 ${age} 小時前更新）`
      }
    }
    const warming = phase === 'loading' || phase === 'building'
    const staleLocate = locateInfo?.available && !locateInfo.fresh
    const count = (warming ? progress?.records : st.records) || 0
    let message
    if (phase === 'ready') message = `整機搜尋就緒 · ${st.records.toLocaleString('zh-TW')} 筆`
    else if (warming) message = `索引建置中 · ${count.toLocaleString('zh-TW')} 筆（期間先搜目前資料夾樹）`
    else message = '整機搜尋（進檔案頁後建立索引）'
    if (staleLocate) message += `；${locateInfo.name} 資料庫已過期，改用 App 自建索引`
    if (st.truncated) message += '；已達索引上限'
    return {
      installed: true, version: 'axondeck-index', mode: 'index', backend: 'index',
      daemon: { running: phase === 'ready', warming, drives: st.roots.length, records: st.records },
      broker: { present: false, installed: false },
      roots: st.roots, builtAt, refreshedAt, buildMs, message
    }
  }

  /** 命中補 stat（大小／時間／確認還在），固定併發 */
  async function enrich(entries, filters, isCancelled) {
    const hits = []
    let i = 0
    async function worker() {
      while (i < entries.length && hits.length < SEARCH_LIMIT) {
        if (isCancelled()) return
        const e = entries[i++]
        let st
        try { st = await fsp.stat(e.path) } catch { continue }
        const dir = st.isDirectory()
        const hit = { name: e.name, path: e.path, dir, size: dir ? 0 : Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0, ext: dir ? '' : path.extname(e.name).slice(1).toLowerCase() }
        if (matchesSearchFilters(hit, filters)) hits.push(hit)
      }
    }
    await Promise.all(Array.from({ length: STAT_CONCURRENCY }, worker))
    return hits.slice(0, SEARCH_LIMIT)
  }

  async function search(raw, rawFilters, opts = {}) {
    const pattern = sanitizePattern(raw)
    const filters = sanitizeSearchFilters(rawFilters)
    const isCancelled = opts.isCancelled || (() => false)
    const kind = await backend()
    let entries
    if (kind === 'locate') {
      const paths = await locate(locateInfo.bin, pattern, { limit: SCAN_LIMIT }).catch(() => null)
      if (!paths) throw fail('UFFS_FAILED', '搜尋失敗')
      entries = paths.filter((p) => !LOCATE_EXCLUDE.test(p))
        .map((p) => ({ name: path.basename(p), path: p, dir: false }))
    } else if (phase !== 'ready') {
      // 索引還在建：有目前資料夾就先掃那棵樹，跟原本的資料夾樹搜尋一樣
      if (opts.autoBuild !== false) void ensure({})
      if (filters.root) {
        const res = await linuxSearch.searchLocal(raw, rawFilters, { isCancelled })
        return { ...res, warming: false, partial: true }
      }
      return { hits: [], truncated: false, warming: true, filters }
    } else {
      if (now() - refreshedAt > STALE_ON_QUERY_MS) void refresh()
      const match = linuxSearch.compileMatcher(pattern)
      const glob = /[*?]/.test(pattern)
      const location = filters.location
      entries = index.query(match, {
        needle: glob ? '' : pattern,
        limit: SCAN_LIMIT,
        accept: location ? (e) => e.path === location || e.path.startsWith(`${location}/`) : undefined
      })
    }
    if (isCancelled()) return { hits: [], truncated: false, warming: false, cancelled: true, filters }
    const hits = await enrich(entries, filters, isCancelled)
    if (isCancelled()) return { hits: [], truncated: false, warming: false, cancelled: true, filters }
    return {
      hits: rankHits(pattern, hits),
      truncated: entries.length >= SCAN_LIMIT || hits.length >= SEARCH_LIMIT,
      warming: false,
      filters
    }
  }

  async function stop() {
    stopped = true
    for (const w of watchers.values()) { try { w.close() } catch { /* 已關 */ } }
    watchers.clear()
    for (const t of pendingTouch.values()) clearTimeout(t)
    pendingTouch.clear()
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      if (indexFile() && phase === 'ready') await index.save(indexFile(), { builtAt, buildMs }).catch(() => undefined)
    }
    await job?.catch?.(() => undefined)
    await refreshJob?.catch?.(() => undefined)
  }

  return {
    configure(dir) { dataDir = typeof dir === 'string' ? dir : '' },
    ensure, status, search, refresh, stop,
    _index: index,
    _phase: () => phase,
    _job: () => job
  }
}

let singleton = null
function machineSearch() {
  if (!singleton) singleton = createMachineSearch()
  return singleton
}

module.exports = { createMachineSearch, machineSearch, defaultRoots, hotDirs, sanitizePattern, NETWORK_FS }
