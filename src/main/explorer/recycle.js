'use strict'

/**
 * Windows 資源回收筒（Main Process）。
 *
 * 丟進去走 OS 的 trash（Electron `shell.trashItem`，沒有 Electron 時改
 * VisualBasic FileIO）。列出／還原／清掉讀 `$Recycle.Bin` 的 `$I`／`$R`，
 * 不把使用者家目錄或磁碟根目錄送進回收筒（呼叫端先 `assertMutable`）。
 */

const crypto = require('crypto')
const fs = require('../raw-fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const { execFile } = require('child_process')
const paths = require('./paths')
const drives = require('./drives')

/** @type {string} */
let cachedSid = ''

const RECYCLE_CWD = 'recyclebin'
const KEY_RE = /^([^|\u0000]+)\|(\$I[^\\/:*?"<>|\u0000]+)$/i
const FILETIME_EPOCH_MS = 11644473600000

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isRecyclePath(raw) {
  return String(raw || '').replace(/[\\/]+$/, '').toLowerCase() === RECYCLE_CWD
}

/**
 * @param {string} value
 * @returns {string}
 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * @param {bigint} filetime
 * @returns {number}
 */
function filetimeToMs(filetime) {
  try {
    const ms = Number(filetime / 10000n) - FILETIME_EPOCH_MS
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  } catch {
    return 0
  }
}

/**
 * Windows Vista+ `$I` 中繼資料。
 * @param {Buffer} buf
 * @returns {{ originalPath: string, size: number, deletedAt: number } | null}
 */
function parseIFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) return null
  const version = Number(buf.readBigUInt64LE(0))
  const size = Number(buf.readBigUInt64LE(8))
  const deletedAt = filetimeToMs(buf.readBigUInt64LE(16))
  let original = ''
  if (version === 1) {
    original = buf.slice(24, Math.min(buf.length, 24 + 520)).toString('utf16le')
  } else {
    const chars = buf.readUInt32LE(24)
    const bytes = Math.min(Math.max(chars, 0) * 2, buf.length - 28)
    original = buf.slice(28, 28 + bytes).toString('utf16le')
  }
  original = original.replace(/\u0000.*$/s, '').replace(/\//g, '\\').trim()
  if (!paths.DRIVE_ABS.test(original)) return null
  try {
    original = paths.resolveAbs(original)
  } catch {
    return null
  }
  return { originalPath: original, size: Number.isFinite(size) ? size : 0, deletedAt }
}

/**
 * 非同步＋逾時：網路磁碟睡著時 readdir 會把整個 App 卡住。
 * @param {string} dir
 * @returns {Promise<import('fs').Dirent[] | null>}
 */
async function readdirQuick(dir) {
  let timer
  return Promise.race([
    fsp.readdir(dir, { withFileTypes: true }).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500) })
  ]).finally(() => clearTimeout(timer))
}

/**
 * 被搬到別處的「下載」「文件」等資料夾（例如網路磁碟），Windows 把回收筒放在那個資料夾裡。
 * @returns {Promise<string[]>}
 */
async function redirectedFolders() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
  const stdout = await new Promise((resolve) => {
    execFile(exe, ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      (error, out) => resolve(error ? '' : String(out || '')))
  })
  const profile = String(process.env.USERPROFILE || '').toLowerCase()
  const out = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    const m = /\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line)
    if (!m) continue
    const dir = m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] || all)
    if (!paths.DRIVE_ABS.test(dir) && !paths.isUnc(dir)) continue
    // 還在使用者資料夾底下的沒被搬走，回收筒就是磁碟那一個
    if (profile && dir.toLowerCase().startsWith(profile)) continue
    out.add(dir.replace(/[\\/]+$/, ''))
  }
  return [...out]
}

/**
 * 所有回收筒資料夾：磁碟的 `$Recycle.Bin\<SID>`、沒分 SID 的 `$Recycle.Bin` 本身（例如 Google Drive），
 * 以及被搬走的使用者資料夾裡的 `$RECYCLE.BIN`。`sid` 為空表示不分使用者。
 * @returns {Promise<Array<{ sid: string, dir: string }>>}
 */
async function binFolders() {
  const bins = (await drives.listDrives()).map((disk) => `${disk.letter}:\\$Recycle.Bin`)
  for (const dir of await redirectedFolders()) bins.push(path.join(dir, '$RECYCLE.BIN'))
  const out = []
  for (const bin of bins) {
    const names = await readdirQuick(bin)
    if (!names) continue
    if (names.some((entry) => /^\$I/i.test(entry.name))) out.push({ sid: '', dir: bin })
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      if (!/^S-[0-9\-]+$/i.test(entry.name)) continue
      out.push({ sid: entry.name, dir: path.join(bin, entry.name) })
    }
  }
  return out
}

/**
 * key 是「回收筒資料夾|$I 檔名」；資料夾必須是現在真的找得到的回收筒，不能讓前端指到別處。
 * @param {unknown} recycleKey
 * @returns {Promise<{ iName: string, dir: string, iPath: string, rPath: string }>}
 */
async function parseKey(recycleKey) {
  const m = KEY_RE.exec(String(recycleKey || ''))
  if (!m) throw paths.fail('BAD_PATH', '路徑不合法')
  const iName = m[2]
  const folder = (await binFolders()).find((f) => f.dir.toLowerCase() === m[1].toLowerCase())
  if (!folder) throw paths.fail('NOT_FOUND', '找不到這個檔案')
  return {
    iName,
    dir: folder.dir,
    iPath: path.join(folder.dir, iName),
    rPath: path.join(folder.dir, '$R' + iName.slice(2))
  }
}

/**
 * @param {string} iPath
 * @param {string} rPath
 * @returns {Promise<{ originalPath: string, size: number, deletedAt: number, dir: boolean, mtimeMs: number } | null>}
 */
async function readItem(iPath, rPath) {
  let buf
  try {
    buf = await fsp.readFile(iPath)
  } catch {
    return null
  }
  const meta = parseIFile(buf)
  if (!meta) return null
  let dir = false
  let size = meta.size
  let mtimeMs = meta.deletedAt
  try {
    const st = await fsp.lstat(rPath)
    dir = st.isDirectory()
    if (!dir) size = Number(st.size) || size
    mtimeMs = Number(st.mtimeMs) || mtimeMs
  } catch {
    return null
  }
  return { ...meta, dir, size, mtimeMs }
}

/**
 * @returns {Promise<{ path: string, entries: object[], truncated: boolean }>}
 */
async function list() {
  const entries = []
  let truncated = false
  for (const folder of await binFolders()) {
    let names
    try {
      names = await fsp.readdir(folder.dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('$I') && !name.startsWith('$i')) continue
      const iPath = path.join(folder.dir, name)
      const rPath = path.join(folder.dir, '$R' + name.slice(2))
      const meta = await readItem(iPath, rPath)
      if (!meta) continue
      const display = path.basename(meta.originalPath)
      entries.push({
        name: display,
        path: meta.originalPath,
        originalPath: meta.originalPath,
        recycleKey: `${folder.dir}|${name}`,
        dir: meta.dir,
        size: meta.size,
        mtimeMs: meta.mtimeMs,
        deletedAt: meta.deletedAt,
        ext: meta.dir ? '' : path.extname(display).slice(1).toLowerCase()
      })
      if (entries.length >= 2000) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  entries.sort((a, b) => (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0))
  return { path: RECYCLE_CWD, entries, truncated }
}

async function userSid() {
  if (cachedSid) return cachedSid
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
  const stdout = await new Promise((resolve) => {
    execFile(exe, ['/user'], { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      (error, out) => resolve(error ? '' : String(out || '')))
  })
  const match = stdout.match(/S-1-5-[0-9\-]+/)
  cachedSid = match ? match[0] : ''
  return cachedSid
}

/**
 * @param {string} originalPath
 * @param {number} size
 * @param {number} deletedAtMs
 * @returns {Buffer}
 */
function encodeIFile(originalPath, size, deletedAtMs) {
  const name = String(originalPath) + '\u0000'
  const nameBuf = Buffer.from(name, 'utf16le')
  const buf = Buffer.alloc(28 + nameBuf.length)
  buf.writeBigUInt64LE(2n, 0)
  buf.writeBigUInt64LE(BigInt(Math.max(0, Number(size) || 0)), 8)
  const filetime = BigInt(Math.max(0, Number(deletedAtMs) || Date.now()) + FILETIME_EPOCH_MS) * 10000n
  buf.writeBigUInt64LE(filetime, 16)
  buf.writeUInt32LE(name.length, 24)
  nameBuf.copy(buf, 28)
  return buf
}

/**
 * @param {string} full
 * @returns {string}
 */
function newIName(full) {
  const hex = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
  const ext = path.extname(full)
  return '$I' + hex + (ext && ext.length <= 8 ? ext : '')
}

/**
 * 把檔案搬進目前使用者在該磁碟的 `$Recycle.Bin`（寫 `$I` 中繼資料）。
 * @param {string} full
 */
async function trashNative(full) {
  const st = fs.lstatSync(full)
  const drive = full[0].toUpperCase()
  const sid = await userSid()
  if (!sid) throw new Error('no sid')
  const dir = `${drive}:\\$Recycle.Bin\\${sid}`
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  let iName = newIName(full)
  let iPath = path.join(dir, iName)
  for (let i = 0; i < 16 && fs.existsSync(iPath); i += 1) {
    iName = newIName(full)
    iPath = path.join(dir, iName)
  }
  const rPath = path.join(dir, '$R' + iName.slice(2))
  const buf = encodeIFile(full, st.isDirectory() ? 0 : Number(st.size) || 0, Date.now())
  await fsp.writeFile(iPath, buf)
  try {
    await fsp.rename(full, rPath)
  } catch (error) {
    try { await fsp.rm(iPath, { force: true }) } catch { /* 清掉半套中繼資料 */ }
    throw error
  }
}

/**
 * @param {string} full
 * @param {boolean} isDir
 */
async function trashViaPS(full, isDir) {
  const method = isDir ? 'DeleteDirectory' : 'DeleteFile'
  const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::'
    + method + '(' + psQuote(full) + ',' + "'OnlyErrorDialogs'" + ',' + "'SendToRecycleBin'" + ')'
  // 非同步：大資料夾丟回收筒要好幾秒，同步等的話整個 App 會卡住
  const failed = await new Promise((resolve) => {
    execFile(powershellPath(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { windowsHide: true, timeout: 30_000, encoding: 'utf8' }, (error) => resolve(Boolean(error)))
  })
  if (failed) throw paths.fail('DELETE_FAILED', '刪不掉')
}

/**
 * @param {string} full 已 resolve 的絕對路徑
 */
async function trash(full) {
  let isDir = false
  try {
    isDir = fs.lstatSync(full).isDirectory()
  } catch {
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  if (process.versions.electron) {
    try {
      const { shell } = require('electron')
      if (shell && typeof shell.trashItem === 'function') {
        await shell.trashItem(full)
        return
      }
    } catch {
      // 退回自己搬進 $Recycle.Bin
    }
  }
  try {
    await trashNative(full)
    return
  } catch {
    // 跨磁碟 rename 失敗時改走 FileIO
  }
  await trashViaPS(full, isDir)
}

/**
 * @param {{ dir: string, iPath: string, rPath: string }} loc
 */
function assertInsideBin(loc) {
  const prefix = (loc.dir + '\\').toLowerCase()
  const i = path.resolve(loc.iPath).toLowerCase()
  const r = path.resolve(loc.rPath).toLowerCase()
  if (!i.startsWith(prefix) || !r.startsWith(prefix)) {
    throw paths.fail('BAD_PATH', '路徑不合法')
  }
}

async function restore(recycleKey) {
  const loc = await parseKey(recycleKey)
  assertInsideBin(loc)
  const meta = await readItem(loc.iPath, loc.rPath)
  if (!meta) throw paths.fail('NOT_FOUND', '找不到這個檔案')
  const destAbs = paths.resolveAbs(meta.originalPath)
  const parent = path.dirname(destAbs)
  // 還原是把東西放回它原本待的地方，不是往新地方丟，所以只看目的地自己合不合法，不看父資料夾。
  // 看父資料夾的話，從磁碟根目錄（D:\）刪掉的東西一律還原不了——parent 就是 D:\，被當成鎖住的位置。
  paths.assertCreatable(destAbs)
  // 原本的資料夾可能已經被刪掉，補回來。已經在的不能補——對磁碟根目錄 mkdir 會吐 EPERM。
  if (!fs.existsSync(parent)) {
    try {
      await fsp.mkdir(parent, { recursive: true })
    } catch {
      throw paths.fail('RESTORE_FAILED', '還原失敗')
    }
  }
  let dest = destAbs
  if (fs.existsSync(dest)) {
    const base = path.basename(dest)
    const ext = path.extname(base)
    const stem = ext ? base.slice(0, -ext.length) : base
    let n = 2
    while (fs.existsSync(dest) && n <= 9999) {
      dest = path.join(parent, `${stem} (${n})${ext}`)
      n += 1
    }
    if (fs.existsSync(dest)) throw paths.fail('EXISTS', '那裡已經有同名的東西了')
  }
  paths.resolveAbs(dest)
  try {
    await fsp.rename(loc.rPath, dest)
  } catch {
    throw paths.fail('RESTORE_FAILED', '還原失敗')
  }
  // 檔案已經回去了；$I 被鎖住刪不掉不算還原失敗
  await fsp.rm(loc.iPath, { force: true }).catch((error) => console.error('[explorer] 刪除回收筒中繼檔失敗:', error?.code || error))
  return { path: dest }
}

/**
 * @param {unknown} recycleKey
 */
async function purge(recycleKey) {
  return purgeAt(await parseKey(recycleKey))
}

/**
 * @param {{ dir: string, iPath: string, rPath: string }} loc
 */
async function purgeAt(loc) {
  assertInsideBin(loc)
  try {
    await paths.removeLinkOrTree(loc.rPath)
  } catch (error) {
    if (!error || error.code !== 'NOT_FOUND') throw paths.fail('DELETE_FAILED', '刪不掉')
  }
  try {
    await fsp.rm(loc.iPath, { force: true })
  } catch {
    throw paths.fail('DELETE_FAILED', '刪不掉')
  }
  return { path: loc.rPath, permanent: true }
}

async function empty() {
  let count = 0
  const sid = await userSid()
  for (const folder of await binFolders()) {
    if (sid && folder.sid && folder.sid.toLowerCase() !== sid.toLowerCase()) continue
    let names
    try {
      names = await fsp.readdir(folder.dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('$I') && !name.startsWith('$i')) continue
      try {
        // 直接用這輪找到的資料夾，不要每筆都重新掃一次所有回收筒
        await purgeAt({
          dir: folder.dir,
          iPath: path.join(folder.dir, name),
          rPath: path.join(folder.dir, '$R' + name.slice(2))
        })
        count += 1
      } catch {
        // 單筆清不掉就略過，繼續清其餘
      }
    }
  }
  return { count }
}

module.exports = {
  RECYCLE_CWD,
  isRecyclePath,
  parseIFile,
  encodeIFile,
  list,
  trash,
  restore,
  purge,
  empty
}
