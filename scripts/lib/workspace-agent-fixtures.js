'use strict'
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
function seedAgentFixtures(home, project, long = false) {
  const ids = { claude: 'a1234567-1234-4234-8234-123456789abc', codex: 'codex-test-123', grok: 'grok-test-123', opencode: 'ses_test123', agy: 'b1234567-1234-4234-8234-123456789abc' }
  const text = long ? '完整文字'.repeat(270000) + '最末尾驗收' : '完整回答最末尾驗收'
  const user = '完整提問'.repeat(250) + '提問尾巴'
  const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n') }
  const rows = []
  for (let i = 0; i < (long ? 75 : 1); i++) rows.push({ type: 'user', message: { content: user + i } }, { type: 'assistant', message: { content: [{ type: 'text', text: i === 0 ? text : '回答' + i }] } })
  write(path.join(home, '.claude', 'projects', project.replace(/[^A-Za-z0-9-]/g, '-'), ids.claude + '.jsonl'), rows)
  write(path.join(home, '.codex', 'sessions', 'rollout-' + ids.codex + '.jsonl'), [{ type: 'session_meta', payload: { id: ids.codex, cwd: project } }, { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: user }] } }, { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text }] } }, { type: 'response_item', payload: { type: 'function_call', name: 'Read', arguments: JSON.stringify({ path: 'src/a.js' }) } }])
  const grok = path.join(home, '.grok', 'sessions', encodeURIComponent(project), ids.grok)
  write(path.join(grok, 'chat_history.jsonl'), [{ type: 'user', content: [{ type: 'text', text: '<user_query>\n' + user + '\n</user_query>' }] }, { type: 'assistant', content: [{ type: 'text', text }] }])
  fs.writeFileSync(path.join(grok, 'summary.json'), JSON.stringify({ info: { id: ids.grok, cwd: project }, session_summary: 'Grok 測試' }))
  const dbFile = path.join(home, '.local/share/opencode/opencode.db'); fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  let db = new DatabaseSync(dbFile)
  db.exec('CREATE TABLE session(id TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)')
  db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(ids.opencode, project, 'OpenCode 測試', Date.now(), null)
  for (const [i, role, body] of [[0, 'user', user], [1, 'assistant', text]]) { db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('msg_' + i, ids.opencode, i, JSON.stringify({ role })); db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('part_' + i, 'msg_' + i, ids.opencode, i, JSON.stringify({ type: 'text', text: body })) }
  db.close()
  const agy = path.join(home, '.gemini/antigravity-cli'); fs.mkdirSync(path.join(agy, 'conversations'), { recursive: true })
  db = new DatabaseSync(path.join(agy, 'conversation_summaries.db'))
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,last_modified_time TEXT,parent_conversation_id TEXT)')
  db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?)').run(ids.agy, 'AGY 測試', JSON.stringify([require('url').pathToFileURL(project).href]), new Date().toISOString(), '')
  db.close()
  db = new DatabaseSync(path.join(agy, 'conversations', ids.agy + '.db')); db.exec('CREATE TABLE steps(idx INTEGER,step_type INTEGER,step_payload BLOB)')
  const varint = n => { const a = []; do { a.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128) } while (n); return Buffer.from(a) }
  const field = (n, value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([varint(n * 8 + 2), varint(b.length), b]) }
  db.prepare('INSERT INTO steps VALUES(?,?,?)').run(0, 14, field(19, field(2, user)))
  db.prepare('INSERT INTO steps VALUES(?,?,?)').run(1, 15, field(20, field(1, text)))
  db.close()
  return { ids, text, user, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), GROK_HOME: path.join(home, '.grok'), XDG_DATA_HOME: path.join(home, '.local/share'), AGY_HOME: agy } }
}
module.exports = { seedAgentFixtures }
