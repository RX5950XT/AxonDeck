'use strict'

/**
 * Linux 手機（MTP）／相機（PTP）：跟 Windows 版用同一套 `mtp:裝置\儲存空間\…` 虛擬路徑，
 * renderer 的手機流程（瀏覽、開檔預覽、複製出來／貼進去、永久刪除確認、唯讀）一行都不用改。
 *
 * 底層傳輸見 mtp-linux-transport.js：優先 gvfs（gio），沒有就 jmtpfs／simple-mtpfs（FUSE）。
 * gio copy／remove 不會遞迴，所以資料夾的複製與刪除在這裡自己一層層做。
 *
 * 跟 Windows 一樣：不做改名、新增資料夾；刪除＝永久（手機沒有回收筒，renderer 先問過）。
 * 跟 Windows 不同：沒有系統的進度／取消視窗（Windows 那個是 IFileOperation 自己畫的）。
 */

const path = require('path')
const crypto = require('crypto')
const fsp = require('../raw-fs').promises
const transportLib = require('./mtp-linux-transport')

const MAX_LISTINGS = 8
/** 一次操作最多碰幾個項目、往下幾層（手機相簿資料夾動輒上萬張，給個上限避免無止盡） */
const MAX_ITEMS = 20000
const MAX_DEPTH = 32

const HINT_NO_TOOLS = '讀取手機需要 gvfs 的 MTP 支援：Debian／Ubuntu 請安裝 gvfs-backends（Fedora／Arch：gvfs-mtp），'
  + '或安裝 jmtpfs／simple-mtpfs。裝好後重新進入「本機」。'
const HINT_NO_GVFS_MTP = '系統有 gio 但沒有 gvfs 的 MTP 後端：Debian／Ubuntu 請安裝 gvfs-backends（Fedora／Arch：gvfs-mtp）。'
const HINT_NO_DEVICE = '沒有偵測到手機：請用 USB 連接並解鎖，在手機通知列把 USB 用途改成「檔案傳輸」。'
const HINT_FUSE = '使用 {tool} 掛載手機（沒有 gvfs MTP 後端）。'

/**
 * @param {{ parse: Function, PREFIX: string, fail: Function, files: any, zipTempRoot: () => string,
 *   mediaOpen: (file: string) => Promise<string>, transport?: any, detect?: () => any, resolveExisting?: Function }} deps
 */
function createLinuxMtp(deps) {
  const { parse, PREFIX, fail, files } = deps
  const detected = () => (deps.detect || transportLib.detect)()
  let transport = deps.transport || null
  /** 小寫裝置名稱 → { name, root, mounted, type, arg? } */
  let devices = new Map()
  const listings = new Map()

  function tx() {
    if (transport) return transport
    const info = detected()
    if (info.kind === 'gio') transport = transportLib.createGioTransport()
    else if (info.kind === 'fuse') transport = transportLib.createFuseTransport()
    return transport
  }

  function failure(err) {
    const kind = err && err.kind
    if (kind === 'TIMEOUT') return fail('TIMEOUT', '手機回應太慢')
    if (kind === 'NOT_FOUND') return fail('NOT_FOUND', '手機裡找不到這個檔案')
    if (kind === 'DENIED') return fail('MTP_FAILED', '手機拒絕存取：請解鎖手機，並確認 USB 用途是「檔案傳輸」')
    if (kind === 'MOUNT') return fail('MTP_FAILED', '連不上手機：請解鎖，並在通知列把 USB 用途改成「檔案傳輸」')
    if (err && err.code && err.userMessage) return err
    return fail('MTP_FAILED', '讀不到手機：可能拔掉了，或還沒解鎖、USB 沒選「檔案傳輸」')
  }

  async function guard(fn) {
    try {
      return await fn()
    } catch (err) {
      throw failure(err)
    }
  }

  async function listDevices() {
    const t = tx()
    if (!t) { devices = new Map(); return [] }
    const found = await t.enumerate().catch(() => [])
    const next = new Map()
    const out = []
    for (const dev of found) {
      const base = String(dev.name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || '裝置'
      let name = base
      for (let n = 2; next.has(name.toLowerCase()); n += 1) name = `${base} (${n})`
      // 舊的那筆已掛載就沿用狀態，不重掛
      const prev = devices.get(name.toLowerCase())
      next.set(name.toLowerCase(), { ...dev, name, mounted: dev.mounted || Boolean(prev && prev.root === dev.root && prev.mounted) })
      out.push({ name, path: PREFIX + name, type: dev.type || '手機' })
    }
    devices = next
    return out
  }

  async function deviceOf(name) {
    if (!devices.has(name.toLowerCase())) await listDevices()
    const dev = devices.get(name.toLowerCase())
    if (!dev) throw fail('NOT_FOUND', '找不到這支手機：可能拔掉了，或還沒解鎖、USB 沒選「檔案傳輸」')
    await guard(() => tx().mount(dev))
    return dev
  }

  async function locOf(where) {
    const dev = await deviceOf(where.device)
    return tx().loc(dev, where.segs)
  }

  async function entriesOf(where, opts = {}) {
    const key = where.full.toLowerCase()
    if (!opts.fresh && listings.has(key)) return listings.get(key)
    const loc = await locOf(where)
    const items = await guard(() => tx().list(loc))
    const entries = items.slice(0, files.MAX_ENTRIES || 10000).map((item) => ({
      name: item.name,
      path: `${where.full}\\${item.name}`,
      dir: item.dir,
      link: false,
      size: item.dir ? 0 : item.size,
      mtimeMs: item.mtimeMs,
      ext: item.dir ? '' : path.extname(item.name).slice(1).toLowerCase(),
      hidden: item.name.startsWith('.'),
      phone: true
    }))
    listings.delete(key)
    listings.set(key, entries)
    if (listings.size > MAX_LISTINGS) listings.delete(listings.keys().next().value)
    return entries
  }

  async function list(target, rawOpts) {
    const where = parse(target)
    const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {}
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
    const all = await entriesOf(where, { fresh: offset === 0 })
    const shown = opts.showHidden !== false ? all : all.filter((e) => !e.hidden)
    const sorted = files.sortEntries(shown, files.sanitizeSort(opts))
    const limit = Math.max(1, Math.min(files.MAX_PAGE_SIZE, Math.floor(Number(opts.limit ?? opts.pageSize) || files.DEFAULT_PAGE_SIZE)))
    const slice = sorted.slice(offset, offset + limit)
    const hasMore = offset + slice.length < sorted.length
    return {
      path: where.full, phone: PREFIX + where.device, entries: slice, offset, limit,
      total: sorted.length, hasMore, nextOffset: hasMore ? offset + slice.length : null, truncated: hasMore
    }
  }

  function parentOf(where) {
    return { device: where.device, segs: where.segs.slice(0, -1), full: where.full.slice(0, where.full.lastIndexOf('\\')) }
  }

  async function stat(target, opts = {}) {
    const where = parse(target)
    if (!where.segs.length) return { where, entry: { name: where.device, path: where.full, dir: true, size: 0, mtimeMs: 0, ext: '' } }
    const name = where.segs[where.segs.length - 1].toLowerCase()
    const entry = (await entriesOf(parentOf(where), opts)).find((e) => e.name.toLowerCase() === name)
    if (!entry) throw fail('NOT_FOUND', '手機裡找不到這個檔案')
    return { where, entry }
  }

  async function resolve(target) {
    const { where, entry } = await stat(target)
    const parent = where.full.slice(0, where.full.lastIndexOf('\\')) || where.full
    return { path: where.full, dir: entry.dir, parent: entry.dir ? where.full : parent }
  }

  async function inspect(target) {
    const { entry } = await stat(target)
    return {
      path: entry.path, name: entry.name, dir: entry.dir, link: false, size: entry.size, mtimeMs: entry.mtimeMs,
      ctimeMs: 0, atimeMs: 0, ext: entry.ext,
      type: entry.dir ? '資料夾' : (entry.ext ? `${entry.ext.toUpperCase()} 檔` : '檔案'),
      image: '', text: '', shortcutTarget: '', linkTarget: '', width: 0, height: 0, tooLarge: false, phone: true
    }
  }

  /** 開檔／預覽／拖出去：先複製到暫存（大小沒變就用上次那份），資料夾不做 */
  async function realPath(target) {
    const { where, entry } = await stat(target)
    if (entry.dir) throw fail('BAD_PATH', '資料夾請用複製、貼上')
    const tag = crypto.createHash('sha1').update(where.full.toLowerCase()).digest('hex').slice(0, 12)
    const dir = path.join(deps.zipTempRoot(), 'mtp', tag)
    const file = path.join(dir, entry.name)
    const st = await fsp.stat(file).catch(() => null)
    if (st && st.size === entry.size) return file
    await fsp.mkdir(dir, { recursive: true })
    await fsp.rm(file, { force: true }).catch(() => undefined)
    const loc = await locOf(where)
    await guard(() => tx().copyOut(loc, file))
    if (!await fsp.stat(file).catch(() => null)) throw fail('MTP_FAILED', '從手機複製不出來')
    return file
  }

  async function openPath(target) {
    const info = await resolve(target)
    if (info.dir) return info
    const err = await deps.mediaOpen(await realPath(target))
    if (err) throw fail('OPEN_FAILED', '打不開')
    return true
  }

  function uniqueName(taken, name) {
    const ext = path.extname(name)
    const stem = ext ? name.slice(0, -ext.length) : name
    let next = name
    for (let n = 2; taken.has(next.toLowerCase()); n += 1) {
      if (n > 9999) throw fail('EXISTS', '那裡已經有同名的東西了')
      next = `${stem} (${n})${ext}`
    }
    taken.add(next.toLowerCase())
    return next
  }

  async function localNames(dir) {
    return new Set((await fsp.readdir(dir).catch(() => [])).map((n) => n.toLowerCase()))
  }

  function budget() {
    const state = { items: 0 }
    return () => {
      state.items += 1
      if (state.items > MAX_ITEMS) throw fail('TOO_MANY', `一次最多 ${MAX_ITEMS} 個項目，請分批複製`)
    }
  }

  /** 手機 → 本機（遞迴）。撞名產 `name (2).ext`，不覆寫 */
  async function pullTree(where, entry, destDir, taken, tick, depth) {
    tick()
    const name = uniqueName(taken, entry.name)
    const local = path.join(destDir, name)
    if (!entry.dir) {
      await guard(async () => tx().copyOut(await locOf(where), local))
      return local
    }
    if (depth > MAX_DEPTH) throw fail('TOO_DEEP', '資料夾層數太深')
    await fsp.mkdir(local)
    const children = await entriesOf(where, { fresh: true })
    const inner = new Set()
    for (const child of children) {
      const sub = { device: where.device, segs: [...where.segs, child.name], full: `${where.full}\\${child.name}` }
      await pullTree(sub, child, local, inner, tick, depth + 1)
    }
    return local
  }

  async function copyOut(sources, destination) {
    const tick = budget()
    const taken = await localNames(destination)
    const created = []
    for (const item of sources.slice(0, 500)) {
      const { where, entry } = await stat(item, { fresh: true })
      created.push(await pullTree(where, entry, destination, taken, tick, 0))
    }
    files.invalidateListCache?.(destination)
    return { paths: created, status: 'completed', items: [] }
  }

  /** 本機 → 手機（遞迴） */
  async function pushTree(localPath, where, taken, tick, depth) {
    tick()
    const st = await fsp.lstat(localPath)
    if (st.isSymbolicLink()) return null
    const name = uniqueName(taken, path.basename(localPath))
    const target = { device: where.device, segs: [...where.segs, name], full: `${where.full}\\${name}` }
    const loc = await locOf(target)
    if (!st.isDirectory()) {
      await guard(() => tx().copyIn(localPath, loc))
      return target.full
    }
    if (depth > MAX_DEPTH) throw fail('TOO_DEEP', '資料夾層數太深')
    await guard(() => tx().mkdir(loc))
    const inner = new Set()
    for (const child of await fsp.readdir(localPath)) {
      await pushTree(path.join(localPath, child), target, inner, tick, depth + 1)
    }
    listings.delete(target.full.toLowerCase())
    return target.full
  }

  async function copyIn(sources, toDir) {
    const where = parse(toDir)
    if (!where.segs.length) throw fail('BAD_PATH', '請先點進手機的儲存空間再貼上')
    const from = sources.slice(0, 500).map((item) => {
      if (typeof item === 'string' && item.slice(0, PREFIX.length).toLowerCase() === PREFIX) {
        throw fail('BAD_PATH', '手機跟手機之間請先複製到電腦')
      }
      return deps.resolveExisting(item)
    })
    if (!from.length) throw fail('EMPTY', '沒有要複製的檔案')
    const tick = budget()
    const taken = new Set((await entriesOf(where, { fresh: true })).map((e) => e.name.toLowerCase()))
    const created = []
    for (const local of from) {
      const full = await pushTree(local, where, taken, tick, 0)
      if (full) created.push(full)
    }
    listings.delete(where.full.toLowerCase())
    return { paths: created, status: 'completed', items: [] }
  }

  /** 永久刪除（遞迴：gio remove 只刪得掉空資料夾） */
  async function removeTree(where, entry, tick, depth) {
    tick()
    if (entry.dir) {
      if (depth > MAX_DEPTH) throw fail('TOO_DEEP', '資料夾層數太深')
      for (const child of await entriesOf(where, { fresh: true })) {
        const sub = { device: where.device, segs: [...where.segs, child.name], full: `${where.full}\\${child.name}` }
        await removeTree(sub, child, tick, depth + 1)
      }
      listings.delete(where.full.toLowerCase())
    }
    const loc = await locOf(where)
    await guard(() => tx().remove(loc))
  }

  async function remove(target) {
    const where = parse(target)
    if (where.segs.length < 2) throw fail('PROTECTED', '手機的儲存空間不能刪')
    const { entry } = await stat(target, { fresh: true })
    await removeTree(where, entry, budget(), 0)
    listings.delete(parentOf(where).full.toLowerCase())
    return { path: where.full, permanent: true }
  }

  /** 首頁提示＋能力說明（bootstrap 的 mtp 欄位） */
  async function supportInfo() {
    const info = detected()
    if (info.kind === 'none') {
      return { mode: 'none', supported: false, note: info.gio ? HINT_NO_GVFS_MTP : HINT_NO_TOOLS }
    }
    const found = await listDevices().catch(() => [])
    const fuseNote = info.kind === 'fuse' ? HINT_FUSE.replace('{tool}', info.fuseTool) : ''
    return {
      mode: info.kind,
      supported: true,
      devices: found.length,
      note: found.length ? fuseNote : `${fuseNote}${HINT_NO_DEVICE}`
    }
  }

  async function shutdown() {
    await transport?.unmountAll?.().catch(() => undefined)
  }

  return { listDevices, list, resolve, inspect, realPath, openPath, copyOut, copyIn, remove, supportInfo, shutdown }
}

module.exports = { createLinuxMtp, HINT_NO_TOOLS, HINT_NO_GVFS_MTP, HINT_NO_DEVICE, MAX_ITEMS }
