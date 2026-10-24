'use strict'

/**
 * CLI 安裝器的 Linux 部分（cli-install.js 依平台選用）。
 *
 * 官方安裝方式（2026-10-08 查證各家文件）：
 * - Claude Code：`curl -fsSL https://claude.ai/install.sh | bash` → `~/.local/bin/claude`（code.claude.com/docs/en/setup）
 * - Grok CLI：`curl -fsSL https://x.ai/cli/install.sh | bash` → `~/.grok/bin/grok`（docs.x.ai/build/overview）
 * - Antigravity CLI：`curl -fsSL https://antigravity.google/cli/install.sh | bash` → `~/.local/bin/agy`（antigravity.google/docs/cli/install）
 * - Codex：`npm install -g @openai/codex`（openai/codex README）
 * - OpenCode：`npm install -g opencode-ai`（opencode.ai/docs）
 * npm 兩家跟 Windows 一樣用 npm；全域 prefix 不可寫（例如 /usr）就改裝到使用者 prefix `~/.local`，**絕不 sudo**。
 *
 * 指令全是固定字串，renderer 只送工具 key。缺 curl／npm 時印出 `AXONDECK_MISSING=<工具>` 並 exit 127，
 * cli-install.js 轉成固定訊息。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const MISSING_MARK = 'AXONDECK_MISSING='

/** @param {string} tool */
const need = (tool) => `command -v ${tool} >/dev/null 2>&1 || { echo "${MISSING_MARK}${tool}"; exit 127; }`

/** 官方安裝腳本：先確認 curl 存在，再 `curl | bash`（pipefail 由外層設定） */
const script = (url) => `${need('curl')}; curl -fsSL ${url} | bash`

/**
 * npm 全域安裝：全域 prefix 可寫就照官方 `npm install -g`；不可寫就裝到 `~/.local`（bin 在 `~/.local/bin`）。
 * @param {string} pkg
 */
const npmGlobal = (pkg) => [
  need('node'),
  need('npm'),
  'p="$(npm prefix -g 2>/dev/null)"',
  `if [ -n "$p" ] && { [ -w "$p/lib/node_modules" ] || { [ ! -e "$p/lib/node_modules" ] && [ -w "$p" ]; }; }; then npm install --global ${pkg} --no-audit --no-fund; else mkdir -p "$HOME/.local" && npm install --global --prefix "$HOME/.local" ${pkg} --no-audit --no-fund; fi`
].join('; ')

const INSTALLERS_LINUX = Object.freeze({
  claude: script('https://claude.ai/install.sh'),
  codex: npmGlobal('@openai/codex@latest'),
  grok: script('https://x.ai/cli/install.sh'),
  opencode: npmGlobal('opencode-ai@latest'),
  agy: script('https://antigravity.google/cli/install.sh')
})

const NODE_CHECK = `${need('node')}; ${need('npm')}; node --version && npm --version`

/** 版本查詢：PATH 找不到就直接失敗，不讓 bash 印 command not found 以外的東西 */
const versionCommand = (key) => `command -v ${key} >/dev/null 2>&1 || exit 127; ${key} --version`

/**
 * nvm／volta 裝的 Node 在桌面環境（AppImage 從選單開）通常不在 PATH 上：補最新一版 nvm 的 bin。
 * @param {string} home
 * @param {{ readdirSync?: Function }} [fsImpl]
 */
function nodeManagerBins(home, env, fsImpl = fs) {
  const bins = []
  const nvmRoot = path.posix.join(env.NVM_DIR || path.posix.join(home, '.nvm'), 'versions', 'node')
  try {
    const versions = fsImpl.readdirSync(nvmRoot).filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    versions.sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number)
      const pb = b.slice(1).split('.').map(Number)
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
    })
    if (versions[0]) bins.push(path.posix.join(nvmRoot, versions[0], 'bin'))
  } catch {}
  bins.push(path.posix.join(env.VOLTA_HOME || path.posix.join(home, '.volta'), 'bin'))
  return bins
}

/**
 * Linux PATH：原 PATH ＋ 三家原生安裝位置 ＋ npm 使用者 prefix ＋ nvm／volta。
 * @param {Record<string, string|undefined>} env
 * @param {{ readdirSync?: Function }} [fsImpl]
 */
function withPathLinux(env, fsImpl = fs) {
  const home = env.HOME || os.homedir()
  const known = [
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.grok', 'bin'),
    path.posix.join(home, '.opencode', 'bin'),
    path.posix.join(home, '.npm-global', 'bin'),
    ...(env.NPM_CONFIG_PREFIX ? [path.posix.join(env.NPM_CONFIG_PREFIX, 'bin')] : []),
    ...(env.npm_config_prefix ? [path.posix.join(env.npm_config_prefix, 'bin')] : []),
    ...nodeManagerBins(home, env, fsImpl),
    '/usr/local/bin', '/usr/bin', '/bin'
  ]
  const entries = [env.PATH || '', ...known].join(':').split(':').filter(Boolean)
  return { ...env, PATH: [...new Set(entries)].join(':') }
}

/**
 * bash 指令：不讀使用者的 rc（避免互動式設定卡住或印垃圾），pipefail 讓 `curl | bash` 的下載失敗算失敗。
 * @param {string} body
 */
function bashCommand(body) {
  return { exe: '/bin/bash', args: ['--noprofile', '--norc', '-c', `set -o pipefail; ${body}`] }
}

/** @param {string} output @returns {string} 缺的工具名；沒缺回空字串 */
function missingTool(output) {
  const match = new RegExp(`${MISSING_MARK}([a-z]+)`).exec(String(output))
  return match ? match[1] : ''
}

/** @param {string} tool */
function missingMessage(tool) {
  if (tool === 'curl') return '找不到 curl：請先用發行版套件管理員安裝 curl（例如 apt install curl）後再試'
  if (tool === 'node' || tool === 'npm') return '找不到 Node.js／npm：請先用發行版套件管理員或 nvm 安裝 Node.js 後再試（AxonDeck 不會用 sudo 代裝）'
  return `找不到 ${tool}`
}

module.exports = {
  INSTALLERS_LINUX,
  NODE_CHECK,
  MISSING_MARK,
  versionCommand,
  withPathLinux,
  nodeManagerBins,
  bashCommand,
  missingTool,
  missingMessage
}
