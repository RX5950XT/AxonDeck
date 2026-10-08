'use strict'

/**
 * Linux 的「開啟方式…」與「在這裡開啟終端機」。
 *
 * 應用程式清單：`gio mime <type>`（含系統預設與推薦）→ 讀 XDG `mimeinfo.cache`／`mimeapps.list`。
 * 每個 .desktop 讀 Name（優先 zh_TW → zh → 預設）、Exec、NoDisplay／Hidden、Terminal。
 * 啟動：`gio launch` → `gtk-launch` → 自己依桌面項目規格解析 Exec（陣列參數，不經過 shell）。
 */

const { execFile, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const EXEC_TIMEOUT_MS = 3000
const MAX_APPS = 24
const DESKTOP_ID = /^[\w.+-]+\.desktop$/

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 512 * 1024 },
        (error, stdout) => resolve(error ? null : String(stdout)))
    } catch { resolve(null) }
  })
}

function runDetached(file, args, cwd) {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', shell: false })
      child.once('error', () => resolve(false))
      child.once('spawn', () => { child.unref(); resolve(true) })
    } catch { resolve(false) }
  })
}

/** XDG 應用程式資料夾，使用者的優先 */
function appDirs(env = process.env) {
  const home = env.HOME || os.homedir()
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  const extra = [path.join(home, '.local/share/flatpak/exports/share'), '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop']
  return [...new Set([dataHome, ...dataDirs, ...extra].map((d) => path.join(d, 'applications')))]
}

/** 解析 .desktop 的 [Desktop Entry] 區段（只取需要的鍵） */
function parseDesktop(text, locale = 'zh_TW') {
  const entry = {}
  let inMain = false
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) { inMain = line === '[Desktop Entry]'; continue }
    if (!inMain) continue
    const eq = line.indexOf('=')
    if (eq > 0) entry[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const lang = String(locale).split('.')[0]
  const name = entry[`Name[${lang}]`] || entry[`Name[${lang.split('_')[0]}]`] || entry.Name || ''
  return {
    name,
    exec: entry.Exec || '',
    icon: entry.Icon || '',
    terminal: /^true$/i.test(entry.Terminal || ''),
    hidden: /^true$/i.test(entry.NoDisplay || '') || /^true$/i.test(entry.Hidden || ''),
    type: entry.Type || 'Application',
    mimeTypes: (entry.MimeType || '').split(';').filter(Boolean)
  }
}

/** 找某個 desktop id 的檔案（`org.gnome.Foo.desktop`；子資料夾 id 用 `-` 連接） */
function findDesktopFile(id, dirs = appDirs()) {
  if (!DESKTOP_ID.test(id)) return ''
  for (const dir of dirs) {
    const direct = path.join(dir, id)
    if (fs.existsSync(direct)) return direct
    const nested = path.join(dir, ...id.split('-'))
    if (id.includes('-') && fs.existsSync(nested)) return nested
  }
  return ''
}

/** `gio mime text/plain` 的輸出 → { defaultId, ids } */
function parseGioMime(out) {
  const text = String(out || '')
  const defaultId = /Default application for “?[^”"\n]*”?:\s*(\S+\.desktop)/.exec(text)?.[1] || /:\s*(\S+\.desktop)\s*$/m.exec(text.split('\n')[0] || '')?.[1] || ''
  const ids = [...text.matchAll(/^\s+(\S+\.desktop)\s*$/gm)].map((m) => m[1])
  return { defaultId, ids: [...new Set([defaultId, ...ids].filter(Boolean))] }
}

/** mimeinfo.cache／mimeapps.list 裡跟這個 MIME 有關的 desktop id */
function idsFromCaches(mime, dirs = appDirs(), env = process.env) {
  const ids = []
  const removed = new Set()
  const home = env.HOME || os.homedir()
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const lists = [path.join(configHome, 'mimeapps.list'), ...dirs.map((d) => path.join(d, 'mimeapps.list')), ...dirs.map((d) => path.join(d, 'mimeinfo.cache'))]
  let defaultId = ''
  for (const file of lists) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    let section = ''
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('[')) { section = line; continue }
      if (!line.startsWith(`${mime}=`)) continue
      const values = line.slice(mime.length + 1).split(';').filter(Boolean)
      if (section === '[Removed Associations]') values.forEach((v) => removed.add(v))
      else {
        if (section === '[Default Applications]' && !defaultId) defaultId = values[0] || ''
        ids.push(...values)
      }
    }
  }
  return { defaultId, ids: [...new Set([defaultId, ...ids].filter((id) => id && !removed.has(id)))] }
}

/**
 * 能開這個 MIME 的應用程式。
 * @param {string} mime
 * @returns {Promise<{ id: string, name: string, isDefault: boolean, terminal: boolean }[]>}
 */
async function appsFor(mime, opts = {}) {
  const dirs = opts.dirs || appDirs()
  const fromGio = opts.skipGio ? { defaultId: '', ids: [] } : parseGioMime(await run('gio', ['mime', mime]))
  const fromCache = idsFromCaches(mime, dirs, opts.env)
  let defaultId = fromGio.defaultId || fromCache.defaultId
  if (!defaultId && !opts.skipGio) defaultId = String(await run('xdg-mime', ['query', 'default', mime]) || '').trim()
  const ids = [...new Set([defaultId, ...fromGio.ids, ...fromCache.ids].filter((id) => DESKTOP_ID.test(id || '')))]
  const apps = []
  for (const id of ids) {
    const file = findDesktopFile(id, dirs)
    if (!file) continue
    let entry
    try { entry = parseDesktop(fs.readFileSync(file, 'utf8'), opts.locale || process.env.LANG || 'zh_TW') } catch { continue }
    if (!entry.name || !entry.exec || entry.type !== 'Application') continue
    if (entry.hidden && id !== defaultId) continue
    apps.push({ id, name: entry.name, isDefault: id === defaultId, terminal: entry.terminal, file })
    if (apps.length >= MAX_APPS) break
  }
  return apps
}

/** 依桌面項目規格切 Exec（雙引號內 `\"` `\`` `\$` `\\` 跳脫） */
function splitExec(exec) {
  const args = []
  let cur = ''
  let quoted = false
  let has = false
  const s = String(exec)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) { cur += s[++i]; continue }
      if (ch === '"') { quoted = false; continue }
      cur += ch
    } else if (ch === '"') { quoted = true; has = true } else if (/\s/.test(ch)) {
      if (cur || has) args.push(cur)
      cur = ''
      has = false
    } else cur += ch
  }
  if (cur || has) args.push(cur)
  return args
}

/**
 * 把 Exec 展開成 argv：`%f`／`%u` 一個檔、`%F`／`%U` 全部，`%i %c %k` 等丟掉，`%%` → `%`。
 * 沒有任何檔案欄位時把檔案接在最後（規格允許的行為）。
 */
function expandExec(exec, files) {
  const uris = files.map((f) => pathToFileURL(f).href)
  const out = []
  let used = false
  for (const arg of splitExec(exec)) {
    if (arg === '%F' || arg === '%U') { out.push(...(arg === '%F' ? files : uris)); used = true; continue }
    if (arg === '%f' || arg === '%u') { if (files[0]) out.push(arg === '%f' ? files[0] : uris[0]); used = true; continue }
    if (/^%[ickdDnNvm]$/.test(arg)) continue
    const replaced = arg.replace(/%([fFuU%])/g, (m, c) => {
      if (c === '%') return '%'
      used = true
      return c === 'f' || c === 'F' ? (files[0] || '') : (uris[0] || '')
    }).replace(/%[ickdDnNvm]/g, '')
    if (replaced) out.push(replaced)
  }
  if (!used) out.push(...files)
  return out
}

/**
 * 用某個應用程式開啟檔案。
 * @param {string} id desktop id
 * @param {string[]} files 已驗證的絕對路徑
 */
async function launch(id, files, opts = {}) {
  if (!DESKTOP_ID.test(String(id))) return false
  const list = files.slice(0, 32)
  if (!opts.skipGio && await runQuiet('gio', ['launch', findDesktopFile(id) || id, ...list])) return true
  if (!opts.skipGio && await runQuiet('gtk-launch', [id.replace(/\.desktop$/, ''), ...list])) return true
  const file = findDesktopFile(id, opts.dirs)
  if (!file) return false
  let entry
  try { entry = parseDesktop(fs.readFileSync(file, 'utf8')) } catch { return false }
  const argv = expandExec(entry.exec, list)
  if (!argv.length) return false
  if (entry.terminal) return openTerminal(path.dirname(list[0] || os.homedir()), { command: argv })
  return (opts.spawnDetached || runDetached)(argv[0], argv.slice(1), path.dirname(list[0] || os.homedir()))
}

/** gio launch／gtk-launch 啟動後會自己結束；結束碼 0 才算成功 */
function runQuiet(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10_000 }, (error) => resolve(!error))
    } catch { resolve(false) }
  })
}

/** 已知終端機：程式名 → 設定工作目錄的參數、執行指令的參數 */
const TERMINALS = [
  { exe: 'x-terminal-emulator', cwdArgs: () => [], execFlag: '-e' },
  { exe: 'ptyxis', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '--', desktops: ['GNOME'] },
  { exe: 'kgx', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '--', desktops: ['GNOME'] },
  { exe: 'gnome-terminal', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '--', desktops: ['GNOME', 'Unity'] },
  { exe: 'konsole', cwdArgs: (d) => ['--workdir', d], execFlag: '-e', desktops: ['KDE'] },
  { exe: 'xfce4-terminal', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '-x', desktops: ['XFCE'] },
  { exe: 'mate-terminal', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '-x', desktops: ['MATE'] },
  { exe: 'lxterminal', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '-e', desktops: ['LXDE', 'LXQt'] },
  { exe: 'qterminal', cwdArgs: (d) => ['-w', d], execFlag: '-e', desktops: ['LXQt'] },
  { exe: 'tilix', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '-e' },
  { exe: 'kitty', cwdArgs: (d) => ['--directory', d], execFlag: '' },
  { exe: 'alacritty', cwdArgs: (d) => ['--working-directory', d], execFlag: '-e' },
  { exe: 'wezterm', cwdArgs: (d) => ['start', '--cwd', d], execFlag: '--' },
  { exe: 'foot', cwdArgs: (d) => [`--working-directory=${d}`], execFlag: '' },
  { exe: 'xterm', cwdArgs: () => [], execFlag: '-e' }
]

function onPath(name, env = process.env) {
  return String(env.PATH || '').split(':').filter(Boolean).some((dir) => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true } catch { return false }
  })
}

/** 依桌面環境排序可用的終端機（目前桌面專屬的放前面，其次 x-terminal-emulator） */
function terminalCandidates(env = process.env) {
  const desktops = String(env.XDG_CURRENT_DESKTOP || '').split(':').map((d) => d.trim()).filter(Boolean)
  const native = TERMINALS.filter((t) => t.desktops && t.desktops.some((d) => desktops.includes(d)))
  const ordered = [...native, ...TERMINALS.filter((t) => !native.includes(t))]
  return ordered.filter((t) => onPath(t.exe, env))
}

/**
 * 在資料夾開終端機（spawn 的 cwd 也設好，不認得參數的終端機也會落在那裡）。
 * @param {string} dir 已驗證的資料夾
 * @param {{ command?: string[], env?: NodeJS.ProcessEnv, spawnDetached?: Function }} [opts]
 * @returns {Promise<string>} 用了哪支終端機；都沒有回空字串
 */
async function openTerminal(dir, opts = {}) {
  const spawnDetached = opts.spawnDetached || runDetached
  for (const term of terminalCandidates(opts.env)) {
    const args = [...term.cwdArgs(dir)]
    if (opts.command && opts.command.length) {
      if (term.execFlag) args.push(term.execFlag)
      args.push(...opts.command)
    }
    if (await spawnDetached(term.exe, args, dir)) return term.exe
  }
  return ''
}

module.exports = {
  appDirs,
  parseDesktop,
  parseGioMime,
  idsFromCaches,
  findDesktopFile,
  appsFor,
  splitExec,
  expandExec,
  launch,
  terminalCandidates,
  openTerminal
}
