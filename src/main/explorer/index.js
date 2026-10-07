'use strict'

/**
 * 整機檔案總管門面（Main Process）。
 *
 * renderer 送絕對路徑；所有進出都過 `paths.js`。UFFS 只當搜尋引擎，
 * 關 App 不停它的 daemon。
 */

const { app, shell, dialog, BrowserWindow, nativeImage } = require('electron')
const fs = require('../raw-fs')
const path = require('path')
const { execFile } = require('child_process')
const paths = require('./paths')
const store = require('./store')
const files = require('./fs')
const drives = require('./drives')
const watch = require('./watch')
const uffs = require('./uffs')
const recycle = require('./recycle')
const places = require('./places')
const shellExt = require('./shell')
const size = require('./size')
const nativeProbe = require('../native-probe')
const operations = require('./operations')
const zipOps = require('./zip-ops')
const zip = require('./zip')
const mtp = require('./mtp')
const fileDetails = require('./details')
const mediaPlayer = require('../media-player')

/** 壓縮檔／手機裡的檔案要先複製到暫存才讀得到詳細資訊，只做這個大小以下（手機影片動輒幾 GB） */
const DETAILS_COPY_LIMIT = 64 * 1024 * 1024

/** @type {(channel: string, payload: any) => void} */
let emit = () => {}

/** @type {{ mode: 'copy'|'cut', paths: string[] }} */
let clip = { mode: 'copy', paths: [] }

/**
 * @param {{ userDataPath?: string, send?: (channel: string, payload: any) => void }} opts
 */
function configure(opts) {
  if (opts && opts.userDataPath) uffs.configure(opts.userDataPath)
  void zip.sweepTemp()
  if (opts && typeof opts.send === 'function') {
    emit = opts.send
    operations.configure({ emit })
  }
}

async function defaultPlaces() {
  const items = await drives.listPlaces()
  items.unshift({ id: 'thispc', label: '本機', path: drives.THIS_PC })
  items.push({ id: 'recycle', label: '資源回收筒', path: recycle.RECYCLE_CWD })
  return items
}

async function listPlaces() {
  const state = await store.readState()
  return places.mergePlaces(state.places, await defaultPlaces())
}

async function bootstrap() {
  const state = await store.readState()
  const [listed, disks] = await Promise.all([listPlaces(), drives.listDrives()])
  // 沒存過就落在「本機」首頁（＝Windows 檔案總管的預設畫面）。
  let cwd = state.lastPath || drives.THIS_PC
  if (!recycle.isRecyclePath(cwd) && !drives.isThisPc(cwd)) {
    // 先非同步問一次：上次停在睡著的網路磁碟時，同步的 resolveExisting 會把整個 App 卡住。
    // 太慢就照原路徑交給 renderer（listDir 是非同步的，慢也只慢那一格）
    const reachable = await drives.isDirSoon(cwd).catch(() => false)
    try {
      if (!reachable) throw new Error('gone')
      paths.resolveAbs(cwd)
    } catch {
      cwd = listed[0] ? listed[0].path : (disks[0] ? disks[0].path : 'C:\\')
    }
  }
  return { ...state, lastPath: cwd, places: listed, drives: disks }
}

function saveState(patch) {
  const next = patch && typeof patch === 'object' ? { ...patch } : {}
  delete next.uffsAuto
  return store.writeState(next)
}
const listDrives = () => drives.listDrives()
const driveInfo = () => drives.driveInfo()
// 手機（MTP）：路徑是 `mtp:裝置名稱\…`，每個入口先問 `mtp.isMtp`（跟壓縮檔同一招）
const listDevices = () => mtp.listDevices()
const listDir = async (dirPath, opts) => {
  // 「本機」是虛擬位置，沒有檔案清單（renderer 自己畫首頁）。
  if (drives.isThisPc(dirPath)) {
    return { path: drives.THIS_PC, entries: [], offset: 0, limit: 0, total: 0, hasMore: false, truncated: false }
  }
  if (recycle.isRecyclePath(dirPath)) return files.listRecycle(opts)
  if (mtp.isMtp(dirPath)) return mtp.list(dirPath, opts)
  // 壓縮檔（本身或裡面的資料夾）當資料夾列，唯讀
  const zipped = await zipOps.zipOf(dirPath)
  if (zipped) return zipOps.list(zipped, opts)
  return files.listDir(dirPath, opts)
}
/** 壓縮檔裡的檔案先解到暫存，其餘照原路徑（預覽／Markdown／大圖都吃真的檔案） */
async function realFile(filePath) {
  if (mtp.isMtp(filePath)) return mtp.realPath(filePath)
  const inner = await zipOps.innerOf(filePath)
  return inner ? zipOps.realPath(inner) : filePath
}
const preview = async (filePath) => files.preview(await realFile(filePath))
const readMarkdown = async (filePath) => files.readMarkdown(await realFile(filePath))

/**
 * 大預覽要用的網址。**不回 data: URI**：那會把整個檔案 base64 過一次 IPC，
 * 大一點的照片就爆掉（`inspect` 的預覽才會卡在 2MB）。改成走 `vi-media://`
 * 協定邊讀邊送，幾十 MB 的圖也開得動。
 *
 * 路徑在這裡先驗一次（存不存在、在不在允許範圍），協定那邊再驗一次。
 * @param {unknown} filePath
 * @returns {{ url: string, path: string }}
 */
async function mediaUrl(filePath) {
  const full = paths.resolveExisting(await realFile(filePath))
  return { url: require('../workspace/media').localUrlFor(full), path: full }
}
const inspect = async (filePath) => {
  if (mtp.isMtp(filePath)) return mtp.inspect(filePath)
  const inner = await zipOps.innerOf(filePath)
  return inner ? zipOps.inspect(inner) : files.inspect(filePath)
}

/**
 * 詳細資訊依類型補的那幾段（影音串流、相片 EXIF、文件、程式版本、文字編碼）。
 * @param {unknown} filePath
 */
async function details(filePath) {
  if (mtp.isMtp(filePath) || await zipOps.innerOf(filePath)) {
    const info = await inspect(filePath)
    if (info.dir || info.size > DETAILS_COPY_LIMIT) return { groups: [] }
  }
  return fileDetails.details(await realFile(filePath))
}

async function savePlaces(raw) {
  const incoming = places.sanitizePlaces(raw)
  const state = await store.readState()
  const seen = new Set(incoming.map((p) => p.id))
  const hidden = state.places.filter((p) => p.hidden && !seen.has(p.id))
  await store.writeState({ places: places.sanitizePlaces(incoming.concat(hidden)) })
  return listPlaces()
}

async function snapshotPlaces() {
  const state = await store.readState()
  if (state.places.length) return state.places.slice()
  const listed = await listPlaces()
  return listed.map((p) => ({ id: p.id, label: p.label, path: p.path, hidden: false }))
}

async function addPlace(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const full = recycle.isRecyclePath(input.path) ? recycle.RECYCLE_CWD : paths.resolveAbs(input.path)
  if (full !== recycle.RECYCLE_CWD && !paths.isUnc(full)) {
    const existing = paths.resolveExisting(full)
    let st
    try {
      st = fs.statSync(existing)
    } catch {
      throw paths.fail('NOT_FOUND', '找不到這個檔案')
    }
    if (!st.isDirectory()) throw paths.fail('BAD_PATH', '只能釘資料夾')
  }
  const listed = await listPlaces()
  const key = full.toLowerCase()
  if (listed.some((p) => String(p.path).toLowerCase() === key)) return listed
  const id = `place-${Date.now().toString(36)}`
  const fallback = full === recycle.RECYCLE_CWD
    ? '資源回收筒'
    : (path.basename(full) || places.shareLabel(full))
  const label = typeof input.label === 'string' && input.label.trim()
    ? input.label.trim().slice(0, 40)
    : fallback
  const stored = await snapshotPlaces()
  stored.push({ id, label, path: full, hidden: false })
  await store.writeState({ places: places.sanitizePlaces(stored) })
  return listPlaces()
}

async function removePlace(rawId) {
  const id = String(rawId || '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw paths.fail('BAD_PATH', '路徑不合法')
  if (id === places.PINNED_ID) throw paths.fail('BAD_PATH', '資源回收筒固定在側欄')
  const builtins = await defaultPlaces()
  const builtinIds = new Set(builtins.map((b) => b.id))
  const stored = await snapshotPlaces()
  let next
  if (builtinIds.has(id)) {
    let found = false
    next = stored.map((p) => {
      if (p.id !== id) return p
      found = true
      return { ...p, hidden: true }
    })
    if (!found) {
      const b = builtins.find((x) => x.id === id)
      next.push({ id, label: b.label, path: b.path, hidden: true })
    }
  } else {
    next = stored.filter((p) => p.id !== id)
  }
  await store.writeState({ places: places.sanitizePlaces(next) })
  return listPlaces()
}

async function connectShare(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const unc = paths.resolveAbs(input.unc || input.path)
  if (!paths.isUnc(unc)) throw paths.fail('BAD_PATH', '這不是網路路徑')
  const letter = places.sanitizeLetter(input.letter)
  if (letter) {
    const net = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'net.exe')
    // 非同步：NAS 慢或在等帳密時，同步的 spawnSync 會把整個 App 凍住最多 20 秒
    const ok = await new Promise((resolve) => {
      execFile(net, ['use', `${letter}:`, unc, '/persistent:yes'], { windowsHide: true, timeout: 20000 }, (error) => resolve(!error))
    })
    if (!ok) throw paths.fail('NET_USE', '連不上這個網路磁碟')
  }
  const target = letter ? `${letter}:\\` : unc
  const label = typeof input.label === 'string' && input.label.trim()
    ? input.label.trim().slice(0, 40)
    : places.shareLabel(unc)
  return addPlace({ path: target, label })
}

async function pickFolder() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '選擇資料夾',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return { path: '' }
  return { path: paths.resolveAbs(result.filePaths[0]) }
}

/**
 * 路徑列輸入／捷徑目的地。壓縮檔裡的路徑磁碟上不存在，另外問 `zipOps`。
 * @param {unknown} raw
 */
async function resolvePath(raw) {
  if (mtp.isMtp(typeof raw === 'string' ? raw.trim() : raw)) return mtp.resolve(raw.trim())
  try {
    return resolveLocal(raw)
  } catch (error) {
    if (error?.code !== 'NOT_FOUND') throw error
    const inner = await zipOps.innerOf(typeof raw === 'string' ? raw.trim() : raw)
    if (!inner) throw error
    const st = await zip.stat(inner.archive, inner.inner)
    return { path: inner.full, dir: st.dir, parent: st.dir ? inner.full : paths.parentOf(inner.full) }
  }
}

function resolveLocal(raw, seen = new Set()) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw paths.fail('BAD_PATH', '路徑不合法')
  if (text === '本機' || drives.isThisPc(text)) {
    return { path: drives.THIS_PC, dir: true, parent: drives.THIS_PC }
  }
  if (text === '資源回收筒' || text.toLowerCase() === 'recyclebin') {
    return { path: recycle.RECYCLE_CWD, dir: true, parent: recycle.RECYCLE_CWD }
  }
  const full = paths.resolveAbs(text)
  if (path.extname(full).toLowerCase() === '.lnk') {
    const key = full.toLowerCase()
    if (seen.has(key) || seen.size >= 16) throw paths.fail('BAD_PATH', '捷徑循環，無法開啟')
    seen.add(key)
    let target
    try {
      target = shell.readShortcutLink(full).target
    } catch {
      throw paths.fail('NOT_FOUND', '讀不到這個捷徑')
    }
    if (!target) throw paths.fail('NOT_FOUND', '找不到捷徑目的地')
    return resolveLocal(target, seen)
  }
  let st
  try {
    st = fs.lstatSync(full)
  } catch {
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  let dir = st.isDirectory()
  if (st.isSymbolicLink()) {
    try { dir = fs.statSync(full).isDirectory() } catch { dir = false }
  }
  const parent = dir ? full : (paths.parentOf(full) || full)
  return { path: full, dir, parent }
}

async function createShortcut(target, toDir) {
  const full = paths.resolveExisting(target)
  const destDir = toDir ? paths.resolveExisting(toDir) : path.dirname(full)
  let st
  try {
    st = fs.statSync(destDir)
  } catch {
    throw paths.fail('BAD_PATH', '目的地不存在')
  }
  if (!st.isDirectory()) throw paths.fail('BAD_PATH', '只能放進資料夾裡')
  paths.assertCreatable(destDir)
  const base = `${path.basename(full, path.extname(full))} - 捷徑.lnk`
  const dest = files.uniqueDest(destDir, base)
  if (!process.versions.electron) throw paths.fail('CREATE_FAILED', '建不了捷徑')
  const ok = shell.writeShortcutLink(dest, { target: full })
  if (!ok) throw paths.fail('CREATE_FAILED', '建不了捷徑')
  return { path: dest }
}
/** 手機裡不能改名、新增：在這裡就擋掉，講清楚為什麼 */
function writable(target) {
  if (mtp.isMtp(target)) throw mtp.readOnly()
}
const createEntry = (dirPath, name, dir) => (writable(dirPath), files.createEntry(dirPath, name, dir))
const renameEntry = (target, name) => (writable(target), files.renameEntry(target, name))
const removeEntry = (target, opts) => (mtp.isMtp(target) ? mtp.remove(target) : files.removeEntry(target, opts))
const restoreEntry = (key) => files.restoreEntry(key)
const purgeEntry = (key) => files.purgeEntry(key)
const emptyRecycle = () => files.emptyRecycle()
const copyEntry = (fromPath, toDir) => files.copyEntry(fromPath, toDir)
const moveEntry = (fromPath, toDir) => files.moveEntry(fromPath, toDir)
const uffsStatus = () => uffs.status()
const uffsSearch = (pattern, filters) => uffs.search(pattern, filters)
const uffsCancel = () => {
  uffs.cancelSearch()
  return true
}
const uffsInstall = () => uffs.download((info) => emit('explorer:uffsProgress', info))
const uffsCancelInstall = () => uffs.cancelDownload()
const uffsInstallBroker = () => uffs.installBroker()

/**
 * 進檔案頁自動把搜尋引擎拉起來。暫存 userData／uffsAuto=false 不跳 UAC。
 * @param {unknown} raw
 */
async function uffsEnsure(raw) {
  const force = Boolean(raw && typeof raw === 'object' && raw.force === true)
  if (uffs.inTempUserData()) {
    return uffs.ensureReady({ auto: false })
  }
  const state = await store.readState()
  const auto = force || state.uffsAuto !== false
  try {
    return await uffs.ensureReady({
      auto,
      onProgress: (info) => emit('explorer:uffsProgress', info)
    })
  } catch (error) {
    if (error && error.code === 'UFFS_BROKER') {
      await store.writeState({ uffsAuto: false })
    }
    throw error
  }
}

/**
 * @param {unknown} target
 */
async function openPath(target) {
  if (mtp.isMtp(target)) return mtp.openPath(target)
  const zipped = await zipOps.zipOf(target)
  if (zipped) {
    // 點 .zip 或壓縮檔裡的資料夾＝走進去；裡面的檔案解到暫存再用預設程式開
    const st = zipped.inner ? await zip.stat(zipped.archive, zipped.inner) : { dir: true }
    if (st.dir) return { path: zipped.full, dir: true, parent: zipped.full }
    const err = await mediaPlayer.openPath(await zipOps.realPath(zipped))
    if (err) throw paths.fail('OPEN_FAILED', '打不開')
    return true
  }
  const full = paths.resolveExisting(target)
  const resolved = resolveLocal(full)
  if (resolved.dir) return resolved
  // 影音交給自家播放器（要真的檔案路徑）；其他照原樣開 `full`——是捷徑就開捷徑本身，
  // 啟動參數、起始位置、以系統管理員執行這些設定才不會被跳過
  const err = await mediaPlayer.openMedia(resolved.path) ? '' : await shell.openPath(full)
  if (err) throw paths.fail('OPEN_FAILED', '打不開')
  return true
}

// 同一來源的 PNG 才能直接比：殼層與 Electron 各留一張 App 圖示，不逐檔重讀。
const appIconReferences = new Map()
let genericIconReference

// Windows 對同一張圖的 alpha 換算會有些微色差，PNG 字串不一定相同。
function sameIcon(left, right) {
  if (left === right) return true
  if (!left || !right) return false
  const a = nativeImage.createFromDataURL(left)
  const b = nativeImage.createFromDataURL(right)
  if (a.isEmpty() || b.isEmpty()) return false
  const size = a.getSize()
  if (size.width !== b.getSize().width || size.height !== b.getSize().height) return false
  const pixels = a.toBitmap()
  const reference = b.toBitmap()
  return pixels.every((value, i) =>
    (i % 4 !== 3 && pixels[i - i % 4 + 3] === 0 && reference[i - i % 4 + 3] === 0)
    || Math.abs(value - reference[i]) <= 4)
}

async function usableIcon(url, target, readIcon, source) {
  if (!url) return false
  if (path.extname(target).toLowerCase() === '.exe' || target === process.execPath) return true
  if (!appIconReferences.has(source)) {
    appIconReferences.set(source, Promise.resolve().then(() => readIcon(process.execPath)).catch(() => ''))
  }
  return !sameIcon(url, await appIconReferences.get(source))
}

async function electronIcon(target) {
  const icon = await app.getFileIcon(target, { size: 'normal' })
  return icon.isEmpty() ? '' : icon.toDataURL()
}

async function folderThumb(full, size) {
  const { entries = [], ...thumb } = await shellExt.thumbOf(full, size, true)
  if (!thumb.url) return { folder: true }
  const previews = (await Promise.all(entries.map(async entry => {
    try {
      // 子資料夾／資料夾捷徑只拿圖示，不繼續往內展開。
      const data = await fileIcon(path.join(full, entry.name), {
        thumb: !entry.dir && path.extname(entry.name).toLowerCase() !== '.lnk', size
      })
      return { ...entry, ...data }
    } catch {
      return null // 剛刪掉或讀不到的內容略過，保留資料夾外框。
    }
  }))).filter(Boolean)
  return { ...thumb, previews, ...(previews.some(item => item.pending) ? { pending: true } : {}) }
}

async function fileIcon(target, opts) {
  const full = paths.resolveExisting(target)
  const resolved = resolveLocal(full)
  const wantThumb = Boolean(opts && typeof opts === 'object' && opts.thumb === true)
  let interim = {}
  let pendingThumb
  if (wantThumb) {
    try {
      if (resolved.dir) return await folderThumb(resolved.path, opts.size)
      const thumb = await shellExt.thumbOf(resolved.path, opts.size)
      if (thumb && thumb.url) {
        interim = { ...(thumb.overlay ? { overlay: thumb.overlay } : {}) }
        // 真縮圖即使內容是 App logo 也要保留；暫時圖改問類型圖示，避免把 logo／空白圖放大。
        if (thumb.pending !== true) return { ...thumb }
        pendingThumb = thumb
        interim = { ...interim, pending: true }
      }
    } catch (error) {
      console.error('[explorer] 殼層縮圖失敗:', error?.message || error)
    }
  }
  try {
    const { url, baseUrl, overlay } = await shellExt.iconInfoOf(resolved.path)
    if (url) {
      genericIconReference ||= shellExt.genericIconOf().catch(() => '')
      const generic = await genericIconReference
      const valid = !sameIcon(baseUrl, generic)
        && await usableIcon(baseUrl, resolved.path, shellExt.iconOf, 'shell')
      if (!valid) return { fallback: true, ...(overlay ? { overlay } : {}), ...interim }
      const edge = Number.isInteger(opts?.size) && opts.size >= 16 ? Math.min(opts.size, 256) : 96
      const readThumb = async target => (await shellExt.thumbOf(target, edge))?.url || ''
      const large = pendingThumb && await usableIcon(pendingThumb.url, resolved.path, readThumb, `thumb:${edge}`)
      return { url: large ? pendingThumb.url : url, ...interim }
    }
  } catch (error) {
    console.error('[explorer] 殼層圖示失敗:', error?.message || error)
  }
  if (resolved.dir) return { folder: true, ...interim }
  try {
    const url = await electronIcon(resolved.path)
    if (await usableIcon(url, resolved.path, electronIcon, 'electron')) return { url, ...interim }
  } catch {
    // 圖示讀不到仍保留依類型畫的預設圖，不讓整列空白。
  }
  return { fallback: true, ...interim }
}

/** 拿不到檔案圖示時的保底圖（1x1 透明 PNG）：`startDrag` 的 icon 是空的就直接丟例外。 */
const FALLBACK_DRAG_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4' +
  '2mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function dragIcon(target) {
  try {
    const info = await fileIcon(target)
    if (info && info.url) {
      const image = nativeImage.createFromDataURL(info.url)
      if (!image.isEmpty()) return image
    }
  } catch {
    // 殼層圖示是裝飾，拿不到就往下走
  }
  return nativeImage.createFromDataURL(FALLBACK_DRAG_ICON)
}

/**
 * 把選取的項目交給 Windows 的原生拖放，讓它們拖得進別的程式
 * （瀏覽器的上傳框、桌面、Office）。renderer 只能在 dragstart 當下呼叫：
 * `startDrag` 底下是 OS 的 DoDragDrop，會一路阻塞到使用者放手。
 *
 * @param {string[]} list renderer 剛列出來的絕對路徑
 * @param {{ startDrag: Function, isDestroyed?: () => boolean }} sender 發起拖曳的 webContents
 * @returns {Promise<boolean>} 有沒有真的交給 OS
 */
async function startDrag(list, sender) {
  const files = []
  for (const item of (Array.isArray(list) ? list : []).slice(0, 100)) {
    try {
      // 壓縮檔裡／手機裡的先弄到暫存：OS 的拖放只認磁碟上真的檔案（手機的資料夾會被跳過）
      if (mtp.isMtp(item)) {
        files.push(await mtp.realPath(item))
        continue
      }
      const inner = await zipOps.innerOf(item)
      files.push(inner ? await zipOps.realPath(inner) : paths.resolveExisting(item))
    } catch {
      // 清單畫出來之後被刪掉的，跳過就好
    }
  }
  if (!files.length || !sender || sender.isDestroyed?.()) return false
  const icon = await dragIcon(files[0])
  sender.startDrag(files.length === 1 ? { file: files[0], icon } : { files, icon })
  return true
}

function shellMenu(spec) {
  return shellExt.menu(spec)
}

function shellInvoke(token, cmd, dir) {
  return shellExt.invoke(token, cmd, dir)
}

function shellRelease(token) {
  return shellExt.release(token)
}

function folderSize(dirPath, token) {
  return size.folderSize(dirPath, token, {
    exe: nativeProbe.resolveProbeExe(),
    onProgress: (info) => emit('explorer:folderSizeProgress', info)
  })
}

function folderSizeCancel(token) {
  return size.folderSizeCancel(token)
}

function shutdown() {
  size.folderSizeCancel()
  watch.stop()
  shellExt.shutdown()
  return uffs.shutdown()
}

/** 放得進系統剪貼簿、對話框 Ctrl+V 認得的點陣圖副檔名（SVG 是向量，放不進去就不列） */
const COPY_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])
/** 圖片檔超過這個大小就不讀了（對話框會再縮圖，這裡只是避免 NAS 大檔卡住） */
const COPY_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** 讀使用者磁碟最多等多久（NAS 睡著時同步卡住會讓整個 App 沒回應） */
const COPY_IMAGE_TIMEOUT_MS = 10000

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withRejectTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('TIMEOUT')
      error.code = 'TIMEOUT'
      error.userMessage = '讀取逾時，請稍後再試'
      reject(error)
    }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

/**
 * 把一張圖片檔讀成點陣圖、寫進系統剪貼簿。
 * 對話框的 `paste` 事件認得剪貼簿裡的圖片，直接 Ctrl+V 就會變成附件。
 * 路徑一律過 `resolveExisting`；壓縮檔裡／手機裡沒有真路徑，不做。
 * @param {unknown} rawPath
 * @returns {Promise<{ width: number, height: number }>}
 */
async function copyImage(rawPath) {
  if (mtp.isMtp(rawPath)) throw paths.fail('BAD_PATH', '手機裡的圖片請先複製到電腦')
  const inner = await zipOps.innerOf(rawPath)
  if (inner) throw paths.fail('READ_ONLY', '壓縮檔裡的圖片請先解壓縮')
  const full = paths.resolveExisting(rawPath)
  const ext = String(path.extname(full) || '').replace(/^\./, '').toLowerCase()
  if (!COPY_IMAGE_EXT.has(ext)) throw paths.fail('BAD_PATH', '只有圖片才能複製到剪貼簿')
  let st
  try {
    st = await withRejectTimeout(fs.promises.stat(full), COPY_IMAGE_TIMEOUT_MS)
  } catch (error) {
    if (error?.code === 'TIMEOUT') throw error
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  if (!st || !st.isFile()) throw paths.fail('BAD_PATH', '只有圖片才能複製到剪貼簿')
  if (st.size > COPY_IMAGE_MAX_BYTES) throw paths.fail('TOO_LARGE', '圖片太大，放不進剪貼簿')
  let buf
  try {
    buf = await withRejectTimeout(fs.promises.readFile(full), COPY_IMAGE_TIMEOUT_MS)
  } catch (error) {
    if (error?.code === 'TIMEOUT') throw error
    throw paths.fail('READ_FAILED', '讀不到這張圖片')
  }
  if (!buf || !buf.length) throw paths.fail('READ_FAILED', '讀不到這張圖片')
  // require 寫在函式裡：單元測試用 Module._load  mock electron，頂層解構會拿到 undefined
  const electron = require('electron')
  const nativeImage = electron && electron.nativeImage
  const clipboard = electron && electron.clipboard
  if (!nativeImage || !clipboard) throw paths.fail('NOT_SUPPORTED', '現在沒辦法寫入剪貼簿')
  let image = null
  try {
    image = nativeImage.createFromBuffer(buf)
  } catch {
    image = null
  }
  if (!image || image.isEmpty()) throw paths.fail('BAD_IMAGE', '這張圖片放不進剪貼簿')
  clipboard.writeImage(image)
  const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
  return { width: Number(size.width) || 0, height: Number(size.height) || 0 }
}

/**
 * @param {unknown} items
 * @param {unknown} mode
 */
async function setClipboard(items, mode) {
  if (!Array.isArray(items)) throw paths.fail('BAD_PATH', '路徑不合法')
  const next = []
  let zipped = false
  for (const item of items.slice(0, 50)) {
    if (mtp.isMtp(item)) {
      zipped = true
      next.push(mtp.parse(item).full)
      continue
    }
    const inner = await zipOps.innerOf(item)
    zipped = zipped || Boolean(inner)
    next.push(inner ? inner.full : paths.resolveExisting(item))
  }
  // 壓縮檔裡、手機裡是唯讀的：剪下一律當複製（貼上＝解壓縮／從手機複製出來）
  clip = { mode: mode === 'cut' && !zipped ? 'cut' : 'copy', paths: next }
  return { count: clip.paths.length, mode: clip.mode }
}

/**
 * @param {unknown} toDir
 */
async function paste(toDir) {
  const clipboard = clip
  if (!clipboard.paths.length) throw paths.fail('EMPTY', '剪貼簿是空的')
  // 貼進手機＝從電腦複製進去（剪下也只複製，電腦那份不刪）
  if (mtp.isMtp(toDir)) return mtp.copyIn(clipboard.paths, toDir)
  const trashed = recycle.isRecyclePath(toDir)
  if (trashed && clipboard.mode !== 'cut') throw paths.fail('BAD_PATH', '不能複製進資源回收筒')
  if (!trashed) await zipOps.assertWritable(toDir)
  const destination = trashed ? toDir : paths.resolveExisting(toDir)
  // 從壓縮檔複製出來的＝解壓縮到這裡；從手機來的走殼層複製；其餘照一般複製／搬移走操作中心
  const zippedPaths = []
  const phonePaths = []
  const sources = []
  for (const item of clipboard.paths) {
    if (mtp.isMtp(item)) phonePaths.push(item)
    else ((await zipOps.innerOf(item)) ? zippedPaths : sources).push(item)
  }
  if (phonePaths.length && trashed) throw paths.fail('BAD_PATH', '手機裡的檔案不能丟進資源回收筒')
  const extracted = zippedPaths.length ? (await zipOps.extract(zippedPaths, destination)).paths : []
  if (phonePaths.length) await mtp.copyOut(phonePaths, destination)
  if (!sources.length) return { trashed, paths: extracted, status: 'completed', items: [] }
  const result = await operations.run({
    mode: trashed ? 'trash' : clipboard.mode === 'cut' ? 'move' : 'copy',
    destination,
    sources
  })
  if (extracted.length) result.paths = extracted.concat(result.paths || [])
  if (clipboard.mode === 'cut' && clip === clipboard) {
    const completed = new Set(result.items.filter((item) => item.status === 'completed').map((item) => item.source))
    clip = { ...clipboard, paths: clipboard.paths.filter((item) => !completed.has(item)) }
  }
  return operationResult(result, { trashed })
}

/**
 * 拖放到資料夾列或側欄位置。mode=copy 複製，其餘搬移；丟進回收筒＝刪除。
 * @param {unknown} items
 * @param {unknown} toDir
 * @param {unknown} mode
 */
async function dropEntries(items, toDir, mode) {
  if (!Array.isArray(items)) throw paths.fail('BAD_PATH', '路徑不合法')
  const slice = items.slice(0, 50)
  // 拖進手機一律是複製
  if (mtp.isMtp(toDir)) return mtp.copyIn(slice, toDir)
  if (recycle.isRecyclePath(toDir)) {
    if (mode === 'copy') throw paths.fail('BAD_PATH', '不能複製進資源回收筒')
    return operationResult(await operations.run({ mode: 'trash', destination: toDir, sources: slice }), { trashed: true })
  }
  await zipOps.assertWritable(toDir)
  const dest = paths.resolveExisting(toDir)
  return operationResult(await operations.run({
    mode: mode === 'copy' ? 'copy' : 'move',
    destination: dest,
    sources: slice
  }))
}

function operationResult(result, extra = {}) {
  if (result && (result.status === 'failed' || result.status === 'partial')) {
    const error = result.errorObject || paths.fail('OPERATION_PARTIAL', '部分檔案操作失敗')
    error.operationId = result.id
    throw error
  }
  return {
    ...extra,
    paths: result && Array.isArray(result.paths) ? result.paths : [],
    operationId: result && result.id,
    status: result && result.status,
    items: result && result.items ? result.items : []
  }
}

const operationCancel = (id) => operations.cancel(id)
const operationRetry = (id) => operations.retry(id)
const operationUndo = (id) => operations.undo(id)
const operationState = () => operations.getState()
const setOperationPolicy = (opts) => operations.setCollisionPolicy(opts)

/**
 * @param {unknown} dirPath
 */
function watchDir(dirPath) {
  if (mtp.isMtp(dirPath)) return { watching: false, path: dirPath }
  if (recycle.isRecyclePath(dirPath)) return { watching: false, path: recycle.RECYCLE_CWD }
  if (zip.looksZip(dirPath)) return { watching: false, path: dirPath }
  return watch.start(dirPath, (payload) => {
    files.invalidateListCache(payload.path)
    emit('explorer:changed', payload)
  })
}

function watchDirs(dirPaths) {
  const list = Array.isArray(dirPaths) ? dirPaths : []
  const specs = list
    .filter((dirPath) => !recycle.isRecyclePath(dirPath) && !drives.isThisPc(dirPath) && !zip.looksZip(dirPath) && !mtp.isMtp(dirPath))
    .map((dirPath) => ({
      path: dirPath,
      send: (payload) => {
        files.invalidateListCache(payload.path)
        emit('explorer:changed', payload)
      }
    }))
  return watch.startMany(specs)
}

const extract = (items, toDir) => zipOps.extract(items, toDir)

function unwatch() {
  watch.stop()
  return true
}

module.exports = {
  configure,
  bootstrap,
  saveState,
  listPlaces,
  savePlaces,
  addPlace,
  removePlace,
  connectShare,
  pickFolder,
  resolvePath,
  extract,
  createShortcut,
  listDrives,
  driveInfo,
  listDevices,
  listDir,
  preview,
  readMarkdown,
  mediaUrl,
  inspect,
  details,
  createEntry,
  renameEntry,
  removeEntry,
  restoreEntry,
  purgeEntry,
  emptyRecycle,
  copyEntry,
  moveEntry,
  openPath,
  fileIcon,
  startDrag,
  shellMenu,
  shellInvoke,
  shellRelease,
  shutdown,
  copyImage,
  setClipboard,
  paste,
  dropEntries,
  operationCancel,
  operationRetry,
  operationUndo,
  operationState,
  setOperationPolicy,
  watchDir,
  watchDirs,
  unwatch,
  uffsStatus,
  uffsSearch,
  uffsCancel,
  uffsInstall,
  uffsCancelInstall,
  uffsInstallBroker,
  uffsEnsure,
  folderSize,
  folderSizeCancel
}
