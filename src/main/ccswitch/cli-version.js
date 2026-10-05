'use strict'

/**
 * CLI 版本檢查（Main Process）。
 *
 * 本機版本跑 `<工具> --version`，最新版本查 npm registry／agy 官方 manifest。
 * 安裝與更新由 cli-install.js 在背景執行。
 *
 * 更新一律用**該工具自己的 updater**（`claude update`／`codex update`／`grok update`／
 * `opencode upgrade`／`agy update`），不要一律組 `npm i -g`：這幾家多半是各自的安裝器裝的
 * （本機實測 claude 在 `~/.local/bin`、grok 在 `~/.grok/bin`、agy 在 `AppData\Local\agy\bin`，
 * 只有 codex 與 opencode 真的是 npm global），對非 npm 安裝的跑 `npm i -g` 會裝出第二份互相蓋。
 *
 * 工具清單是這裡的固定表，renderer 只送 key——跟終端機的 shell 白名單同一條理由。
 */

const shared = require('../usage/shared')
const { runner, UPDATERS } = require('./cli-install')

/**
 * 支援的 CLI。
 * `pkg` 只用來查「最新版是幾號」（agy 使用官方 manifest）；
 * 更新指令只在 cli-install.js 維護。
 * @type {ReadonlyArray<{ key: string, label: string, exe: string, pkg: string }>}
 */
const TOOLS = Object.freeze([
  { key: 'claude', label: 'Claude Code', exe: 'claude', pkg: '@anthropic-ai/claude-code' },
  { key: 'codex', label: 'Codex CLI', exe: 'codex', pkg: '@openai/codex' },
  { key: 'grok', label: 'Grok CLI', exe: 'grok', pkg: '@xai-official/grok' },
  { key: 'opencode', label: 'OpenCode', exe: 'opencode', pkg: 'opencode-ai' },
  // 官方 install.ps1 使用公開平台 manifest，沒有 npm 套件。
  { key: 'agy', label: 'Antigravity CLI', exe: 'agy', pkg: '' }
])

// 來源：https://antigravity.google/cli/install.ps1（2026-10-06 唯讀查證）
const AGY_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'

/**
 * 從一堆輸出裡挑出版本號。CLI 各家格式不同：
 * `1.2.3`、`claude 1.2.3 (Claude Code)`、`codex-cli 0.5.0` 都要認得。
 * @param {string} output
 * @returns {string}
 */
function parseVersion(output) {
  const match = String(output).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return match ? match[0] : ''
}

/**
 * 版本比較。回傳 1 / 0 / -1（a 比 b 新 / 一樣 / 舊）。
 * 只比數字段落，**帶預發布後綴的一律視為比正式版舊**（`1.2.3-beta.1` < `1.2.3`），
 * 這樣 `next` tag 的使用者不會被一直提示「有新版」。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = String(value).split('-', 2)
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { parts, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] || 0) - (right.parts[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

/**
 * 跑一次 `<exe> --version`。
 *
 * Windows 上包含 `.cmd`／`.ps1` shim，由背景 PowerShell 執行。
 * exe 名字來自上面的固定表，不是 renderer 給的，所以組進命令列是安全的。
 *
 * `stdin` 一律 `ignore`：留著一條永遠收不到 EOF 的管線會讓 CLI 卡在等輸入
 * （AGY 代跑 `agy.exe` 時實測踩過，CLAUDE.md 有記）。
 *
 * @param {string} exe
 * @returns {Promise<string>} 版本號；找不到或跑不起來回空字串
 */
function runVersion(exe) {
  return runner.readVersion(exe).catch(() => '')
}

/**
 * 查 npm registry 上的最新版。
 *
 * **不要帶 `Accept: application/vnd.npm.install-v1+json`**：那個精簡格式只有 packument
 * 端點支援，`/latest` 收到會回 **406 空 body**，結果是每一家都查不到最新版、UI 一路顯示
 * 「離線？」（實測踩過，只有偶爾命中不同 CDN 節點才會過）。
 *
 * @param {string} pkg
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<string>}
 */
async function fetchLatest(pkg, options = {}) {
  if (!pkg) return ''
  const data = await shared.fetchJson(
    `https://registry.npmjs.org/${pkg.split('/').map(encodeURIComponent).join('/')}/latest`,
    {
      label: 'npm registry',
      retries: 2,
      timeoutMs: 10000,
      maxBytes: 512 * 1024,
      fetchImpl: options.fetchImpl
    }
  )
  return validVersion(data.version)
}

function validVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : ''
}

async function fetchAgyLatest(options = {}) {
  const arch = options.arch || process.arch
  if (!['x64', 'arm64'].includes(arch)) return ''
  const platform = arch === 'arm64' ? 'windows_arm64' : 'windows_amd64'
  const data = await shared.fetchJson(`${AGY_MANIFEST_BASE}/${platform}.json`, {
    label: 'Antigravity CLI', retries: 2, timeoutMs: 10000, maxBytes: 64 * 1024, fetchImpl: options.fetchImpl
  })
  return validVersion(data.version)
}

/**
 * 一個工具的狀態。查不到最新版**不算失敗**——離線時本機版本照樣要顯示得出來。
 * @param {{ key: string, label: string, exe: string, pkg: string }} tool
 * @param {{ fetchImpl?: Function }} [options]
 */
async function checkTool(tool, options = {}) {
  const [local, latest] = await Promise.all([
    runVersion(tool.exe),
    (tool.key === 'agy' ? fetchAgyLatest(options) : fetchLatest(tool.pkg, options)).catch(() => '')
  ])
  return {
    key: tool.key,
    label: tool.label,
    pkg: tool.pkg,
    installed: Boolean(local),
    local,
    latest,
    outdated: Boolean(local && latest && compareVersions(local, latest) < 0),
    task: runner.status(tool.key)
  }
}

/**
 * 全部工具一起查。
 * @param {{ fetchImpl?: Function }} [options]
 */
async function checkAll(options = {}) {
  await runner.refreshEnvironment().catch(() => {})
  return Promise.all(TOOLS.map((tool) => checkTool(tool, options)))
}

/**
 * 背景任務。renderer 只送 key，指令固定在 main。
 * @param {unknown} key
 */
function runTask(key) { return runner.run(key) }
function taskStatus(key) { return typeof key === 'string' && Object.hasOwn(UPDATERS, key) ? runner.status(key) : { phase: 'failed', code: 'INVALID_TOOL', message: '不支援這個工具' } }

module.exports = {
  TOOLS,
  parseVersion,
  compareVersions,
  runVersion,
  fetchLatest,
  fetchAgyLatest,
  checkTool,
  checkAll,
  runTask,
  taskStatus
}
