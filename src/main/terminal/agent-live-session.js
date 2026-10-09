'use strict'
const path = require('node:path')
const fs = require('../raw-fs').promises
const { dataPaths } = require('../workspace/agent-formats')
const { isAgentSessionId } = require('./store')

async function grokSession(process, cwd, home) {
  let rows
  try { rows = JSON.parse(await fs.readFile(path.join(home, 'active_sessions.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return ''; throw error }
  if (!Array.isArray(rows) || !cwd) return ''
  const started = Date.parse(process.StartedAt)
  const matches = rows.filter(row => row?.pid === process.ProcessId && typeof row.cwd === 'string'
    && path.resolve(row.cwd).toLowerCase() === path.resolve(cwd).toLowerCase()
    && isAgentSessionId('grok', row.session_id) && Number.isFinite(Date.parse(row.opened_at))
    && Number.isFinite(started) && Date.parse(row.opened_at) >= started - 1000)
    .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))
  if (matches.length > 1 && matches[0].opened_at === matches[1].opened_at && matches[0].session_id !== matches[1].session_id) return ''
  return matches[0]?.session_id || ''
}

async function agyLogged(process, home, started) {
  const dir = path.join(home, 'log')
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  let own = false
  const matches = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^cli-[\w-]+\.log$/.test(entry.name)) continue
    const file = path.join(dir, entry.name), stat = await fs.stat(file)
    if (stat.birthtimeMs < started - 2000 || stat.birthtimeMs > started + 10000) continue
    const handle = await fs.open(file, 'r')
    try {
      const head = Buffer.alloc(1024)
      const first = await handle.read(head, 0, head.length, 0)
      const pid = /Starting language server process with pid (\d+)/.exec(head.toString('utf8', 0, first.bytesRead))
      if (Number(pid?.[1]) !== process.ProcessId) continue
      own = true
      // shortcut: 只讀末尾 1 MiB；沒有切換記錄就改看這個目錄最後開過的對話。
      const tail = Buffer.alloc(Math.min(stat.size, 1024 * 1024))
      const last = await handle.read(tail, 0, tail.length, stat.size - tail.length)
      const rows = [...tail.toString('utf8', 0, last.bytesRead).matchAll(/conversation_manager\.go:\d+\] Streaming conversation ([A-Za-z0-9_-]+)\r?\n/g)]
      const id = rows.at(-1)?.[1]
      if (isAgentSessionId('agy', id)) matches.push(id)
    } finally { await handle.close() }
  }
  if (!own) return null
  return { id: new Set(matches).size === 1 ? matches[0] : '' }
}

async function agyLastConversation(cwd, home) {
  let map
  try { map = JSON.parse(await fs.readFile(path.join(home, 'cache', 'last_conversations.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return ''; throw error }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return ''
  const wanted = path.resolve(cwd).toLowerCase()
  const ids = Object.entries(map).filter(([dir, id]) => typeof dir === 'string' && path.resolve(dir).toLowerCase() === wanted && isAgentSessionId('agy', id)).map(([, id]) => id)
  return new Set(ids).size === 1 ? ids[0] : ''
}

async function agySession(process, cwd, home) {
  const started = Date.parse(process.StartedAt)
  if (!Number.isFinite(started)) return ''
  const logged = await agyLogged(process, home, started)
  if (!logged) return ''
  if (logged.id) return logged.id
  return cwd ? agyLastConversation(cwd, home) : ''
}

async function liveSession(agent, process, cwd) {
  const homes = dataPaths()
  if (agent === 'grok') return grokSession(process, cwd, homes.grok)
  if (agent === 'agy') return agySession(process, cwd, homes.agy)
  return ''
}
module.exports = { liveSession }
