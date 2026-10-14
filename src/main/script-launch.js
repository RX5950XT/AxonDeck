'use strict'

/**
 * 從檔案頁／專案檔案樹執行 `.bat`／`.cmd`：腳本開瀏覽器的動作改開成「腳本所在專案」的瀏覽器分頁。
 *
 * - `BROWSER` 環境變數指向 AxonDeck.exe：Python `webbrowser`（Strata 的 `--open`）、Vite／CRA 的 `--open` 會照用。
 * - 腳本自己 `start "" %URL%`：跑一份改過的暫存副本（原檔不動），參數有網址或變數的 `start` 先問 AxonDeck
 *   （`--axondeck-start`）——要開的是網址就收下、開在專案；不是網址或 App 沒在跑就照原樣 `start`。
 * - 網址怎麼回到 App：第二份 AxonDeck 搶不到單一實例鎖，把命令列（含網址）與 `AXONDECK_PROJECT` 交給第一份。
 * shortcut: `if exist x start …` 這種不在指令開頭的 start、`explorer <網址>` 不改道；路徑含非 ASCII 或 %!^&
 *   就不改寫（照舊開系統瀏覽器，BROWSER 仍有效）；開發模式的 BROWSER 只在打包版有效（它不能帶參數）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const START_FLAG = '--axondeck-start'
const PROJECT_ENV = 'AXONDECK_PROJECT'
const USER_DATA_ENV = 'AXONDECK_USER_DATA'
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
function expandSelf(text, file) {
  const parsed = path.parse(file)
  const part = { d: parsed.root.slice(0, 2), p: parsed.dir.slice(2) + path.sep, n: parsed.name, x: parsed.ext }
  return text
    .replace(/%~([fdpnx]+)0/gi, (_m, mods) => {
      const set = mods.toLowerCase()
      if (set.includes('f')) return file
      return 'dpnx'.split('').filter((m) => set.includes(m)).map((m) => part[m]).join('')
    })
    .replace(/%~0/g, file)
    .replace(/(^|[^%])%0/g, `$1"${file}"`)
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
function rewriteBatch(text, file) {
  if (/[^\x20-\x7e]|[%!^&]/.test(file)) return null
  return expandSelf(text, file).split(/\r?\n/).map(routeStart).join('\r\n')
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
  const { app } = require('electron')
  const exe = process.execPath
  // 第二份 AxonDeck 要搶「同一把」單一實例鎖才會交給這份：帶同一個 userData；開發模式還要帶 App 路徑
  const exeArgs = [...(app.isPackaged ? [] : [app.getAppPath()]), `--user-data-dir=${app.getPath('userData')}`]
  let target = file
  const rewritten = rewriteBatch(fs.readFileSync(file, 'latin1'), file)
  if (rewritten) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
    pruneTemp()
    target = path.join(TEMP_DIR, `${path.parse(file).name}-${Date.now()}${path.extname(file)}`)
    fs.writeFileSync(target, rewritten, 'latin1')
  }
  const quote = (s) => `"${s}"`
  const env = {
    ...process.env,
    // BROWSER 只能是一個執行檔（不能帶參數），開發模式的 electron.exe 不能直接當瀏覽器
    ...(app.isPackaged ? { BROWSER: exe } : {}),
    [PROJECT_ENV]: project,
    [USER_DATA_ENV]: app.getPath('userData'),
    AXONDECK_START: [quote(exe), ...exeArgs.map(quote), START_FLAG].join(' ')
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
  const target = norm(file)
  const hit = projects
    .filter((p) => p?.path && (target.startsWith(norm(p.path) + path.sep) || target === norm(p.path)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return hit?.id || ''
}

/** 第一份收到的轉交 argv：第二份已用原始命令列把關過，這裡只取第一個網址 */
const forwardedUrl = (argv) => (argv || []).find(isUrl) || ''

module.exports = { START_FLAG, PROJECT_ENV, USER_DATA_ENV, urlArg, forwardedUrl, rewriteBatch, launchScript, projectIdOf }
