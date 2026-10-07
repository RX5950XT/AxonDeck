'use strict'

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

// 官方 Windows 安裝方式；renderer 只能傳工具 key，不能傳指令或 URL。
const INSTALLERS = Object.freeze({
  claude: "Invoke-RestMethod 'https://claude.ai/install.ps1' | Invoke-Expression",
  codex: 'npm.cmd install --global @openai/codex@latest --no-audit --no-fund',
  grok: "Invoke-RestMethod 'https://x.ai/cli/install.ps1' | Invoke-Expression",
  opencode: 'npm.cmd install --global opencode-ai@latest --no-audit --no-fund',
  agy: "Invoke-RestMethod 'https://antigravity.google/cli/install.ps1' | Invoke-Expression"
})
const UPDATERS = Object.freeze({ claude: 'claude update', codex: 'codex update', grok: 'grok update', opencode: 'opencode upgrade', agy: 'agy update' })
const NODE_INSTALL = 'winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity'
const REGISTRY_PATH = "[Environment]::GetEnvironmentVariable('Path', 'Machine'); [Environment]::GetEnvironmentVariable('Path', 'User')"
const TIMEOUT_MS = 10 * 60_000

function withPath(env, registryPath = '') {
  const keys = Object.keys(env).filter(key => /^path$/i.test(key))
  const key = keys[0] || 'Path'
  const home = env.USERPROFILE || os.homedir()
  const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
  const roaming = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming')
  const known = [path.win32.join(home, '.local', 'bin'), path.win32.join(home, '.grok', 'bin'),
    path.win32.join(local, 'agy', 'bin'), path.win32.join(local, 'Microsoft', 'WindowsApps'),
    path.win32.join(roaming, 'npm'), path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs')]
  const entries = [registryPath, env[key] || '', ...known].join(';').split(/[;\r\n]+/).filter(Boolean)
  const result = Object.fromEntries(Object.entries(env).filter(([name]) => !/^path$/i.test(name)))
  return { ...result, [key]: [...new Set(entries)].join(';') }
}

// 不回傳原始行：只把最後三行轉成固定原因，任意 token、網址與上游 body 都出不去。
function outputSummary(output) {
  const lines = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/[\r\n]+/).filter(Boolean).slice(-3)
  const reasons = lines.map(line => {
    if (/EACCES|EPERM|access.*denied|permission|權限/i.test(line)) return '權限不足或檔案正在使用'
    if (/ETIMEDOUT|ENOTFOUND|ECONN|network|DNS|download.*fail/i.test(line)) return '連線或下載失敗'
    if (/checksum|hash.*mismatch/i.test(line)) return '下載校驗失敗'
    if (/not recognized|not found|CommandNotFound|找不到|無法辨識/i.test(line)) return '找不到所需工具'
    if (/401|403|unauthorized|authentication/i.test(line)) return '下載來源拒絕存取'
    return ''
  }).filter(Boolean)
  return [...new Set(reasons)].join('；') || '工具未完成，請稍後重試'
}

function powershell(script, env) {
  const prelude = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $global:LASTEXITCODE=0; "
  const wrapped = `${prelude}try { ${script}; exit $LASTEXITCODE } catch { Write-Output $_; exit 1 }`
  return { exe: path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')] }
}

function stopTree(child, env, spawnImpl, done) {
  // 真實 Linux spawn 沒有 taskkill；測試注入的 spawnImpl 仍走 Windows 路徑模擬
  if (process.platform !== 'win32' && spawnImpl === spawn) {
    try { child.kill() } catch {}
    done()
    return
  }
  if (!child.pid) { child.kill(); done(); return }
  let killer
  let stopped = false
  const finish = () => {
    if (stopped) return
    stopped = true
    clearTimeout(fallback)
    child.kill()
    done()
  }
  const fallback = setTimeout(finish, 3000)
  try {
    killer = spawnImpl(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
  } catch { finish(); return }
  killer.on('error', finish)
  killer.on('close', finish)
}

function runProcess(script, env, timeoutMs, spawnImpl = spawn) {
  return new Promise(resolve => {
    // Linux／macOS：真實 spawn 不可跑 powershell.exe（ENOENT）；測試注入的 spawnImpl 仍可走
    if (process.platform !== 'win32' && spawnImpl === spawn) {
      resolve({ code: 'SPAWN_FAILED', output: '此平台不支援 Windows CLI 安裝器' })
      return
    }
    const command = powershell(script, env)
    let child
    let output = ''
    let settled = false
    let timer
    let timedOut = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, output })
    }
    try {
      child = spawnImpl(command.exe, command.args, { env, cwd: os.homedir(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { finish({ code: 'SPAWN_FAILED' }); return }
    const collect = chunk => { output = (output + chunk.toString('utf8')).slice(-16384) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => finish({ code: 'SPAWN_FAILED' }))
    child.on('close', exitCode => { if (!timedOut) finish({ code: exitCode === 0 ? 'OK' : 'EXIT_FAILED', exitCode }) })
    timer = setTimeout(() => {
      timedOut = true
      // 只清本次 spawn 的 PID tree，避免留下 npm／安裝器繼續修改環境。
      stopTree(child, env, spawnImpl, () => finish({ code: 'TIMEOUT' }))
    }, Math.max(1, timeoutMs))
  })
}

function createRunner({ spawnImpl = spawn, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const tasks = new Map()
  let currentEnv = withPath(env)
  let nodeSetup = null
  const status = key => ({ ...(tasks.get(key) || { phase: 'idle' }) })
  const execute = (script, deadline) => Date.now() >= deadline
    ? Promise.resolve({ code: 'TIMEOUT', output: '' })
    : runProcess(script, currentEnv, deadline - Date.now(), spawnImpl)
  async function refreshEnvironment(deadline = Date.now() + 10000) {
    const result = await execute(REGISTRY_PATH, deadline)
    if (result.code !== 'OK') throw result
    currentEnv = withPath(env, result.output)
  }
  async function readVersion(key, deadline = Date.now() + 10000) {
    if (!Object.hasOwn(INSTALLERS, key)) return ''
    const result = await execute(`${key} --version`, deadline)
    if (result.code === 'TIMEOUT') throw result
    return result.code === 'OK' ? (result.output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] || '') : ''
  }
  async function ensureNode(deadline) {
    if (nodeSetup) return nodeSetup
    nodeSetup = (async () => {
      const node = await execute('node --version', deadline)
      const npm = await execute('npm --version', deadline)
      if (node.code === 'OK' && npm.code === 'OK') return
      const result = await execute(NODE_INSTALL, deadline)
      if (result.code !== 'OK') throw result
      await refreshEnvironment(deadline)
      const verified = await execute('node --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm --version', deadline)
      if (verified.code !== 'OK') throw verified
    })()
    try { await nodeSetup } finally { nodeSetup = null }
  }
  async function perform(key, deadline) {
    try {
      await refreshEnvironment(deadline)
      if (key === 'codex' || key === 'opencode') {
        tasks.set(key, { ...status(key), message: '準備環境中…' })
        await ensureNode(deadline)
      }
      // 先補環境再查版本，避免把「npm shim 存在但缺 Node」誤當尚未安裝。
      const local = await readVersion(key, Math.min(deadline, Date.now() + 10000))
      const action = local ? 'update' : 'install'
      tasks.set(key, { phase: 'running', action, message: action === 'install' ? '安裝中…' : '更新中…' })
      if (Date.now() >= deadline) throw { code: 'TIMEOUT' }
      const result = await execute(action === 'install' ? INSTALLERS[key] : UPDATERS[key], deadline)
      if (result.code !== 'OK') throw result
      await refreshEnvironment(deadline)
      const installed = await readVersion(key, Math.min(deadline, Date.now() + 10000))
      if (!installed) throw { code: Date.now() >= deadline ? 'TIMEOUT' : 'VERIFY_FAILED' }
      tasks.set(key, { phase: 'succeeded', action, local: installed, message: action === 'install' ? '安裝完成' : '更新完成' })
    } catch (error) {
      const code = ['TIMEOUT', 'SPAWN_FAILED', 'EXIT_FAILED', 'VERIFY_FAILED'].includes(error?.code) ? error.code : 'TASK_FAILED'
      const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : undefined
      const message = code === 'TIMEOUT' ? '超過 10 分鐘，已停止' : exitCode === undefined ? '執行失敗' : `執行失敗（結束碼 ${exitCode}）`
      tasks.set(key, { ...status(key), phase: 'failed', code, exitCode, message, summary: outputSummary(error?.output || '') })
    }
    return status(key)
  }
  function run(key) {
    if (typeof key !== 'string' || !Object.hasOwn(INSTALLERS, key)) return Promise.resolve({ phase: 'failed', code: 'INVALID_TOOL', message: '不支援這個工具' })
    if (tasks.get(key)?.phase === 'running') return Promise.resolve({ ...status(key), code: 'BUSY' })
    tasks.set(key, { phase: 'running', message: '準備中…' })
    return perform(key, Date.now() + timeoutMs)
  }
  return { run, status, readVersion, refreshEnvironment }
}

const runner = createRunner()
module.exports = { INSTALLERS, UPDATERS, withPath, outputSummary, createRunner, runner }
