'use strict'

const path = require('node:path')
const fs = require('../raw-fs').promises
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const { isAgentSessionId } = require('./store')

/** 只採用原 PTY 的子程序；同目錄另一個工作台的 CLI 不算。 */
function ownedProcesses(pid, processes) {
  const owned = new Set([pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of processes) if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) {
      owned.add(row.ProcessId); changed = true
    }
  }
  return processes.filter(row => row.ProcessId !== pid && owned.has(row.ProcessId))
}

/** 只採用 mtime 晚於 floor 的紀錄。shortcut: 同資料夾的子代理 jsonl 可能暫時較新，本體再寫入後下一輪改回。 */
async function claudeLiveId(homes, cwd, floor) {
  if (!cwd || !Number.isFinite(floor)) return ''
  const folder = cwd.replace(/[^A-Za-z0-9-]/g, '-')
  let best = null
  for (const home of homes) {
    let names
    try { names = await fs.readdir(path.join(home, 'projects', folder)) }
    catch (error) { if (error.code !== 'ENOENT') throw error; continue }
    for (const name of names) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name)) continue
      const stat = await fs.stat(path.join(home, 'projects', folder, name))
      if (!stat.isFile() || stat.mtimeMs <= floor) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (!isAgentSessionId('claude', sessionId)) continue
      if (!best || stat.mtimeMs > best.mtime) best = { sessionId, mtime: stat.mtimeMs, tie: false }
      else if (stat.mtimeMs === best.mtime && sessionId !== best.sessionId) best.tie = true
    }
  }
  return best && !best.tie ? best.sessionId : ''
}

/** /resume 會改 sessions/<pid>.json。離開的 jsonl 常在同一秒再寫一次，兩秒內不以它蓋過 pid 檔。 */
async function claudePidFile(homes, pid) {
  let found = null
  for (const home of homes) {
    const file = path.join(home, 'sessions', `${pid}.json`)
    try {
      const row = JSON.parse(await fs.readFile(file, 'utf8'))
      if (row.pid !== pid || !isAgentSessionId('claude', row.sessionId)) continue
      const mtime = (await fs.stat(file)).mtimeMs
      if (found && found.sessionId !== row.sessionId) return null
      if (!found || mtime > found.mtime) found = { sessionId: row.sessionId, mtime }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
  return found
}

async function claudeSessionId(homes, cwd, process, peerCount) {
  const pid = await claudePidFile(homes, process.ProcessId)
  const started = Date.parse(process.StartedAt)
  const floor = pid ? pid.mtime + 2000 : started - 2001
  if (peerCount === 1) {
    const live = await claudeLiveId(homes, cwd, floor)
    if (live) return live
  }
  return pid?.sessionId || ''
}

function resumeId(agent, command) {
  const flag = { claude: '--resume', codex: 'resume', grok: '--resume', opencode: '--session', agy: '--conversation' }[agent]
  const args = String(command || '').match(/"[^"]*"|[^\s]+/g)?.map(value => value.replace(/^"|"$/g, '')) || []
  const at = args.indexOf(flag)
  if (at < 0) return ''
  const id = args.slice(at + 1).find(value => !value.startsWith('--'))
  return isAgentSessionId(agent, id) ? id : ''
}

/** Linux：/proc/<pid>/stat 的 starttime 是開機後的 clock tick；換成 ISO 時間要 btime 與 CLK_TCK。 */
let clockTicks = 0
function clkTck() {
  if (clockTicks) return clockTicks
  try { clockTicks = Number(require('node:child_process').execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 }).trim()) || 100 }
  catch { clockTicks = 100 }
  return clockTicks
}

/**
 * Linux 的程序名稱：node／bun／deno 跑的 CLI（npm 裝的 codex、opencode…）取腳本檔名，
 * 其餘取 argv[0] 的檔名；都去掉 .js／.mjs／.cjs，對照 preset（claude、codex…）。
 * @param {string[]} argv
 */
function linuxProcessName(argv) {
  const base = (value) => path.posix.basename(String(value || '')).replace(/\.(c|m)?js$/i, '')
  // Claude 原生安裝：~/.local/share/claude/versions/<版本>，直接執行時 argv[0] 是版本檔名
  if (/\/claude\/versions\/[^/]+$/.test(String(argv[0] || ''))) return 'claude'
  const first = base(argv[0])
  if (/^(node|nodejs|bun|deno)$/i.test(first)) {
    const script = argv.slice(1).find(arg => arg && !arg.startsWith('-'))
    if (script) return base(script)
  }
  return first
}

/** 與 Windows 的 Win32_Process 同欄位：ProcessId、ParentProcessId、Name、CommandLine、StartedAt。 */
async function linuxProcessSnapshot(root = '/proc') {
  let btime = 0
  try { btime = Number(/^btime\s+(\d+)/m.exec(await fs.readFile(path.join(root, 'stat'), 'utf8'))?.[1]) || 0 } catch { btime = 0 }
  const tick = clkTck()
  const rows = []
  for (const name of await fs.readdir(root)) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = await fs.readFile(path.join(root, name, 'stat'), 'utf8')
      // comm 可能含空白與括號：從最後一個 ')' 之後切欄位
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(fields[1])
      const startTicks = Number(fields[19])
      const argv = (await fs.readFile(path.join(root, name, 'cmdline'), 'utf8')).split('\0').filter(Boolean)
      if (!argv.length) continue
      rows.push({
        ProcessId: Number(name), ParentProcessId: ppid, Name: linuxProcessName(argv),
        CommandLine: argv.map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' '),
        StartedAt: btime && Number.isFinite(startTicks) ? new Date((btime + startTicks / tick) * 1000).toISOString() : ''
      })
    } catch { /* 程序剛結束或讀不到（別人的程序） */ }
  }
  return rows.filter(row => Number.isSafeInteger(row.ProcessId) && Number.isSafeInteger(row.ParentProcessId))
}

/** 程序名稱是不是這個 preset 的 CLI（Windows 比 `<preset>.exe`，Linux 比檔名） */
function isPresetProcess(row, preset, platform = process.platform) {
  const name = String(row?.Name || '').toLowerCase()
  // 非 Windows 也認 `<preset>.exe`：測試的程序表與 Wine 下的 CLI 都長這樣，Linux 本身不會撞名
  return name === `${preset}.exe` || (platform !== 'win32' && name === preset)
}

async function processSnapshot() {
  if (process.platform === 'linux') return linuxProcessSnapshot()
  if (process.platform !== 'win32') return []
  const exe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='StartedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"
  const { stdout } = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  const rows = JSON.parse(stdout || '[]')
  return (Array.isArray(rows) ? rows : [rows]).filter(row => Number.isSafeInteger(row.ProcessId) && Number.isSafeInteger(row.ParentProcessId))
}

async function identifySessions(states, terminals, homes, snapshot = processSnapshot) {
  const result = new Map()
  if (!terminals.some(meta => states.some(row => row.id === meta.id && Number.isSafeInteger(row.pid)))) return result
  const processes = await snapshot()
  for (const meta of terminals) {
    const state = states.find(row => row.id === meta.id)
    if (!Number.isSafeInteger(state?.pid)) continue
    const candidates = []
    for (const process of ownedProcesses(state.pid, processes)) {
      if (!isPresetProcess(process, meta.preset)) continue
      const processCandidates = []
      // 同目錄同工具有幾個分頁：只有一個時才可以拿「目錄裡最新的那筆」來猜
      const peers = terminals.filter(item => item.preset === meta.preset && item.cwd && meta.cwd
        && path.resolve(item.cwd).toLowerCase() === path.resolve(meta.cwd).toLowerCase())
      if (['grok', 'agy'].includes(meta.preset)) {
        const id = await require('./agent-live-session').liveSession(meta.preset, process, meta.cwd, peers.length)
        if (id) processCandidates.push(id)
      }
      if (meta.preset === 'claude') {
        const id = await claudeSessionId(homes, meta.cwd, process, peers.length)
        if (id) processCandidates.push(id)
      }
      if (!processCandidates.length && !meta.agentSessionId) {
        const id = resumeId(meta.preset, process.CommandLine)
        if (id) processCandidates.push(id)
      }
      candidates.push(...processCandidates)
    }
    const unique = [...new Set(candidates)]
    if (unique.length === 1) result.set(meta.id, unique[0])
  }
  return result
}

module.exports = { ownedProcesses, resumeId, identifySessions, linuxProcessSnapshot, linuxProcessName, isPresetProcess }
