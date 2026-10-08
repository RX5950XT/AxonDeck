'use strict'

/**
 * Linux 的「內容」（取代 Windows 殼層的 properties 視窗）：名稱、類型／MIME、大小（資料夾遞迴、可取消）、
 * 位置、建立／修改／存取時間、擁有者／群組、權限（可改，chmod）、符號連結目標。
 *
 * MIME：`gio info`（有描述文字）→ `file --mime-type` → `xdg-mime query filetype` → 副檔名對照。
 * 擁有者名稱讀 /etc/passwd、/etc/group（LDAP／sssd 帳號查不到時顯示數字 uid／gid）。
 * 資料夾大小自己走一遍（lstat、不跟隨符號連結、不跨越掛載點），不共用詳情窗格的 folderSize（那邊同時只能一個工作）。
 */

const { execFile } = require('child_process')
const fs = require('fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const paths = require('./paths')

const EXEC_TIMEOUT_MS = 3000
const EXT_MIME = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', js: 'text/javascript', html: 'text/html',
  css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed',
  gz: 'application/gzip', tar: 'application/x-tar', mp3: 'audio/mpeg', wav: 'audio/x-wav', mp4: 'video/mp4',
  mkv: 'video/x-matroska', sh: 'application/x-shellscript', py: 'text/x-python'
}
/**
 * 常見 MIME 的中文說明。`gio info` 在 C 語系（這裡固定 LC_ALL=C.UTF-8，輸出才好解析）
 * 多半不給 standard::description，給了也是英文，所以先查這張表，查不到才用 gio 的說明，
 * 再查不到用大類（text／image／audio／video）。MIME 仍放在括號裡當次要資訊。
 */
const MIME_DESC = {
  'text/plain': '純文字文件', 'text/markdown': 'Markdown 文件', 'text/html': 'HTML 網頁', 'text/css': 'CSS 樣式表',
  'text/csv': 'CSV 試算表', 'text/xml': 'XML 文件', 'application/xml': 'XML 文件', 'text/javascript': 'JavaScript 程式碼',
  'application/javascript': 'JavaScript 程式碼', 'application/json': 'JSON 文件', 'text/x-python': 'Python 程式碼',
  'text/x-python3': 'Python 程式碼', 'application/x-shellscript': 'Shell 指令稿', 'text/x-shellscript': 'Shell 指令稿',
  'text/x-csrc': 'C 原始碼', 'text/x-c++src': 'C++ 原始碼', 'text/x-chdr': 'C 標頭檔', 'text/x-java': 'Java 原始碼',
  'text/rust': 'Rust 原始碼', 'text/x-go': 'Go 原始碼', 'application/x-yaml': 'YAML 文件', 'application/yaml': 'YAML 文件',
  'application/toml': 'TOML 設定檔', 'text/x-log': '記錄檔',
  'application/pdf': 'PDF 文件', 'application/zip': 'ZIP 壓縮檔', 'application/x-7z-compressed': '7-Zip 壓縮檔',
  'application/gzip': 'Gzip 壓縮檔', 'application/x-gzip': 'Gzip 壓縮檔', 'application/x-tar': 'Tar 封存檔',
  'application/x-compressed-tar': 'Tar 壓縮封存檔（gzip）', 'application/x-xz': 'XZ 壓縮檔', 'application/x-bzip2': 'Bzip2 壓縮檔',
  'application/vnd.rar': 'RAR 壓縮檔', 'application/x-rar': 'RAR 壓縮檔', 'application/zstd': 'Zstandard 壓縮檔',
  'application/vnd.debian.binary-package': 'Debian 套件', 'application/x-rpm': 'RPM 套件',
  'application/x-executable': '可執行檔', 'application/x-pie-executable': '可執行檔', 'application/x-sharedlib': '共用程式庫',
  'application/x-object': '目的檔', 'application/x-iso9660-image': '光碟映像檔', 'application/vnd.appimage': 'AppImage 應用程式',
  'application/x-desktop': '桌面捷徑', 'application/octet-stream': '二進位檔案', 'application/x-sqlite3': 'SQLite 資料庫',
  'application/msword': 'Word 文件', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word 文件',
  'application/vnd.ms-excel': 'Excel 試算表', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel 試算表',
  'application/vnd.ms-powerpoint': 'PowerPoint 簡報', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint 簡報',
  'application/vnd.oasis.opendocument.text': 'OpenDocument 文字文件', 'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument 試算表',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument 簡報',
  'image/png': 'PNG 圖片', 'image/jpeg': 'JPEG 圖片', 'image/gif': 'GIF 圖片', 'image/webp': 'WebP 圖片', 'image/svg+xml': 'SVG 向量圖',
  'image/bmp': 'BMP 圖片', 'image/tiff': 'TIFF 圖片', 'image/x-icon': '圖示檔', 'image/vnd.microsoft.icon': '圖示檔', 'image/heic': 'HEIC 圖片', 'image/avif': 'AVIF 圖片',
  'audio/mpeg': 'MP3 音訊', 'audio/x-wav': 'WAV 音訊', 'audio/wav': 'WAV 音訊', 'audio/flac': 'FLAC 音訊', 'audio/ogg': 'Ogg 音訊',
  'audio/x-ms-wma': 'WMA 音訊', 'audio/aac': 'AAC 音訊', 'audio/mp4': 'MPEG-4 音訊', 'audio/x-m4a': 'MPEG-4 音訊', 'audio/opus': 'Opus 音訊',
  'video/mp4': 'MP4 影片', 'video/x-matroska': 'MKV 影片', 'video/webm': 'WebM 影片', 'video/x-msvideo': 'AVI 影片',
  'video/quicktime': 'QuickTime 影片', 'video/x-ms-wmv': 'WMV 影片', 'video/mpeg': 'MPEG 影片',
  'font/ttf': 'TrueType 字型', 'font/otf': 'OpenType 字型', 'font/woff2': 'WOFF2 網頁字型',
  'inode/directory': '資料夾', 'inode/symlink': '符號連結', 'inode/x-empty': '空白檔案', 'application/x-zerosize': '空白檔案'
}
const MIME_MAJOR = { text: '文字檔', image: '圖片', audio: '音訊', video: '影片', font: '字型' }

/**
 * MIME → 給人看的說明（中文表 → gio 的說明 → 大類 → ''）
 * @param {string} mime @param {string} [gioDescription]
 */
function describeMime(mime, gioDescription = '') {
  const m = String(mime || '').toLowerCase()
  if (MIME_DESC[m]) return MIME_DESC[m]
  if (gioDescription) return gioDescription
  const major = m.split('/')[0]
  return MIME_MAJOR[major] || ''
}

/** 進行中的資料夾大小計算：token → { cancelled } */
const sizeJobs = new Map()

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 256 * 1024, env: { ...process.env, LC_ALL: 'C.UTF-8' } },
        (error, stdout) => resolve(error ? null : String(stdout)))
    } catch { resolve(null) }
  })
}

/** `gio info -a standard::content-type,standard::description` 的輸出 */
function parseGioInfo(out) {
  const text = String(out || '')
  const mime = /standard::content-type:\s*(\S+)/.exec(text)?.[1] || ''
  const description = /standard::description:\s*(.+)/.exec(text)?.[1]?.trim() || ''
  return { mime, description }
}

/**
 * @param {string} full @param {fs.Stats} st
 * @returns {Promise<{ mime: string, description: string, source: string }>}
 */
async function mimeOf(full, st) {
  if (st.isDirectory()) return { mime: 'inode/directory', description: '資料夾', source: 'stat' }
  const gio = parseGioInfo(await run('gio', ['info', '-a', 'standard::content-type,standard::description', '--', full]))
  if (gio.mime) return { ...gio, source: 'gio' }
  const file = String(await run('file', ['-b', '--mime-type', '--', full]) || '').trim()
  if (/^[\w.+-]+\/[\w.+-]+$/.test(file)) return { mime: file, description: '', source: 'file' }
  const xdg = String(await run('xdg-mime', ['query', 'filetype', full]) || '').trim()
  if (/^[\w.+-]+\/[\w.+-]+/.test(xdg)) return { mime: xdg.split(';')[0], description: '', source: 'xdg-mime' }
  const ext = path.extname(full).slice(1).toLowerCase()
  return { mime: EXT_MIME[ext] || 'application/octet-stream', description: '', source: 'extension' }
}

/** /etc/passwd、/etc/group → id → 名稱 */
function idNames(file) {
  const map = new Map()
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const [name, , id] = line.split(':')
      if (name && /^\d+$/.test(id || '')) map.set(Number(id), name)
    }
  } catch { /* 沒有就顯示數字 */ }
  return map
}

/** 0o755 → 'rwxr-xr-x'（含 setuid／setgid／sticky） */
function modeString(mode) {
  const bits = ['r', 'w', 'x']
  let out = ''
  for (let i = 8; i >= 0; i--) out += (mode & (1 << i)) ? bits[(8 - i) % 3] : '-'
  const chars = out.split('')
  if (mode & 0o4000) chars[2] = chars[2] === 'x' ? 's' : 'S'
  if (mode & 0o2000) chars[5] = chars[5] === 'x' ? 's' : 'S'
  if (mode & 0o1000) chars[8] = chars[8] === 'x' ? 't' : 'T'
  return chars.join('')
}

function iso(date) {
  const ms = date instanceof Date ? date.getTime() : NaN
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : ''
}

/**
 * 一個項目的內容。符號連結：顯示連結本身與目標；權限、大小看連結本身（chmod 只改目標，所以連結不給改）。
 * @param {unknown} target
 */
async function info(target) {
  const full = paths.resolveAbs(target)
  let lst
  try { lst = await fsp.lstat(full) } catch { throw paths.fail('NOT_FOUND', '找不到這個檔案') }
  const isLink = lst.isSymbolicLink()
  let st = lst
  let linkTarget = ''
  let linkBroken = false
  if (isLink) {
    try { linkTarget = await fsp.readlink(full) } catch { /* 讀不到 */ }
    try { st = await fsp.stat(full) } catch { linkBroken = true }
  }
  const users = idNames('/etc/passwd')
  const groups = idNames('/etc/group')
  const kind = await mimeOf(full, st)
  return {
    name: path.basename(full) || full,
    path: full,
    location: path.dirname(full),
    isDir: st.isDirectory(),
    isLink,
    linkTarget,
    linkBroken,
    mime: kind.mime,
    description: isLink && linkBroken ? '損壞的連結' : (describeMime(kind.mime, kind.description) || (st.isDirectory() ? '資料夾' : '')),
    size: st.isDirectory() ? null : lst.isSymbolicLink() && linkBroken ? lst.size : st.size,
    created: iso(lst.birthtime),
    modified: iso(lst.mtime),
    accessed: iso(lst.atime),
    changed: iso(lst.ctime),
    mode: lst.mode & 0o7777,
    modeText: modeString(lst.mode & 0o7777),
    octal: (lst.mode & 0o7777).toString(8).padStart(4, '0'),
    uid: lst.uid,
    gid: lst.gid,
    owner: users.get(lst.uid) || String(lst.uid),
    group: groups.get(lst.gid) || String(lst.gid),
    ownedByMe: typeof process.getuid === 'function' ? process.getuid() === lst.uid : false,
    canChmod: !isLink && (typeof process.getuid !== 'function' || process.getuid() === lst.uid || process.getuid() === 0)
  }
}

/**
 * 多選：每個項目的內容（最多 64 個）。
 * @param {unknown} list
 */
async function infoMany(list) {
  const items = []
  for (const target of (Array.isArray(list) ? list : []).slice(0, 64)) {
    try { items.push(await info(target)) } catch { /* 剛被刪掉的略過 */ }
  }
  if (!items.length) throw paths.fail('NOT_FOUND', '找不到這個檔案')
  return { items }
}

/**
 * 改權限。只收 0～0o7777 的整數，只改自己擁有的一般檔案／資料夾；符號連結不改（chmod 會改到目標）。
 * @param {unknown} target @param {unknown} rawMode
 */
async function chmod(target, rawMode) {
  // 字串一律當八進位（'0755'），不是八進位就拒絕；數字直接當 mode（0o755）
  const mode = typeof rawMode === 'string' ? (/^[0-7]{3,4}$/.test(rawMode) ? parseInt(rawMode, 8) : NaN) : rawMode
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw paths.fail('BAD_PATH', '權限值不合法')
  const full = paths.resolveExisting(target)
  paths.assertMutable(full)
  const lst = await fsp.lstat(full)
  if (lst.isSymbolicLink()) throw paths.fail('BAD_PATH', '符號連結的權限由目標決定，請到目標改')
  try {
    await fsp.chmod(full, mode)
  } catch (error) {
    throw paths.fail(error && error.code === 'EPERM' ? 'PROTECTED' : 'CHMOD_FAILED', error && error.code === 'EPERM' ? '沒有權限修改（不是你的檔案）' : '改不了權限')
  }
  return info(full)
}

/**
 * 遞迴大小（可取消）。不跟隨符號連結、不跨越掛載點（跟 `du -x` 一樣）。
 * @param {unknown} list 一或多個路徑
 * @param {string} token
 * @param {{ onProgress?: (p: object) => void }} [opts]
 */
async function totalSize(list, token, opts = {}) {
  const key = String(token || '').slice(0, 64)
  const job = { cancelled: false }
  if (key) { sizeJobs.get(key) && (sizeJobs.get(key).cancelled = true); sizeJobs.set(key, job) }
  const state = { bytes: 0, files: 0, dirs: 0, skipped: 0, last: 0 }
  const emit = (done) => {
    const now = Date.now()
    if (!done && now - state.last < 200) return
    state.last = now
    opts.onProgress?.({ token: key, bytes: state.bytes, files: state.files, dirs: state.dirs, skipped: state.skipped, done })
  }
  const walk = async (full, dev) => {
    if (job.cancelled) return
    let st
    try { st = await fsp.lstat(full) } catch { state.skipped += 1; return }
    // 只看資料夾的 st_dev：overlayfs 上一般檔案回報的是底層的 dev，跟所在資料夾不同
    if (dev !== null && st.isDirectory() && st.dev !== dev) return
    if (st.isDirectory()) {
      state.dirs += 1
      let kids = []
      try { kids = await fsp.readdir(full) } catch { state.skipped += 1; return }
      for (const kid of kids) await walk(path.join(full, kid), st.dev)
    } else {
      state.files += 1
      state.bytes += st.size
    }
    emit(false)
  }
  try {
    for (const target of (Array.isArray(list) ? list : [list]).slice(0, 64)) {
      await walk(paths.resolveExisting(target), null)
    }
  } finally {
    if (key && sizeJobs.get(key) === job) sizeJobs.delete(key)
  }
  emit(true)
  return { bytes: state.bytes, files: state.files, dirs: state.dirs, skipped: state.skipped, cancelled: job.cancelled }
}

/** @param {unknown} token */
function cancelSize(token) {
  const job = sizeJobs.get(String(token || '').slice(0, 64))
  if (job) job.cancelled = true
  return true
}

module.exports = { info, infoMany, chmod, totalSize, cancelSize, modeString, parseGioInfo, mimeOf, describeMime }
