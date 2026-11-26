'use strict'

/**
 * Linux 檔案關聯：寫使用者層的 .desktop、MIME 與 mimeapps.list 預設值，
 * 對應 Windows 側邊程式對媒體／文字檔的登記。不覆寫使用者已經指定的預設程式。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const MARKER = 'linux-associations-1'
const DESKTOP_ID = 'axondeck.desktop'

/** 副檔名 → MIME（常見類型；沒列到的用 application/x-extension-<ext>） */
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', apng: 'image/apng', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', qt: 'video/quicktime',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', wave: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus', oga: 'audio/ogg',
  ogg: 'audio/ogg', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
  m3u: 'audio/x-mpegurl', m3u8: 'application/vnd.apple.mpegurl', pls: 'audio/x-scpls',
  cue: 'application/x-cue',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', csv: 'text/csv', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  py: 'text/x-python', rs: 'text/rust', go: 'text/x-go',
  c: 'text/x-csrc', h: 'text/x-chdr', cpp: 'text/x-c++src', cc: 'text/x-c++src',
  hpp: 'text/x-c++hdr', java: 'text/x-java', kt: 'text/x-kotlin',
  sh: 'application/x-shellscript', bash: 'application/x-shellscript',
  yml: 'application/x-yaml', yaml: 'application/x-yaml', toml: 'application/toml',
  ini: 'text/plain', log: 'text/plain', conf: 'text/plain',
  sql: 'application/sql', graphql: 'text/plain',
  vue: 'text/plain', svelte: 'text/plain',
  tex: 'text/x-tex', rtf: 'application/rtf',
  zip: 'application/zip', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', tar: 'application/x-tar', gz: 'application/gzip',
  desktop: 'application/x-desktop'
}

function mimeOf(ext) {
  const key = String(ext || '').replace(/^\./, '').toLowerCase()
  return MIME_BY_EXT[key] || (key ? `application/x-extension-${key}` : '')
}

function uniqueMimes(exts) {
  const seen = new Set()
  const out = []
  for (const ext of exts) {
    const mime = mimeOf(ext)
    if (mime && !seen.has(mime)) { seen.add(mime); out.push(mime) }
  }
  return out
}

function desktopEntry({ exec, mimes, icon }) {
  const mimeLine = mimes.join(';') + (mimes.length ? ';' : '')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=AxonDeck',
    'Comment=AxonDeck',
    'StartupWMClass=axondeck',
    `Exec=${exec} %U`,
    icon ? `Icon=${icon}` : 'Icon=axondeck',
    'Terminal=false',
    'Categories=Utility;AudioVideo;TextEditor;',
    'MimeType=' + mimeLine,
    'X-AxonDeck-Integration=1',
    ''
  ].join('\n')
}

function quoteExec(file) {
  if (!file) return 'axondeck'
  return /[\s"'$]/.test(file) ? `"${String(file).replace(/"/g, '\\"')}"` : file
}

function defaultExec(env = process.env) {
  if (env.APPIMAGE) return quoteExec(env.APPIMAGE)
  return quoteExec(process.execPath)
}

function userDirs(home = os.homedir()) {
  const applications = path.join(home, '.local/share/applications')
  const mimeapps = path.join(home, '.config/mimeapps.list')
  return { applications, desktop: path.join(applications, DESKTOP_ID), mimeapps }
}

/** 只補還沒指定預設程式的 MIME，不搶走使用者已選的程式。 */
function mergeMimeapps(existing, id, mimes, defaults) {
  const text = String(existing || '')
  const hasSection = /\[Default Applications\]/.test(text)
  const already = new Set()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^#=\s][^=]*)=/.exec(line)
    if (m) already.add(m[1].trim())
  }
  const additions = mimes.filter((mime) => !already.has(mime) && (!defaults || !defaults[mime]))
  if (!additions.length) return { text, added: [] }
  const lines = additions.map((mime) => `${mime}=${id}`)
  if (hasSection) {
    return { text: text.replace(/\[Default Applications\]/, (s) => `${s}\n${lines.join('\n')}`), added: additions }
  }
  const prefix = text && !text.endsWith('\n') ? text + '\n' : text
  return { text: `${prefix}[Default Applications]\n${lines.join('\n')}\n`, added: additions }
}

function queryDefault(mime, spawnSyncFn = spawnSync, env = process.env) {
  try {
    const result = spawnSyncFn('xdg-mime', ['query', 'default', mime], {
      timeout: 3000, encoding: 'utf8', env, windowsHide: true
    })
    return result && result.status === 0 ? String(result.stdout || '').trim() : ''
  } catch {
    return ''
  }
}

/**
 * @param {{
 *   isPackaged?: boolean, isPreview?: boolean, userDataPath?: string, home?: string,
 *   execPath?: string, icon?: string, exts?: string[], env?: NodeJS.ProcessEnv,
 *   spawnSyncFn?: typeof spawnSync, write?: boolean
 * }} [opts]
 */
function install(opts = {}) {
  if (process.platform === 'win32') return { installed: false, reason: 'windows' }
  if (opts.isPreview) return { installed: false, reason: 'preview' }
  if (opts.isPackaged === false) return { installed: false, reason: 'unpackaged' }
  const userData = opts.userDataPath
  const marker = userData ? path.join(userData, 'linux-associations-initialized') : ''
  if (marker && opts.write !== false) {
    try {
      if (fs.readFileSync(marker, 'utf8').trim() === MARKER) return { installed: false, reason: 'already' }
    } catch { /* 還沒寫過 */ }
  }
  const formats = opts.exts || mediaAndEditorExts()
  const mimes = uniqueMimes(formats)
  const exec = opts.execPath || defaultExec(opts.env)
  const dirs = userDirs(opts.home)
  const desktop = desktopEntry({ exec, mimes, icon: opts.icon })
  const defaults = {}
  const spawnSyncFn = opts.spawnSyncFn || spawnSync
  for (const mime of mimes) {
    const current = queryDefault(mime, spawnSyncFn, opts.env)
    if (current) defaults[mime] = current
  }
  let existing = ''
  try { existing = fs.readFileSync(dirs.mimeapps, 'utf8') } catch { /* 沒有就新建 */ }
  const merged = mergeMimeapps(existing, DESKTOP_ID, mimes, defaults)
  if (opts.write === false) {
    return { installed: false, reason: 'dry-run', desktop, mimeapps: merged.text, added: merged.added, mimes, dirs }
  }
  fs.mkdirSync(dirs.applications, { recursive: true })
  fs.mkdirSync(path.dirname(dirs.mimeapps), { recursive: true })
  if (userData) fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(dirs.desktop, desktop, { mode: 0o644 })
  fs.writeFileSync(dirs.mimeapps, merged.text, { mode: 0o644 })
  if (marker) fs.writeFileSync(marker, MARKER, 'utf8')
  try { spawnSyncFn('update-desktop-database', [dirs.applications], { timeout: 5000, windowsHide: true }) } catch { /* 沒裝也沒關係 */ }
  return { installed: true, added: merged.added, mimes, dirs }
}


const INTEGRATION_MARKER = 'X-AxonDeck-Integration=1'

/**
 * 解析 user-dirs.dirs 的桌面路徑；沒有就用 ~/Desktop。
 * @param {string} [home]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(file: string, enc: string) => string} [readFileSync]
 */
function desktopFolder(home = os.homedir(), env = process.env, readFileSync = fs.readFileSync) {
  if (env.XDG_DESKTOP_DIR) return env.XDG_DESKTOP_DIR.replace(/^\$HOME/, home)
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs')
  try {
    const text = readFileSync(file, 'utf8')
    const m = /^XDG_DESKTOP_DIR=(?:"([^"]+)"|(\S+))/m.exec(text)
    if (m) return (m[1] || m[2]).replace(/^\$HOME/, home)
  } catch { /* 沒有 user-dirs.dirs */ }
  return path.join(home, 'Desktop')
}

function isOurDesktop(text) {
  return typeof text === 'string' && (text.includes(INTEGRATION_MARKER) || /^Name=AxonDeck$/m.test(text))
}

/**
 * 在使用者桌面放一份捷徑（不覆蓋別人的同名檔，除非是我們寫過的）。
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, execPath?: string, icon?: string, write?: boolean }} [opts]
 */
function installDesktopShortcut(opts = {}) {
  if (process.platform === 'win32') return { installed: false, reason: 'windows' }
  const home = opts.home || os.homedir()
  const folder = desktopFolder(home, opts.env)
  const dest = path.join(folder, DESKTOP_ID)
  const exec = opts.execPath || defaultExec(opts.env)
  const body = desktopEntry({ exec, mimes: [], icon: opts.icon })
  if (opts.write === false) return { installed: false, reason: 'dry-run', dest, desktop: body }
  try {
    const existing = fs.readFileSync(dest, 'utf8')
    if (existing && !isOurDesktop(existing)) return { installed: false, reason: 'exists', dest }
  } catch { /* 沒有就新建 */ }
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(dest, body, { mode: 0o644 })
  try { fs.chmodSync(dest, 0o755) } catch { /* 有的桌面要可執行才認捷徑 */ }
  return { installed: true, dest }
}

function stripMimeapps(text, id) {
  const needle = `=${id}`
  const kept = String(text || '').split(/\r?\n/).filter((line) => !line.includes(needle) || line.trim().startsWith('#'))
  let out = kept.join('\n')
  if (out && !out.endsWith('\n')) out += '\n'
  return out
}

/**
 * 移除我們寫過的使用者層整合：應用程式選單捷徑、桌面捷徑、mimeapps 裡指向我們的預設值。
 * 不刪使用者資料或系統套件。
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, userDataPath?: string }} [opts]
 */
function removeUserIntegration(opts = {}) {
  if (process.platform === 'win32') return { removed: false, reason: 'windows' }
  const home = opts.home || os.homedir()
  const dirs = userDirs(home)
  const removed = []
  const tryUnlink = (file) => {
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (!isOurDesktop(text)) return
      fs.unlinkSync(file)
      removed.push(file)
    } catch { /* 沒有或不是我們的 */ }
  }
  tryUnlink(dirs.desktop)
  tryUnlink(path.join(desktopFolder(home, opts.env), DESKTOP_ID))
  try {
    const current = fs.readFileSync(dirs.mimeapps, 'utf8')
    const next = stripMimeapps(current, DESKTOP_ID)
    if (next !== current) {
      fs.writeFileSync(dirs.mimeapps, next, { mode: 0o644 })
      removed.push(dirs.mimeapps)
    }
  } catch { /* 沒有 mimeapps */ }
  if (opts.userDataPath) {
    try { fs.unlinkSync(path.join(opts.userDataPath, 'linux-associations-initialized')) } catch { /* 沒有標記 */ }
  }
  try { require('./linux-autostart').remove({ env: { ...process.env, HOME: home, ...(opts.env || {}) } }) } catch { /* 這支 PR 不一定疊到 autostart */ }
  return { removed: true, files: removed }
}

function mediaAndEditorExts() {
  let media = []
  try {
    const formats = require('./media-formats.json')
    media = Object.values(formats).flat()
  } catch { /* 單元測試可注入 exts */ }
  const editor = ['txt', 'md', 'markdown', 'json', 'csv', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs',
    'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'cc', 'hpp', 'java', 'kt', 'sh', 'bash',
    'yml', 'yaml', 'toml', 'ini', 'log', 'conf', 'sql', 'vue', 'svelte', 'tex', 'rtf', 'desktop']
  return [...new Set([...media, ...editor])]
}

module.exports = {
  MARKER, DESKTOP_ID, INTEGRATION_MARKER, MIME_BY_EXT, mimeOf, uniqueMimes, desktopEntry, mergeMimeapps,
  queryDefault, install, mediaAndEditorExts, userDirs, defaultExec,
  desktopFolder, installDesktopShortcut, removeUserIntegration, stripMimeapps
}
