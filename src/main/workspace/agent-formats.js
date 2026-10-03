'use strict'

const fs = require('../raw-fs')
const os = require('os')
const path = require('path')
const { fileURLToPath, pathToFileURL } = require('url')

function openDb(file) {
  if (!fs.existsSync(file)) return null
  try { return new (require('node:sqlite').DatabaseSync)(file, { readOnly: true, allowExtension: false }) }
  catch { return null }
}

function dataPaths() {
  return {
    grok: process.env.GROK_HOME || path.join(os.homedir(), '.grok'),
    opencode: path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'opencode', 'opencode.db'),
    agy: process.env.AGY_HOME || path.join(os.homedir(), '.gemini/antigravity-cli')
  }
}

async function extraSessions(project, samePath, idRe, sessionId = '') {
  const roots = dataPaths(), out = []
  for (const archive of ['sessions', 'archived_sessions']) {
    const parent = path.join(roots.grok, archive)
    const directories = await fs.promises.readdir(parent, { withFileTypes: true }).catch(() => [])
    for (const directory of directories) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue
    let cwd; try { cwd = decodeURIComponent(directory.name) } catch { continue }
    if (!samePath(cwd, project)) continue
    const dir = path.join(parent, directory.name)
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !idRe.test(entry.name) || (sessionId && entry.name !== sessionId)) continue
      const full = path.join(dir, entry.name)
      let summary
      try { summary = JSON.parse(await fs.promises.readFile(path.join(full, 'summary.json'), 'utf8')) } catch { continue }
      if (!samePath(summary?.info?.cwd, project) || summary?.info?.id !== entry.name) continue
      const file = path.join(full, 'chat_history.jsonl')
      const stat = await fs.promises.stat(file).catch(() => null)
      if (stat) out.push({ agent: 'grok', id: entry.name, title: summary.session_summary || '', mtime: stat.mtimeMs, file, home: roots.grok })
    }
    }
  }
  for (const agent of ['opencode', 'agy']) {
    const file = agent === 'agy' ? path.join(roots.agy, 'conversation_summaries.db') : roots.opencode
    const db = openDb(file)
    if (!db) continue
    try {
      const sql = agent === 'agy'
        ? `SELECT conversation_id AS id,title,workspace_uris,last_modified_time FROM conversation_summaries
           WHERE parent_conversation_id = '' AND (? = '' OR conversation_id = ?)
             AND json_valid(workspace_uris) AND EXISTS (SELECT 1 FROM json_each(workspace_uris) WHERE lower(value) = lower(?))
           ORDER BY last_modified_time DESC LIMIT 30`
        : `SELECT id,title,directory,time_updated FROM session WHERE parent_id IS NULL
           AND (? = '' OR id = ?) AND lower(rtrim(replace(directory, char(92), '/'), '/')) = lower(?)
           ORDER BY time_updated DESC LIMIT 30`
      const location = agent === 'agy' ? pathToFileURL(project).href : project.replace(/\\/g, '/').replace(/\/+$/, '')
      for (const row of db.prepare(sql).iterate(sessionId, sessionId, location)) {
        if (!idRe.test(row.id)) continue
        let inside = samePath(row.directory, project)
        if (agent === 'agy') { try { inside = JSON.parse(row.workspace_uris).some(uri => samePath(fileURLToPath(uri), project)) } catch { inside = false } }
        if (!inside) continue
        out.push({ agent, id: row.id, title: row.title || '', mtime: agent === 'agy' ? Date.parse(row.last_modified_time) : row.time_updated, home: agent === 'agy' ? roots.agy : path.dirname(file), file: agent === 'agy' ? path.join(roots.agy, 'conversations', row.id + '.db') : file })
      }
    } finally { db.close() }
  }
  return out
}

// Antigravity CLI 的 steps.step_payload 是 protobuf；只讀已實測的對話／工具欄位。
function protoFields(input) {
  const b = Buffer.from(input || []), out = []; let i = 0
  const number = () => { let n = 0, shift = 0, byte; do { if (i >= b.length || shift > 49) throw Error('BAD_PROTO'); byte = b[i++]; n += (byte & 127) * 2 ** shift; shift += 7 } while (byte & 128); return n }
  while (i < b.length) {
    const key = number(), wire = key % 8, field = Math.floor(key / 8)
    if (!field) throw Error('BAD_PROTO')
    if (wire === 0) { number(); continue }
    if (wire === 1 || wire === 5) { i += wire === 1 ? 8 : 4; continue }
    if (wire !== 2) throw Error('BAD_PROTO')
    const length = number(); if (i + length > b.length) throw Error('BAD_PROTO')
    out.push({ field, value: b.subarray(i, i + length) }); i += length
  }
  return out
}

function agyTurns(row) {
  const fields = protoFields(row.step_payload)
  if (row.step_type !== 14 && row.step_type !== 15) {
    const metadata = fields.find(x => x.field === 5)
    const parts = metadata ? protoFields(metadata.value) : []
    const call = parts.find(x => x.field === 4)
    if (!call) return []
    const tool = protoFields(call.value), name = tool.find(x => x.field === 2)?.value.toString('utf8') || 'tool'
    const summary = parts.filter(x => x.field === 30 || x.field === 31).map(x => x.value.toString('utf8')).join('\n')
    return [{ role: 'assistant', text: '', tools: [{ name: `${name} · 結果`, detail: summary || '這份工具結果未以明文儲存。' }] }]
  }
  const payload = fields.find(x => x.field === (row.step_type === 14 ? 19 : 20))
  if (!payload || ![14, 15].includes(row.step_type)) return []
  const parts = protoFields(payload.value), get = n => parts.find(x => x.field === n)?.value.toString('utf8') || ''
  if (row.step_type === 14) return get(2) ? [{ role: 'user', text: get(2) }] : []
  const out = [], text = get(1) || get(8), thought = get(3)
  if (thought) out.push({ role: 'assistant', text: thought, thought: true })
  if (text) out.push({ role: 'assistant', text })
  for (const part of parts.filter(x => x.field === 7)) {
    const tool = protoFields(part.value), getTool = n => tool.find(x => x.field === n)?.value.toString('utf8') || ''
    out.push({ role: 'assistant', text: '', tools: [{ name: getTool(2) || 'tool', detail: getTool(3) }] })
  }
  return out
}

function textParts(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter(p => ['text', 'input_text', 'output_text', 'thinking', 'reasoning'].includes(p?.type)).map(p => p.text || p.thinking || '').join('\n') : ''
}

function logTurns(agent, obj) {
  if (agent === 'codex') {
    const p = obj.type === 'response_item' ? obj.payload : obj
    if (p?.type === 'function_call' || p?.type === 'custom_tool_call') return [{ role: 'assistant', text: '', tools: [{ name: p.name || 'tool', detail: typeof p.arguments === 'string' ? p.arguments : p.input || '' }] }]
    if (['function_call_output', 'custom_tool_call_output'].includes(p?.type)) return [{ role: 'assistant', text: '', tools: [{ name: '工具結果', detail: typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '') }] }]
    if (p?.type === 'reasoning') return (p.summary || []).filter(x => x.text).map(x => ({ role: 'assistant', text: x.text, thought: true }))
    if (!['user', 'assistant', 'tool'].includes(p?.role)) return []
    const text = textParts(p.content), tools = (p.tool_calls || []).map(c => ({ name: c.name || c.function?.name || 'tool', detail: c.arguments || c.function?.arguments || '' }))
    return text || tools.length ? [{ role: p.role === 'user' ? 'user' : 'assistant', text, tools }] : []
  }
  if (obj.type === 'tool_result') return [{ role: 'assistant', text: '', tools: [{ name: '工具結果', detail: textParts(obj.content) }] }]
  if (obj.type === 'reasoning') return (obj.summary || []).filter(x => x.text).map(x => ({ role: 'assistant', text: x.text, thought: true }))
  if (!['user', 'assistant', 'tool'].includes(obj.type)) return []
  const content = agent === 'claude' ? obj.message?.content : obj.content
  let text = textParts(content)
  if (agent === 'grok' && obj.type === 'user') {
    const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)
    if (query) text = query[1]
    else if (text.startsWith('<user_info>')) return []
  }
  const tools = Array.isArray(content) ? content.filter(p => ['tool_use', 'tool_result'].includes(p?.type)).map(p => ({ name: p.name || '工具結果', detail: p.type === 'tool_result' ? textParts(p.content) : JSON.stringify(p.input || {}) })) : []
  tools.push(...(obj.tool_calls || []).map(c => ({ name: c.name || 'tool', detail: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}) })))
  return text || tools.length ? [{ role: obj.type === 'user' && !tools.length ? 'user' : 'assistant', text, tools }] : []
}

async function* jsonRecords(file, offset = 0) {
  const handle = await fs.promises.open(file, 'r'); let position = offset, start = offset, pending = []
  try {
    while (true) {
      const buffer = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      const chunk = buffer.subarray(0, bytesRead); let from = 0, newline
      while ((newline = chunk.indexOf(10, from)) !== -1) {
        pending.push(chunk.subarray(from, newline)); const next = position + newline + 1
        yield { offset: start, next, value: Buffer.concat(pending).toString('utf8') }
        pending = []; start = next; from = newline + 1
      }
      pending.push(chunk.subarray(from)); position += bytesRead
    }
    if (position > start) yield { offset: start, next: position, value: Buffer.concat(pending).toString('utf8') }
  } finally { await handle.close() }
}

async function* records(found, agent, offset) {
  if (agent !== 'agy' && agent !== 'opencode') {
    for await (const record of jsonRecords(found.file, offset)) {
      let value; try { value = JSON.parse(record.value) } catch { continue }
      yield { ...record, turns: logTurns(agent, value) }
    }
    return
  }
  const db = openDb(found.file)
  if (!db) throw Object.assign(new Error('SESSION_UNAVAILABLE'), { code: 'SESSION_UNAVAILABLE', userMessage: '這份對話記錄目前無法讀取，請稍後再試' })
  try {
    const sql = agent === 'agy' ? 'SELECT idx,step_type,step_payload FROM steps WHERE idx >= ? ORDER BY idx' : 'SELECT rowid,id,data FROM message WHERE session_id = ? AND rowid >= ? ORDER BY rowid'
    for (const row of db.prepare(sql).iterate(...(agent === 'agy' ? [offset] : [found.id, offset]))) {
      let turns = []
      if (agent === 'agy') turns = agyTurns(row)
      else {
        const message = JSON.parse(row.data), parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created,id').all(row.id).map(p => JSON.parse(p.data))
        const text = textParts(parts), tools = parts.filter(p => p.type === 'tool').map(p => ({ name: p.tool || 'tool', detail: JSON.stringify(p.state || {}) }))
        if (text || tools.length) turns.push({ role: message.role === 'user' ? 'user' : 'assistant', text, tools })
      }
      const n = agent === 'agy' ? row.idx : row.rowid
      yield { offset: n, next: n + 1, turns }
    }
  } finally { db.close() }
}

module.exports = { extraSessions, records, protoFields, logTurns, dataPaths }
