'use strict'

/**
 * Linux XDG Trash（~/.local/share/Trash）。
 *
 * 丟檔優先 Electron `shell.trashItem`；沒有 Electron 時手動搬進 files/ + 寫 info/。
 * recycleKey 形狀：`xdg|<info 檔名不含 .trashinfo>`（與 Windows 的 `D|S-1-5|…` 分開）。
 */

const crypto = require('crypto')
const fs = require('../raw-fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const { execFile } = require('child_process')
const paths = require('./paths')
const platform = require('../platform')

const RECYCLE_CWD = 'recyclebin'
const KEY_RE = /^xdg\|([^\\/:*?"<>|\u0000]+)$/i

function isRecyclePath(raw) {
  return String(raw || '').replace(/[\\/]+$/, '').toLowerCase() === RECYCLE_CWD
}

function ensureTrashDirs() {
  const { files, info } = platform.linux.trashDirs()
  fs.mkdirSync(files, { recursive: true })
  fs.mkdirSync(info, { recursive: true })
  return { files, info }
}

/**
 * @param {string} text
 * @returns {{ originalPath: string, deletedAt: number } | null}
 */
function parseTrashInfo(text) {
  const body = String(text || '')
  if (!/^\s*\[Trash Info\]/i.test(body)) return null
  let originalPath = ''
  let deletedAt = 0
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^Path=(.*)$/i)
    if (m) {
      try {
        originalPath = decodeURIComponent(m[1].trim())
      } catch {
        originalPath = m[1].trim()
      }
      continue
    }
    const d = line.match(/^DeletionDate=(.*)$/i)
    if (d) {
      const ms = Date.parse(d[1].trim())
      deletedAt = Number.isFinite(ms) ? ms : 0
    }
  }
  if (!originalPath.startsWith('/')) return null
  try {
    originalPath = paths.resolveAbs(originalPath)
  } catch {
    return null
  }
  return { originalPath, deletedAt }
}

function encodeTrashInfo(originalPath, deletedAtMs) {
  const iso = new Date(deletedAtMs || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // Path 用 percent-encoding（XDG 允許；空白等特殊字元較安全）
  const encoded = encodeURI(originalPath).replace(/#/g, '%23')
  return `[Trash Info]\nPath=${encoded}\nDeletionDate=${iso}\n`
}

function uniqueTrashName(base) {
  const safe = String(base || 'item').replace(/[\/\u0000]/g, '_')
  let name = safe
  const { files, info } = platform.linux.trashDirs()
  for (let i = 0; i < 32; i += 1) {
    const filePath = path.join(files, name)
    const infoPath = path.join(info, `${name}.trashinfo`)
    if (!fs.existsSync(filePath) && !fs.existsSync(infoPath)) return name
    const stem = path.parse(safe).name
    const ext = path.parse(safe).ext
    name = `${stem}_${crypto.randomBytes(3).toString('hex')}${ext}`
  }
  return `${Date.now()}_${safe}`
}

/**
 * @returns {Promise<{ path: string, entries: object[], truncated: boolean }>}
 */
async function list() {
  const { files, info } = ensureTrashDirs()
  let names
  try {
    names = await fsp.readdir(info)
  } catch {
    return { path: RECYCLE_CWD, entries: [], truncated: false }
  }
  const entries = []
  let truncated = false
  for (const name of names) {
    if (!name.endsWith('.trashinfo')) continue
    const keyName = name.slice(0, -'.trashinfo'.length)
    let text
    try {
      text = await fsp.readFile(path.join(info, name), 'utf8')
    } catch {
      continue
    }
    const meta = parseTrashInfo(text)
    if (!meta) continue
    const rPath = path.join(files, keyName)
    let dir = false
    let size = 0
    let mtimeMs = meta.deletedAt
    try {
      const st = await fsp.lstat(rPath)
      dir = st.isDirectory()
      size = dir ? 0 : Number(st.size) || 0
      mtimeMs = Number(st.mtimeMs) || mtimeMs
    } catch {
      continue
    }
    const display = path.basename(meta.originalPath)
    entries.push({
      name: display,
      path: meta.originalPath,
      originalPath: meta.originalPath,
      recycleKey: `xdg|${keyName}`,
      dir,
      size,
      mtimeMs,
      deletedAt: meta.deletedAt,
      ext: dir ? '' : path.extname(display).slice(1).toLowerCase()
    })
    if (entries.length >= 2000) {
      truncated = true
      break
    }
  }
  entries.sort((a, b) => (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0))
  return { path: RECYCLE_CWD, entries, truncated }
}

async function trashViaCli(full) {
  await new Promise((resolve, reject) => {
    execFile('gio', ['trash', full], { timeout: 30_000 }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function trashNative(full) {
  const { files, info } = ensureTrashDirs()
  const name = uniqueTrashName(path.basename(full))
  const dest = path.join(files, name)
  const infoPath = path.join(info, `${name}.trashinfo`)
  const body = encodeTrashInfo(full, Date.now())
  await fsp.writeFile(infoPath, body, 'utf8')
  try {
    await fsp.rename(full, dest)
  } catch (error) {
    try { await fsp.rm(infoPath, { force: true }) } catch { /* 清半套 */ }
    // 跨檔案系統：複製再刪
    await fsp.cp(full, dest, { recursive: true, errorOnExist: true })
    await paths.removeLinkOrTree(full)
  }
}

/**
 * @param {string} full
 */
async function trash(full) {
  let st
  try {
    st = fs.lstatSync(full)
  } catch {
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  if (!st) throw paths.fail('NOT_FOUND', '找不到這個檔案')
  if (process.versions.electron) {
    try {
      const { shell } = require('electron')
      if (shell && typeof shell.trashItem === 'function') {
        await shell.trashItem(full)
        return
      }
    } catch {
      // 退回手動／gio
    }
  }
  try {
    await trashViaCli(full)
    return
  } catch {
    // gio 可能沒裝
  }
  try {
    await trashNative(full)
  } catch {
    throw paths.fail('DELETE_FAILED', '刪不掉')
  }
}

function parseKey(recycleKey) {
  const m = KEY_RE.exec(String(recycleKey || ''))
  if (!m) throw paths.fail('BAD_PATH', '路徑不合法')
  const keyName = m[1]
  if (keyName.includes('..') || keyName.includes('/') || keyName.includes('\\')) {
    throw paths.fail('BAD_PATH', '路徑不合法')
  }
  const { files, info } = platform.linux.trashDirs()
  return {
    keyName,
    iPath: path.join(info, `${keyName}.trashinfo`),
    rPath: path.join(files, keyName)
  }
}

async function restore(recycleKey) {
  const loc = parseKey(recycleKey)
  let text
  try {
    text = await fsp.readFile(loc.iPath, 'utf8')
  } catch {
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  const meta = parseTrashInfo(text)
  if (!meta) throw paths.fail('NOT_FOUND', '找不到這個檔案')
  try {
    await fsp.lstat(loc.rPath)
  } catch {
    throw paths.fail('NOT_FOUND', '找不到這個檔案')
  }
  const destAbs = paths.resolveAbs(meta.originalPath)
  const parent = path.dirname(destAbs)
  paths.assertCreatable(destAbs)
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
    await fsp.rm(loc.iPath, { force: true })
  } catch {
    throw paths.fail('RESTORE_FAILED', '還原失敗')
  }
  return { path: dest }
}

async function purge(recycleKey) {
  const loc = parseKey(recycleKey)
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
  const listed = await list()
  let count = 0
  for (const entry of listed.entries) {
    try {
      await purge(entry.recycleKey)
      count += 1
    } catch {
      // 單筆失敗略過
    }
  }
  return { count }
}

module.exports = {
  RECYCLE_CWD,
  isRecyclePath,
  parseTrashInfo,
  encodeTrashInfo,
  list,
  trash,
  restore,
  purge,
  empty
}
