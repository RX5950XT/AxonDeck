'use strict'

const { isAgentSessionId, startupCommand } = require('./store')

/** 在這次 CLI 執行期間換 home；PowerShell 子範圍或 cmd 的子程序結束後還原。 */
function commandForShell(shell, info) {
  const command = startupCommand(info.agent, undefined, info.sessionId)
  const key = info.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : info.agent === 'codex' ? 'CODEX_HOME' : ''
  const home = info.home
  if (!key || typeof home !== 'string' || !/^[A-Za-z]:[\\/]/.test(home) || home.length > 1024
    || /[\u0000-\u001f]/.test(home) || home.replace(/\\/g, '/').split('/').includes('..')) return command
  const quoted = home.replace(/'/g, "''")
  const script = `& { $viAgentPreviousHome = $env:${key}; try { $env:${key} = '${quoted}'; ${command} } finally { if ($null -eq $viAgentPreviousHome) { Remove-Item Env:${key} -ErrorAction SilentlyContinue } else { $env:${key} = $viAgentPreviousHome } } }`
  // cmd 的 %、&、括號都有自己的展開規則；固定 PowerShell 子程序用 encoded argv 收資料。
  return shell === 'cmd' ? `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}` : script
}

/** 對話檔只能在 CLI 建立後辨認；啟動前的 ID 是基準，不能拿「最新一筆」亂接。 */
function createTracker(store, agents, now = Date.now) {
  let timer = null
  let inflight = null
  const active = new Set()

  async function begin(meta, existing = false) {
    if (!meta || meta.preset === 'shell' || meta.preset === 'claude') return
    if (!existing && !meta.agentSessionId) {
      const rows = await agents.sessions(meta.cwd)
      await store.setAgentTracking(meta.id, now(), rows.filter(row => row.agent === meta.preset).map(row => row.id))
    }
    active.add(meta.id)
    if (!timer) {
      timer = setInterval(() => { void capture().catch(report) }, 5000)
      timer.unref?.()
    }
  }

  async function scan() {
    const terminals = await store.list()
    const claimed = new Set(terminals.filter(t => t.agentSessionId).map(t => `${t.preset}:${t.agentSessionId}`))
    const pending = terminals.filter(t => active.has(t.id) && !t.agentSessionId && t.agentStartedAt)
    const byCwd = new Map()
    for (const meta of pending) {
      if (!byCwd.has(meta.cwd)) byCwd.set(meta.cwd, await agents.sessions(meta.cwd))
      // 兩顆同工具終端機等待 ID，記錄沒有 terminal id，不能靠時間先後猜。
      if (pending.filter(t => t.cwd === meta.cwd && t.preset === meta.preset).length !== 1) continue
      const known = new Set(meta.agentKnownSessions || [])
      const candidates = byCwd.get(meta.cwd).filter(row => row.agent === meta.preset
        && isAgentSessionId(meta.preset, row.id) && row.mtime >= meta.agentStartedAt - 1000
        && !known.has(row.id) && !claimed.has(`${row.agent}:${row.id}`))
      if (candidates.length !== 1) continue
      const row = candidates[0]
      await store.setAgentSession(meta.id, row.agent, row.id, meta.agentStartedAt)
      claimed.add(`${row.agent}:${row.id}`)
    }
  }

  function capture() {
    if (!inflight) inflight = scan().finally(() => { inflight = null })
    return inflight
  }

  async function prepare(meta) {
    if (!meta?.agentSessionId) return meta
    try {
      const found = await agents.resume(meta.cwd, meta.preset, meta.agentSessionId)
      return { ...meta, agentHome: ['claude', 'codex'].includes(meta.preset) ? found.home : '' }
    } catch (error) {
      if (!['SESSION_NOT_FOUND', 'BAD_SESSION', 'BAD_AGENT'].includes(error?.code)) throw error
      await store.clearAgentSession?.(meta.id)
      const next = { ...meta }
      delete next.agentSessionId
      delete next.claudeSessionId
      delete next.claudeTranscript
      return next
    }
  }

  function stop() { clearInterval(timer); timer = null; active.clear() }
  function forget(id) { active.delete(id) }
  return { begin, capture, prepare, stop, forget }
}

function report() { console.error('[terminal] AI_SESSION_SCAN_FAILED') }

module.exports = { createTracker, commandForShell }
