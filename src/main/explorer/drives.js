'use strict'

/**
 * 本機磁碟與使用者資料夾（Main Process）。
 *
 * Windows：磁碟字母走 `fsutil fsinfo drives`（System32），不要 A–Z 去 `existsSync`。
 * Linux：掛載點走 `/proc/self/mountinfo`（`platform/linux.js`）；`letter` 是短 id，`path` 是 POSIX。
 */

const fs = require('../raw-fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const platform = require('../platform')

/** 虛擬位置：Windows 那樣的「本機」首頁（不是真路徑，別送進 paths）。 */
const THIS_PC = 'thispc'

/**
 * 碰使用者資料夾／磁碟一次最多等多久。**這一整支都不可以用同步 fs**：
 * 「下載」常被搬到網路磁碟，NAS 睡著時 `statSync` 會把主程序卡到 SMB 逾時（十幾秒），
 * 整個 App 在 Windows 眼裡就是「沒有回應」。逾時一律當成「在，只是現在慢」。
 */
const PROBE_TIMEOUT_MS = 1500

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {T} fallback 逾時回這個
 * @returns {Promise<T>}
 */
function withTimeout(promise, fallback, ms = PROBE_TIMEOUT_MS) {
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * 是不是資料夾。不存在回 false；網路磁碟太慢（逾時）回 true，讓它照樣列出來。
 * @param {string} full
 * @returns {Promise<boolean>}
 */
function isDirSoon(full) {
  return withTimeout(fs.promises.stat(full).then((st) => st.isDirectory(), () => false), true)
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isThisPc(raw) {
  return String(raw || '').replace(/[\\/]+$/, '').toLowerCase() === THIS_PC
}

/**
 * @param {string} folder
 * @param {string} id
 * @param {string} label
 * @returns {Promise<{ id: string, label: string, path: string } | null>}
 */
async function place(folder, id, label) {
  const full = path.resolve(folder)
  return await isDirSoon(full) ? { id, label, path: full } : null
}

/**
 * @returns {Promise<Array<{ id: string, label: string, path: string }>>}
 */
async function listPlaces() {
  let home = ''
  try {
    home = os.homedir()
  } catch {
    return []
  }
  const pending = [place(home, 'home', '個人資料夾')]
  const known = [
    ['Desktop', 'desktop', '桌面'],
    ['Downloads', 'downloads', '下載'],
    ['Documents', 'documents', '文件'],
    ['Pictures', 'pictures', '圖片'],
    ['Music', 'music', '音樂'],
    ['Videos', 'videos', '影片']
  ]
  const xdg = platform.isWindows ? {} : readXdgUserDirs(home)
  for (const [folder, id, label] of known) {
    let full = xdg[id] || path.join(home, folder)
    try {
      const { app } = require('electron')
      if (app) {
        const fromApp = app.getPath(id)
        // Electron 在未設定 XDG 時會把 downloads／documents 等都退回 home，
        // 側欄就會出現兩個都叫 /home/… 的「下載」「文件」——那種情況改用標準子目錄名。
        if (fromApp && path.resolve(fromApp) !== path.resolve(home)) full = fromApp
      }
    } catch {
      // 純 Node 或系統位置取不到時，保留家目錄／XDG 退路。
    }
    if (path.resolve(full) === path.resolve(home)) continue
    pending.push(place(full, id, label))
  }
  return (await Promise.all(pending)).filter(Boolean)
}

/**
 * 讀 ~/.config/user-dirs.dirs（XDG）。失敗就空物件。
 * @param {string} home
 * @returns {Record<string, string>}
 */
function readXdgUserDirs(home) {
  /** @type {Record<string, string>} */
  const out = {}
  const file = path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'user-dirs.dirs'
  )
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  const map = {
    XDG_DESKTOP_DIR: 'desktop',
    XDG_DOWNLOAD_DIR: 'downloads',
    XDG_DOCUMENTS_DIR: 'documents',
    XDG_PICTURES_DIR: 'pictures',
    XDG_MUSIC_DIR: 'music',
    XDG_VIDEOS_DIR: 'videos'
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*"([^"]+)"/.exec(line)
    if (!m || !map[m[1]]) continue
    let value = m[2].replace(/\$HOME/g, home).replace(/^~(?=\/)/, home)
    if (value.startsWith('/')) out[map[m[1]]] = value
  }
  return out
}

/**
 * @returns {Promise<string[]>}
 */
async function driveLetters() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'fsutil.exe')
  const stdout = await new Promise((resolve) => {
    execFile(exe, ['fsinfo', 'drives'], { encoding: 'utf8', timeout: 3000, windowsHide: true },
      (error, out) => resolve(error ? '' : String(out || '')))
  })
  const found = stdout.match(/[A-Z]:\\/gi) || []
  if (found.length) return [...new Set(found.map((item) => item[0].toUpperCase()))]
  const letters = []
  for (let code = 67; code <= 90; code += 1) letters.push(String.fromCharCode(code))
  const alive = await Promise.all(letters.map((letter) => (
    withTimeout(fs.promises.stat(`${letter}:\\`).then(() => true, () => false), true)
  )))
  return letters.filter((_, i) => alive[i])
}

/**
 * @returns {Promise<Array<{ letter: string, path: string, total: number, free: number }>>}
 */
async function listDrives() {
  if (!platform.isWindows) {
    const seen = new Set()
    return platform.linux.readMounts().map((mount) => {
      let letter = platform.linux.mountLetter(mount.path)
      while (seen.has(letter)) letter = `${letter}_`
      seen.add(letter)
      return { letter, path: mount.path, total: 0, free: 0 }
    })
  }
  return (await driveLetters()).map((letter) => ({
    letter,
    path: `${letter}:\\`,
    total: 0,
    free: 0
  }))
}

/**
 * @returns {Promise<Array<{ letter: string, path: string, label: string, fs: string, total: number, free: number, type: number, remote: string }>>}
 */
let infoPending = null
function driveInfo() {
  if (infoPending) return infoPending
  if (!platform.isWindows) {
    infoPending = listDrivesLinuxInfo().finally(() => { infoPending = null })
    return infoPending
  }
  const exe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-CimInstance Win32_LogicalDisk |'
    + ' Select-Object DeviceID,VolumeName,FileSystem,DriveType,Size,FreeSpace,ProviderName |'
    + ' ConvertTo-Json -Compress'
  infoPending = new Promise((resolve) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024
    }, (error, out) => resolve(error ? [] : parseDriveInfo(out)))
  }).then(async (parsed) => (parsed.length ? parsed : (await listDrives()).map(toInfo)))
    .finally(() => { infoPending = null })
  return infoPending
}

/**
 * Linux：非同步 statfs，單顆逾時就當容量未知。
 * @returns {Promise<object[]>}
 */
async function listDrivesLinuxInfo() {
  const mounts = platform.linux.readMounts()
  const seen = new Set()
  const rows = []
  for (const mount of mounts) {
    let letter = platform.linux.mountLetter(mount.path)
    while (seen.has(letter)) letter = `${letter}_`
    seen.add(letter)
    const usage = await withTimeout(statfsSafe(mount.path), { total: 0, free: 0 })
    const remote = mount.fs === 'nfs' || mount.fs === 'cifs' || mount.fs === 'smb3'
      || mount.source.includes(':')
    rows.push({
      letter,
      path: mount.path,
      label: mount.path === '/' ? '根目錄' : path.basename(mount.path) || mount.path,
      fs: String(mount.fs || '').slice(0, 16),
      total: usage.total,
      free: usage.free,
      type: remote ? 4 : 3,
      remote: remote ? String(mount.source || '').slice(0, 260) : ''
    })
  }
  return rows
}

/**
 * @param {string} mountPath
 * @returns {Promise<{ total: number, free: number }>}
 */
async function statfsSafe(mountPath) {
  try {
    if (typeof fs.promises.statfs === 'function') {
      const st = await fs.promises.statfs(mountPath)
      const bsize = Number(st.bsize) || 0
      const blocks = Number(st.blocks) || 0
      const bavail = Number(st.bavail) || 0
      return { total: bsize * blocks, free: bsize * bavail }
    }
  } catch {
    // 無權或特殊掛載
  }
  return { total: 0, free: 0 }
}

/**
 * @param {{ letter: string, path: string }} disk
 */
function toInfo(disk) {
  return { ...disk, label: '', fs: '', total: 0, free: 0, type: 3, remote: '' }
}

/**
 * @param {string} raw
 * @returns {Array<object>}
 */
function parseDriveInfo(raw) {
  let parsed = null
  try {
    parsed = JSON.parse(String(raw || '').trim() || 'null')
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
  const out = []
  for (const item of list) {
    const id = String((item && item.DeviceID) || '')
    if (!/^[A-Za-z]:$/.test(id)) continue
    const letter = id[0].toUpperCase()
    out.push({
      letter,
      path: `${letter}:\\`,
      label: String((item && item.VolumeName) || '').slice(0, 64),
      fs: String((item && item.FileSystem) || '').slice(0, 16),
      total: capacity(item.Size),
      free: Math.min(capacity(item.FreeSpace), capacity(item.Size)),
      type: Number(item && item.DriveType) || 0,
      remote: String((item && item.ProviderName) || '').slice(0, 260)
    })
  }
  return out
}

function capacity(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const DEVICE_RE = /^::\{20D04FE0-3AEA-1069-A2D8-08002B30309D\}\\{3}\?\\[\w#&.{}~-]+$/i

/** @param {unknown} raw */
function isDevicePath(raw) {
  return typeof raw === 'string' && raw.length <= 512 && DEVICE_RE.test(raw)
}

/**
 * 「本機」底下不是檔案系統的裝置（插著的手機、相機）。
 * Linux：MTP／殼層 COM 尚未移植 → 空清單（降級，不 crash）。
 * @returns {Promise<Array<{ name: string, path: string, type: string }>>}
 */
function listDevices() {
  if (!platform.isWindows) return Promise.resolve([])
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new();'
    + ' @((New-Object -ComObject Shell.Application).NameSpace(17).Items() | Where-Object { -not $_.IsFileSystem } |'
    + ' ForEach-Object { @{ name = $_.Name; path = $_.Path; type = $_.Type } }) | ConvertTo-Json -Compress'
  return new Promise((resolve) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024
    }, (error, out) => resolve(error ? [] : parseDevices(out)))
  })
}

/** @param {string} raw */
function parseDevices(raw) {
  let parsed = null
  try {
    parsed = JSON.parse(String(raw || '').trim() || 'null')
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
  return list.filter((item) => item && isDevicePath(item.path)).map((item) => ({
    name: String(item.name || '裝置').slice(0, 128),
    path: item.path,
    type: String(item.type || '').slice(0, 64)
  }))
}

module.exports = {
  THIS_PC, isThisPc, listPlaces, listDrives, driveInfo, parseDriveInfo, isDirSoon,
  listDevices, parseDevices
}
