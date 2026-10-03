'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')
const store = require('../src/main/terminal/store')
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const commands = {
  claude: `claude --resume ${id}`,
  codex: `codex resume --no-daemon ${id}`,
  agy: `agy --conversation ${id}`,
  grok: `grok --resume ${id}`,
  opencode: 'opencode --session ses_123456789'
}

for (const [agent, command] of Object.entries(commands)) {
  const sessionId = agent === 'opencode' ? 'ses_123456789' : id
  assert.equal(store.startupCommand(agent, undefined, sessionId), command, `${agent} 應接回指定對話`)
  assert.equal(store.startupCommand(agent, undefined, `${sessionId};calc`), store.PRESETS[agent].command)
  const row = store.sanitizeAll([{ id: 't_resume', preset: agent, cwd: os.homedir(), agentSessionId: sessionId }])[0]
  assert.equal(row.agentSessionId, sessionId, `${agent} 對話 ID 應持久化`)
}
assert.equal(store.startupCommand('shell', undefined, id), '')
const { shellEnvironment } = require('../src/main/terminal/pty')
assert.equal(shellEnvironment('', '', 't_test', 'codex', 'D:/own-runtime').CODEX_HOME, 'D:/own-runtime')
assert.equal(shellEnvironment('', '', 't_test', 'claude', 'D:/own-runtime').CLAUDE_CONFIG_DIR, 'D:/own-runtime')
assert.notEqual(shellEnvironment('', '', 't_test', 'codex', '../untrusted').CODEX_HOME, '../untrusted')
console.log('PASS 五家 AI 的固定接回指令、持久化與指令注入守衛')

async function main() {
  const { createTracker } = require('../src/main/terminal/agent-resume')
  let rows = [{ agent: 'codex', id: 'old-session', mtime: 2000 }]
  let terminals = [{ id: 't_one', preset: 'codex', cwd: 'D:/project' }]
  const saved = []
  const fakeStore = {
    list: async () => terminals,
    setAgentTracking: async (key, started, known) => {
      terminals = terminals.map(t => t.id === key ? { ...t, agentStartedAt: started, agentKnownSessions: known } : t)
    },
    setAgentSession: async (key, agent, sessionId) => {
      saved.push({ key, agent, sessionId })
      terminals = terminals.map(t => t.id === key ? { ...t, preset: agent, agentSessionId: sessionId } : t)
    }
  }
  const agents = {
    sessions: async cwd => cwd === 'D:/project' ? rows : [],
    resume: async (cwd, agent, sessionId) => {
      if (!rows.some(r => r.agent === agent && r.id === sessionId)) throw Object.assign(new Error('missing'), { code: 'SESSION_NOT_FOUND' })
      return { agent, sessionId }
    }
  }
  const tracker = createTracker(fakeStore, agents, () => 1000)
  await tracker.begin(terminals[0])
  await tracker.capture()
  assert.equal(saved.length, 0, '啟動前的記錄不可被認作新對話')
  rows.push({ agent: 'codex', id: 'new-session', mtime: 1001 })
  await tracker.capture()
  assert.deepEqual(saved[0], { key: 't_one', agent: 'codex', sessionId: 'new-session' })
  const safe = await tracker.prepare(terminals[0])
  assert.equal(safe.agentSessionId, 'new-session')
  rows = []
  assert.equal((await tracker.prepare(terminals[0])).agentSessionId, undefined, '消失的記錄不可盲目接回')

  terminals = [{ id: 't_two', preset: 'grok', cwd: 'D:/project' }, { id: 't_three', preset: 'grok', cwd: 'D:/project' }]
  await tracker.begin(terminals[0]); await tracker.begin(terminals[1])
  rows = [{ agent: 'grok', id: 'fresh-first', mtime: 1002 }, { agent: 'grok', id: 'fresh-second', mtime: 1003 }]
  await tracker.capture()
  assert.equal(saved.length, 1, '同時新對話無法分辨歸屬時不可亂接')
  tracker.stop()
  console.log('PASS 啟動基準、新對話綁定、遺失記錄與多終端機歸屬守衛')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
