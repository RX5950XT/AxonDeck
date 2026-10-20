'use strict'

/**
 * 5 小時窗口預熱（參考 magpie `provider/warmup_daily.go`、`gateway/claude_warmup.go`）。
 *
 * 5 小時窗口從「第一個請求」才開始算：早上 9 點才開工，一天只塞得下兩輪；6 點先送一句，
 * 11 點就重置，一天多一輪。到了使用者設定的時間點、這個帳號的 5 小時窗口沒在跑，就用官方 CLI
 * 送一句最小的「hi」。每個時間點一天只送一次（記號存檔，重開 App 不會再送）；電腦睡過頭
 * 超過 `SLACK_MS` 就放掉，晚好幾小時才開的窗口不是使用者要的。
 *
 * 只預熱 CLI 目前登入的那個帳號（Claude 多帳號的其他帳號不碰，換帳號要動憑證檔）。
 */

const { spawn } = require('child_process')
const fsp = require('fs').promises

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const MAX_TIMES = 4
const SLACK_MS = 3600_000
const WINDOW_MS = 5 * 3600_000
const RUN_TIMEOUT_MS = 120_000

/** 設定裡的時間清單：`HH:MM`、去重、排序、最多四個 */
function sanitizeTimes(raw) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((t) => typeof t === 'string' && TIME_RE.test(t)))].sort().slice(0, MAX_TIMES)
}

/**
 * 最近一個已經到了的時間點（今天或昨天的同一時刻），晚超過 `SLACK_MS` 就不算。
 * @returns {number | null}
 */
function dueSlot(times, nowMs) {
  let latest = null
  for (const t of sanitizeTimes(times)) {
    const [h, m] = t.split(':').map(Number)
    const at = new Date(nowMs)
    at.setHours(h, m, 0, 0)
    if (at.getTime() > nowMs) at.setDate(at.getDate() - 1)
    if (latest === null || at.getTime() > latest) latest = at.getTime()
  }
  return latest !== null && nowMs - latest <= SLACK_MS ? latest : null
}

/** 記號：本地日期＋時刻，一天的每個時間點各一次 */
function slotKey(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 這張卡的 5 小時窗口有沒有在跑。只信剛從官方 API 讀到的（`available`），讀不到就當不知道、不送。
 * Claude 從沒用過時沒有這格；Codex 閒置時重置時間永遠是「現在＋整整 5 小時」。
 * @returns {boolean | null} true＝沒在跑該送；false＝在跑；null＝不知道
 */
function windowIdle(account, windowId, nowMs) {
  if (account?.status !== 'available') return null
  const win = (account.windows || []).find((w) => w.id === windowId)
  if (!win) return true
  const reset = Date.parse(win.resetAt)
  if (!Number.isFinite(reset) || reset <= nowMs) return true
  return win.used === 0 && reset - nowMs >= WINDOW_MS - 10 * 60_000
}

/** 不帶使用者的 hooks、MCP、工具，也不留對話紀錄；用最便宜的 Haiku */
const COMMANDS = Object.freeze({
  claude: { command: 'claude', args: ['-p', '--output-format', 'json', '--model', 'haiku', '--tools', '',
    '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'], input: 'hi' },
  // Codex exec 沒有不留紀錄的開關；關掉 MCP 免得為一句 hi 把使用者的 MCP 伺服器全開起來
  codex: { command: 'codex', args: ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort="low"',
    '-c', 'mcp_servers={}', 'hi'], input: '' }
})

/**
 * 用官方 CLI 送一句 hi。成功＝程序 0 結束；失敗只回固定代碼（輸出可能帶帳號資訊，不外傳）。
 * 工作目錄固定一個：Claude 就算不留紀錄，也會替每個新目錄建 `projects/<目錄>/memory/`，
 * 每次換暫存目錄就會越積越多空資料夾。
 * @param {'claude' | 'codex'} agent
 * @param {{ launch: Function, withPath: Function, cwd: string, spawnImpl?: Function }} deps
 */
async function warm(agent, { launch, withPath, cwd, spawnImpl = spawn }) {
  const spec = COMMANDS[agent]
  if (!spec) throw new Error('BAD_AGENT')
  // 在 Claude Code 裡開 App 時會繼承這些，會讓子 CLI 以為自己是被代跑的
  const env = withPath(Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDECODE$|^CLAUDE_CODE_/i.test(k))))
  await fsp.mkdir(cwd, { recursive: true })
  const target = await launch({ command: spec.command, args: spec.args }, env)
  await new Promise((resolve, reject) => {
    const child = spawnImpl(target.command, target.args, { ...target.options, env, cwd, shell: false, windowsHide: true,
      stdio: [spec.input ? 'pipe' : 'ignore', 'ignore', 'ignore'] })
    const timer = setTimeout(() => { child.kill(); reject(new Error('WARM_TIMEOUT')) }, RUN_TIMEOUT_MS)
    child.once('error', () => { clearTimeout(timer); reject(new Error('WARM_START')) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('WARM_FAILED')) })
    if (spec.input) child.stdin.end(spec.input)
  })
}

module.exports = { sanitizeTimes, dueSlot, slotKey, windowIdle, warm, COMMANDS }
