'use strict'

/**
 * 從檔案頁／專案檔案樹執行 `.bat`／`.cmd`：腳本開瀏覽器的動作改開成「腳本所在專案」的瀏覽器分頁。
 *
 * - `BROWSER` 環境變數指向 AxonDeck.exe：Python `webbrowser`（Strata 的 `--open`）、Vite／CRA 的 `--open` 會照用。
 * - 腳本自己 `start "" %URL%`：跑一份改過的暫存副本（原檔不動），參數有網址或變數的 `start` 先問 AxonDeck
 *   （`--axondeck-start`）——要開的是網址就收下、開在專案；不是網址或 App 沒在跑就照原樣 `start`。
 * - 網址怎麼回到 App：第二份 AxonDeck 搶不到單一實例鎖，把命令列（含網址）與 `AXONDECK_PROJECT` 交給第一份。
 * shortcut: `if exist x start …` 這種不在指令開頭的 start、`explorer <網址>` 不改道；需要支援時改用真正的批次檔 parser。
 *   開發模式的 BROWSER 只在打包版有效（它不能帶參數）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const net = require('net')
const rawFs = require('./raw-fs').promises

const START_FLAG = '--axondeck-start'
const PROJECT_ENV = 'AXONDECK_PROJECT'
const USER_DATA_ENV = 'AXONDECK_USER_DATA'
const RUN_ENV = 'AXONDECK_SCRIPT_RUN'
const SCRIPT_RE = /\.(bat|cmd)$/i
const TEMP_DIR = path.join(os.tmpdir(), 'axondeck-scripts')

const isUrl = (a) => typeof a === 'string' && /^https?:\/\/\S+$/i.test(a)

/**
 * 命令列帶來的網址（要用**原始順序**的 `process.argv`；轉給第一份的 argv 會被 Chromium 重排、丟掉空字串）。
 * `--axondeck-start` 後面是 `start` 的原參數：只認 start 真正要開的目標（跳過 `/b` 這類開關與第一個標題參數），
 * `start cmd /c echo http://…` 不算；BROWSER 叫的就是第一個網址。
 */
function urlArg(argv) {
  const args = (argv || []).filter((a) => typeof a === 'string')
  const flag = args.indexOf(START_FLAG)
  if (flag < 0) return args.find(isUrl) || ''
  const plain = args.slice(flag + 1).filter((a) => !/^(--?|\/)\w/.test(a))
  // 標題只能是第一個；cmd 把引號拿掉了，看不出有沒有標題，就看前兩個誰是網址
  if (isUrl(plain[0])) return plain[0]
  return isUrl(plain[1]) ? plain[1] : ''
}

/** `%~dp0`、`%~nx0`、`%0`… 換成原腳本的路徑（副本在暫存資料夾，不換的話會指到那裡） */
function expandSelf(text, file, useEnv = false) {
  const parsed = path.parse(file)
  const part = { d: parsed.root.slice(0, 2), p: parsed.dir.slice(2) + path.sep, n: parsed.name, x: parsed.ext }
  return text
    .replace(/%~([fdpnx]+)0/gi, (_m, mods) => {
      const set = mods.toLowerCase()
      if (set.includes('f')) return useEnv ? '%AXONDECK_SELF_F%' : file
      return 'dpnx'.split('').filter((m) => set.includes(m)).map((m) => useEnv ? `%AXONDECK_SELF_${m.toUpperCase()}%` : part[m]).join('')
    })
    .replace(/%~0/g, useEnv ? '%AXONDECK_SELF_F%' : file)
    .replace(/(^|[^%])%0/g, `$1"${useEnv ? '%AXONDECK_SELF_F%' : file}"`)
}

/** 這一段（還沒結束的指令）裡有沒有沒關上的左括號：有的話，沒被引號包住的 `)` 就是指令結尾 */
function inParens(prefix) {
  let depth = 0
  let quoted = false
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i]
    if (ch === '^' && !quoted) i++
    else if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '(') depth++
    else if (!quoted && ch === ')') depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

/** `start` 參數到哪裡結束：沒被引號包住的 `&`、`|`，在括號裡還有 `)` */
function argsEnd(line, from, parens) {
  let quoted = false
  for (let i = from; i < line.length; i++) {
    const ch = line[i]
    if (ch === '^' && !quoted) i++
    else if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '&' || ch === '|' || (parens && ch === ')'))) return i
  }
  return line.length
}

/**
 * 指令開頭的 `start`（行首、`&`／`|`／`(` 之後、`do`／`else` 之後），參數裡有網址或變數的才改成
 * `(AxonDeck … || start …)`：App 收下回 0；不是網址（3）或 App 沒在跑（4）就照原樣 start。
 * 不用 `call :標籤`：參數裡有 `/?`（網址很常見）`call` 會改成顯示說明。
 */
function routeStart(line) {
  if (/^\s*(@?\s*rem\b|::)/i.test(line)) return line
  const re = /(^\s*@?|[&|(]\s*|\b(?:do|else)\s+)start(?=\s)/gi
  let out = ''
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const begin = m.index + m[1].length
    const end = argsEnd(line, begin + 5, inParens(line.slice(0, begin)))
    const args = line.slice(begin + 5, end)
    if (!/https?:|%[^%\s]+%|![^!\s]+!/i.test(args)) continue
    out += `${line.slice(last, begin)}(%AXONDECK_START%${args.trimEnd()} || start${args.trimEnd()})${args.slice(args.trimEnd().length)}`
    last = end
    re.lastIndex = end
  }
  return out + line.slice(last)
}

/**
 * 改寫腳本內容；路徑不適合寫進批次檔就回 null（改用原檔執行）
 * @param {string} text 以 latin1 讀進來的原始位元組（不管腳本用哪個字碼頁都原樣保留）
 * @param {string} file 原腳本的絕對路徑
 */
function rewriteBatch(text, file, useEnv = false) {
  if (!useEnv && /[^\x20-\x7e]|[%!^&]/.test(file)) return null
  return expandSelf(text, file, useEnv).split(/\r?\n/).map(routeStart).join('\r\n')
}

/** 共用啟動資料；用環境變數保留原腳本路徑，暫存副本不受中文路徑／原始字碼頁影響。 */
async function prepareLaunch(file, project, run = '') {
  const { app } = require('electron')
  const exeArgs = [...(app.isPackaged ? [] : [app.getAppPath()]), `--user-data-dir=${app.getPath('userData')}`]
  const parsed = path.parse(file)
  const env = {
    ...(app.isPackaged ? { BROWSER: process.execPath } : {}),
    [PROJECT_ENV]: project, [USER_DATA_ENV]: app.getPath('userData'), [RUN_ENV]: run,
    AXONDECK_START: [process.execPath, ...exeArgs].map((s) => `"${s}"`).concat(START_FLAG).join(' '),
    AXONDECK_SELF_F: file, AXONDECK_SELF_D: parsed.root.slice(0, 2),
    AXONDECK_SELF_P: parsed.dir.slice(2) + path.sep, AXONDECK_SELF_N: parsed.name, AXONDECK_SELF_X: parsed.ext
  }
  let target = file
  if (SCRIPT_RE.test(file)) {
    const rewritten = rewriteBatch(await rawFs.readFile(file, 'latin1'), file, true)
    await fs.promises.mkdir(TEMP_DIR, { recursive: true })
    pruneTemp()
    target = path.join(TEMP_DIR, `${require('crypto').randomUUID()}${parsed.ext}`)
    await fs.promises.writeFile(target, rewritten, 'latin1')
  }
  return { target, env, exeArgs }
}

// PowerShell 把 ‘ ’ ‚ ‛ 也當單引號，只跳脫 ' 的話路徑帶 ’ 就會斷開字串
const psQuote = (s) => `'${s.replace(/['\u2018-\u201b]/g, '$&$&')}'`

/** 給既有終端機執行；不用改 PTY 宿主的協定，也不會影響其他終端機。 */
// POSIX shell 的單引號字串：' 收成 '\''，其他字元原樣
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

/** 終端機裡設環境變數的那一段（Windows 是 PowerShell，Linux 是 bash／zsh） */
function shellAssign(key, value, platform = process.platform) {
  return platform === 'win32' ? `$env:${key}=${psQuote(value)}` : `export ${key}=${shQuote(value)}`
}

/**
 * Linux：終端機是 bash／zsh，只跑 .sh；.bat／.cmd／.ps1 是 Windows 腳本，直接回中文錯誤。
 * 腳本開出來的 dev server 網址一樣由 `watchServer` 從終端機輸出抓。
 */
async function posixTerminalCommand(file, project, run) {
  if (!/\.sh$/i.test(file)) {
    throw Object.assign(new Error('UNSUPPORTED_SCRIPT'), { userMessage: 'Linux 只能在終端機執行 .sh 腳本；.bat／.cmd／.ps1 是 Windows 腳本' })
  }
  const { target, env } = await prepareLaunch(file, project, run)
  const source = [
    ...Object.entries(env).map(([key, value]) => shellAssign(key, value, 'linux')),
    'unset ELECTRON_RUN_AS_NODE',
    `cd ${shQuote(path.dirname(file))} && bash ${shQuote(target)}`
  ].join('; ')
  watchServer(run, project)
  return source
}

async function terminalCommand(file, project, run) {
  if (!/\.(bat|cmd|ps1|sh)$/i.test(file) || /[\r\n]/.test(file)) throw new Error('不支援的啟動腳本')
  if (process.platform !== 'win32') return posixTerminalCommand(file, project, run)
  const { target, env, exeArgs } = await prepareLaunch(file, project, run)
  const open = `& ${[process.execPath, ...exeArgs, START_FLAG, ''].map(psQuote).join(' ')} $FilePath`
  const source = [
    ...Object.entries(env).map(([key, value]) => `$env:${key}=${psQuote(value)}`),
    'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    `Set-Location -LiteralPath ${psQuote(path.dirname(file))}`,
    `function Start-Process { param([string]$FilePath) if ($FilePath -match '^https?://') { ${open} } else { Microsoft.PowerShell.Management\\Start-Process -FilePath $FilePath @args } }`,
    `function Invoke-Item { param([string]$Path) if ($Path -match '^https?://') { $FilePath=$Path; ${open} } else { Microsoft.PowerShell.Management\\Invoke-Item -LiteralPath $Path @args } }`,
    `${/\.sh$/i.test(file) ? 'bash' : '&'} ${psQuote(target.replace(/\\/g, '/'))}`
  ].join('; ')
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  // 包裝寫成暫存 .ps1：-EncodedCommand 會把一整片 base64 打進使用者的終端機；BOM 讓 Windows PowerShell 認得中文路徑
  await fs.promises.mkdir(TEMP_DIR, { recursive: true })
  const wrapper = path.join(TEMP_DIR, `${require('crypto').randomUUID()}.ps1`)
  await fs.promises.writeFile(wrapper, `\ufeff${source}\r\n`, 'utf8')
  watchServer(run, project)
  return `& ${psQuote(powershell)} -NoProfile -ExecutionPolicy Bypass -File ${psQuote(wrapper)}`
}

const servers = new Map()
let openUrl = () => {}
function setOpenUrl(callback) { openUrl = callback }
function watchServer(id, project) {
  if (servers.has(id)) clearTimeout(servers.get(id).timer)
  const entry = { project, buffer: '', opened: new Set(), timer: setTimeout(() => servers.delete(id), 300_000) }
  entry.timer.unref()
  servers.set(id, entry)
}

/** 只認本機服務；0.0.0.0／[::] 是監聽位址，瀏覽時換成 loopback。 */
function serverUrl(text) {
  const clean = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const found = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?=\/|[\s"'<>]|$)(?:\/[^\s"'<>]*)?/i.exec(clean)?.[0]
  if (!found) return ''
  try {
    const url = new URL(found)
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
    if (url.hostname === '[::]') url.hostname = '[::1]'
    return url.href
  } catch { return '' }
}

function listening(url) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })
    const done = (ok) => { socket.destroy(); resolve(ok) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

async function openScriptUrl(url, project, run = '') {
  const entry = servers.get(run)
  const local = serverUrl(url)
  const href = local || url
  if (entry?.opened.has(href)) return
  entry?.opened.add(href)
  if (local) {
    const deadline = Date.now() + 30_000
    while (!(await listening(new URL(local)))) {
      if (Date.now() >= deadline || (entry && servers.get(run) !== entry)) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  openUrl(href, entry?.project || project)
}

/** 只看本次啟動腳本的輸出；分塊／彩色日誌也能找到 URL，一支服務只自動開一頁。 */
function noteTerminal(event, payload) {
  const entry = servers.get(payload?.id)
  if (!entry) return
  if (event === 'terminal:exit' || (event === 'terminal:status' && payload.state === 'exited')) {
    clearTimeout(entry.timer); servers.delete(payload.id); return
  }
  if (event !== 'terminal:data' || entry.detected) return
  entry.buffer = (entry.buffer + payload.data).slice(-8192)
  const end = entry.buffer.lastIndexOf('\n')
  if (end < 0) return
  const url = serverUrl(entry.buffer.slice(0, end))
  entry.buffer = entry.buffer.slice(end + 1)
  if (!url) return
  entry.detected = true
  void openScriptUrl(url, entry.project, payload.id)
}

/** 暫存副本放一天後清（腳本可能還在跑，不能一啟動就刪） */
function pruneTemp() {
  try {
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const full = path.join(TEMP_DIR, name)
      if (Date.now() - fs.statSync(full).mtimeMs > 86_400_000) fs.rmSync(full, { force: true })
    }
  } catch { /* 資料夾還沒建 */ }
}

/**
 * 有專案的腳本由這裡啟動（新主控台視窗，跟在檔案總管雙擊一樣）；回 false 表示交回原本的開法
 * @param {string} file 絕對路徑
 */
async function launchScript(file) {
  if (process.platform !== 'win32' || !SCRIPT_RE.test(file)) return false
  const project = projectIdOf(await require('./workspace/store').list(), file)
  if (!project) return false
  const { target, env: scriptEnv } = await prepareLaunch(file, project)
  const quote = (s) => `"${s}"`
  const env = {
    ...process.env,
    ...scriptEnv
  }
  delete env.ELECTRON_RUN_AS_NODE
  // cmd 自己的引號規則：/s /c "…整段…"，路徑有空白也不會被拆
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quote(target)}"`], {
    cwd: path.dirname(file), env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true
  })
  child.on('error', (error) => console.warn('[script-launch] 啟動失敗:', error?.message))
  child.unref()
  return true
}

/**
 * 路徑屬於哪個專案（最長的根目錄優先，不分大小寫）；不在任何專案裡回空字串
 * @param {Array<{ id: string, path: string }>} projects
 * @param {string} file
 */
function projectIdOf(projects, file) {
  const norm = (p) => path.resolve(p).toLowerCase()
  // 磁碟根（`d:\`）本身就以分隔符結尾，不能再補一個
  const prefix = (p) => (norm(p).endsWith(path.sep) ? norm(p) : norm(p) + path.sep)
  const target = norm(file)
  const hit = projects
    .filter((p) => p?.path && (target.startsWith(prefix(p.path)) || target === norm(p.path)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return hit?.id || ''
}

/** 第一份收到的轉交 argv：第二份已用原始命令列把關過，這裡只取第一個網址 */
const forwardedUrl = (argv) => (argv || []).find(isUrl) || ''

module.exports = { shQuote, shellAssign, START_FLAG, PROJECT_ENV, USER_DATA_ENV, RUN_ENV, urlArg, forwardedUrl, rewriteBatch, launchScript, projectIdOf,
  terminalCommand, psQuote, setOpenUrl, openScriptUrl, noteTerminal, serverUrl }
