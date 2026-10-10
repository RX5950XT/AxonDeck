'use strict'

const { isAgentSessionId, startupCommand } = require('./store')
const path = require('node:path')
const TITLE_SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/g

function reportedTitle(meta, title = '') {
  const raw = String(title || '').replace(TITLE_SPINNER, '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  if (meta.preset === 'opencode') {
    const mark = 'oc | '
    const index = raw.toLowerCase().lastIndexOf(mark)
    return index < 0 ? '' : raw.slice(index + mark.length).trim()
  }
  if (meta.preset === 'grok') {
    const suffix = ' - grok'
    return raw.toLowerCase().endsWith(suffix) ? raw.slice(0, -suffix.length).trim() : ''
  }
  const suffix = ` | ${path.basename(meta.cwd || '')}`
  if (meta.preset === 'codex' && raw.endsWith(suffix)) return raw.slice(0, -suffix.length).trim()
  return ''
}

function titledRows(rows, title) {
  if (!title) return []
  const nameOf = row => row.sessionTitle || row.title || ''
  const exact = rows.filter(row => nameOf(row) === title)
  if (exact.length) return exact
  const stem = title.endsWith('...') ? title.slice(0, -3).trimEnd() : ''
  if (stem.length < 8) return []
  return rows.filter(row => nameOf(row).startsWith(stem))
}

/** 標題只剩資料夾名稱時，這次程序開始後、這個目錄裡唯一且較新的 Codex 紀錄。 */
function codexLatest(meta, rows, terminals, active, title) {
  if (meta.preset !== 'codex' || !meta.agentStartedAt) return null
  const visible = String(title || '').replace(TITLE_SPINNER, '').replace(/\s+/g, ' ').trim()
  if (!visible) return null
  const peers = terminals.filter(item => active.has(item.id) && item.preset === 'codex' && item.cwd === meta.cwd)
  if (peers.length !== 1) return null
  const fresh = rows.filter(row => row.mtime >= meta.agentStartedAt - 1000)
  fresh.sort((a, b) => b.mtime - a.mtime)
  if (!fresh.length || (fresh[1] && fresh[0].mtime === fresh[1].mtime)) return null
  return fresh[0]
}

async function bindCodexFolder(meta, rows, terminals, active, title, pending, claimed, remember) {
  const row = codexLatest(meta, rows, terminals, active, title)
  if (!row) return false
  const known = new Set(meta.agentKnownSessions || [])
  const unseen = rows.filter(item => item.mtime >= meta.agentStartedAt - 1000
    && !known.has(item.id) && !claimed.has(`${item.agent}:${item.id}`))
  const waiting = pending.filter(item => item.cwd === meta.cwd && item.preset === meta.preset).length === 1
  if (!meta.agentSessionId && waiting && unseen.length === 1) return false
  if (row.id !== meta.agentSessionId && !claimed.has(`${meta.preset}:${row.id}`))
    await remember(meta, meta.preset, row.id, claimed)
  return true
}

/** 在這次 CLI 執行期間換 home；PowerShell 子範圍或 cmd 的子程序結束後還原。 */
function commandForShell(shell, info) {
  const command = startupCommand(info.agent, undefined, info.sessionId)
  const key = info.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : info.agent === 'codex' ? 'CODEX_HOME' : ''
  const home = info.home
  if (!key || typeof home !== 'string' || !/^[A-Za-z]:[\\/]/.test(home) || home.length > 1024
    || /[\u0000-\u001f]/.test(home) || home.replace(/\\/g, '/').split('/').includes('..')) return command
  const defaultClaude = info.agent === 'claude' && path.resolve(home).toLowerCase() === path.join(require('os').homedir(), '.claude').toLowerCase()
  const values = [[key, defaultClaude ? null : home]]
  if (info.agent === 'claude') values.push(['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN', '1'])
  const save = values.map(([name], i) => `$viAgentPrevious${i} = $env:${name}`).join('; ')
  const apply = values.map(([name, value]) => value === null ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue` : `$env:${name} = '${value.replace(/'/g, "''")}'`).join('; ')
  const restore = values.map(([name], i) => `if ($null -eq $viAgentPrevious${i}) { Remove-Item Env:${name} -ErrorAction SilentlyContinue } else { $env:${name} = $viAgentPrevious${i} }`).join('; ')
  const script = `& { ${save}; try { ${apply}; ${command} } finally { ${restore} } }`
  // cmd 的 %、&、括號都有自己的展開規則；固定 PowerShell 子程序用 encoded argv 收資料。
  return shell === 'cmd' ? `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}` : script
}

/** 對話檔只能在 CLI 建立後辨認；啟動前的 ID 是基準，不能拿「最新一筆」亂接。 */
function createTracker(store, agents, now = Date.now, states = async () => [], identify = async () => new Map(), onChange = () => {}, onScan = () => {}) {
  let timer = null
  let inflight = null
  let queued = null
  const active = new Set()

  async function remember(meta, agent, sessionId, claimed) {
    if (await store.setAgentSession(meta.id, agent, sessionId, meta.agentStartedAt) === false) return
    claimed.add(`${agent}:${sessionId}`)
    onChange(meta.id, sessionId)
  }

  async function begin(meta, existing = false) {
    if (!meta || meta.preset === 'shell') return
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
    const live = await states() || []
    const titles = new Map(live.map(t => [t.id, t.title]))
    const needsIdentity = terminals.filter(t => active.has(t.id) && (['claude', 'grok', 'agy'].includes(t.preset) || !t.agentSessionId))
    const runtime = needsIdentity.length ? await identify(live, needsIdentity) : new Map()
    const byCwd = new Map()
    for (const meta of terminals.filter(t => active.has(t.id))) {
      const sessionId = runtime.get(meta.id)
      if (sessionId) {
        if (sessionId !== meta.agentSessionId) {
          try {
            await agents.resume(meta.cwd, meta.preset, sessionId)
            await remember(meta, meta.preset, sessionId, claimed)
          } catch (error) {
            if (error.code !== 'SESSION_NOT_FOUND') throw error
            if (agents.ownedConversation?.(meta.preset, sessionId)) await remember(meta, meta.preset, sessionId, claimed)
          }
        }
        continue
      }
      if (!byCwd.has(meta.cwd)) byCwd.set(meta.cwd, await agents.sessions(meta.cwd))
      const rows = byCwd.get(meta.cwd).filter(row => row.agent === meta.preset && isAgentSessionId(meta.preset, row.id))
      const named = titledRows(rows, reportedTitle(meta, titles.get(meta.id)))
      // CLI 內選舊對話不會產生新 ID；只採用該工具、該目錄中唯一的明確標題。
      if (named.length) {
        if (named.length === 1 && named[0].id !== meta.agentSessionId) await remember(meta, meta.preset, named[0].id, claimed)
        continue
      }
      if (await bindCodexFolder(meta, rows, terminals, active, titles.get(meta.id), pending, claimed, remember)) continue
      if (meta.agentSessionId || !meta.agentStartedAt) continue
      // 兩顆同工具終端機等待 ID，記錄沒有 terminal id，不能靠時間先後猜。
      if (pending.filter(t => t.cwd === meta.cwd && t.preset === meta.preset).length !== 1) continue
      const known = new Set(meta.agentKnownSessions || [])
      const candidates = rows.filter(row => row.mtime >= meta.agentStartedAt - 1000
        && !known.has(row.id) && !claimed.has(`${row.agent}:${row.id}`))
      if (candidates.length !== 1) continue
      const row = candidates[0]
      await remember(meta, row.agent, row.id, claimed)
    }
    await onScan(terminals.filter(item => active.has(item.id)), live)
  }

  // 後到的查詢要等下一輪：這一輪可能在標題換掉之前就讀過了。
  function capture() {
    if (inflight) {
      queued ??= inflight.then(() => {}, () => {}).then(() => {
        queued = null
        return capture()
      })
      return queued
    }
    const run = scan().finally(() => { if (inflight === run) inflight = null })
    inflight = run
    return run
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
