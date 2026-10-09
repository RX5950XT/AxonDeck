'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')
const store = require('../src/main/terminal/store')
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const commands = {
  claude: `claude --resume ${id}`,
  codex: `codex resume --no-daemon --no-alt-screen ${id}`,
  agy: `agy --conversation ${id}`,
  grok: `grok --minimal --no-alt-screen --resume ${id}`,
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
assert.equal(shellEnvironment('', '', 't_test', 'claude', require('node:path').join(os.homedir(), '.claude')).CLAUDE_CONFIG_DIR, undefined, 'Claude 預設 home 不可改找 .claude/.claude.json')
assert.equal(shellEnvironment('', '', 't_test', 'shell').AXONDECK_NAV_JUMP, undefined, '不在 staged 宿主時不猜跳轉檔路徑')
console.log('PASS 五家 AI 的固定接回指令、持久化與指令注入守衛')

async function main() {
  const { createTracker } = require('../src/main/terminal/agent-resume')
  let rows = [{ agent: 'codex', id: 'old-session', mtime: 2000 }]
  let terminals = [{ id: 't_one', preset: 'codex', cwd: 'D:/project' }]
  let states = []
  let runtime = new Map()
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
  const tracker = createTracker(fakeStore, agents, () => 1000, async () => states, async () => runtime)
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
  terminals = [{ id: 't_existing', preset: 'opencode', cwd: 'D:/project' }]
  rows = [{ agent: 'opencode', id: 'ses_existing123', title: '既有對話', mtime: 50 }]
  states = [{ id: 't_existing', title: 'OC | 既有對話' }]
  await tracker.begin(terminals[0]); await tracker.capture()
  assert.equal(terminals[0].agentSessionId, 'ses_existing123', '從 CLI 選擇舊對話也必須建立索引')
  rows.push({ agent: 'opencode', id: 'ses_switched123', title: '切換後的對話', mtime: 60 })
  states[0].title = 'OC | 切換後的對話'
  await tracker.capture()
  assert.equal(terminals[0].agentSessionId, 'ses_switched123', 'CLI 內切換對話不能沿用舊索引')
  terminals = [{ id: 't_codex', preset: 'codex', cwd: 'D:/project' }]
  rows = [{ agent: 'codex', id: 'old-codex-session', title: '原始提示詞', sessionTitle: '真正的對話名稱', mtime: 50 }]
  states = [{ id: 't_codex', title: '真正的對話名稱 | project' }]
  await tracker.begin(terminals[0]); await tracker.capture()
  assert.equal(terminals[0].agentSessionId, 'old-codex-session', 'Codex 以保存的對話名稱對應 OSC 標題')
  states = [{ id: 't_codex', title: '⠋ 真正的對話名稱 | project' }]
  terminals[0].agentSessionId = 'another-codex-session'
  await tracker.capture()
  assert.equal(terminals[0].agentSessionId, 'old-codex-session', 'Codex 標題前面的忙碌圖示不能讓名稱對不上')
  terminals = [{ id: 't_codex_live', preset: 'codex', cwd: 'D:/project', agentStartedAt: 1000, agentSessionId: 'codex-known-old', agentKnownSessions: ['codex-known-old', 'codex-resumed-1'] }]
  rows = [
    { agent: 'codex', id: 'codex-known-old', title: '舊對話', mtime: 500 },
    { agent: 'codex', id: 'codex-resumed-1', title: '接回的對話', sessionTitle: '接回的對話', mtime: 1500 }
  ]
  states = [{ id: 't_codex_live', title: 'Miroxen' }]
  await tracker.begin(terminals[0], true); await tracker.capture()
  assert.equal(terminals[0].agentSessionId, 'codex-resumed-1', 'Codex 標題只有資料夾名稱時，改綁這次執行期間更新的紀錄')
  terminals = [{ id: 't_ambiguous', preset: 'opencode', cwd: 'D:/project' }]
  rows = ['ses_duplicate1', 'ses_duplicate2'].map(id => ({ agent: 'opencode', id, title: '同名', mtime: 50 }))
  states = [{ id: 't_ambiguous', title: 'OC | 同名' }]
  await tracker.begin(terminals[0]); await tracker.capture()
  assert.equal(terminals[0].agentSessionId, undefined, '同名對話不可猜測')
  terminals = [{ id: 't_claude_no_hook', preset: 'claude', cwd: 'D:/project' }]
  rows = [{ agent: 'claude', id, mtime: 50 }]
  states = [{ id: terminals[0].id, pid: 55 }]
  runtime = new Map([[terminals[0].id, id]])
  await tracker.begin(terminals[0], true); await tracker.capture()
  assert.equal(terminals[0].agentSessionId, id, '沙箱沒有 hook 時，以原 PTY 的 Claude session metadata 綁定')
  for (const agent of ['grok', 'agy']) {
    terminals = [{ id: 't_' + agent, preset: agent, cwd: 'D:/project' }]
    rows = [{ agent, id, mtime: 50 }]
    runtime = new Map([[terminals[0].id, id]])
    await tracker.begin(terminals[0], true); await tracker.capture()
    assert.equal(terminals[0].agentSessionId, id, agent + ' 已在 CLI 接續的舊 ID 也可辨識')
  }
  runtime = new Map()
  terminals = [{ id: 't_grok_switch', preset: 'grok', cwd: 'D:/project', agentSessionId: 'old-grok-session' }]
  rows = [
    { agent: 'grok', id: 'old-grok-session', title: '舊對話', mtime: 50 },
    { agent: 'grok', id: 'new-grok-session', title: '新的對話', mtime: 80 }
  ]
  states = [{ id: 't_grok_switch', title: '新的對話 - grok' }]
  await tracker.begin(terminals[0], true); await tracker.capture()
  assert.equal(terminals[0].agentSessionId, 'new-grok-session', '同視窗切到另一段 Grok 對話要改綁')
  const longTitle = '這是一段比較長的對話標題用來確認截斷後仍能對上'
  terminals = [{ id: 't_oc_live', preset: 'opencode', cwd: 'D:/project', agentSessionId: 'ses_oldlive123' }]
  rows = [
    { agent: 'opencode', id: 'ses_oldlive123', title: '舊的 OpenCode', mtime: 50 },
    { agent: 'opencode', id: 'ses_newlive123', title: longTitle, mtime: 90 }
  ]
  states = [{ id: 't_oc_live', title: `[?] OC | ${longTitle.slice(0, 37)}...` }]
  await tracker.begin(terminals[0], true); await tracker.capture()
  assert.equal(terminals[0].agentSessionId, 'ses_newlive123', '同視窗切到另一段 OpenCode 對話要改綁，截斷標題也算')
  tracker.stop()
  await testLateCapture(createTracker)
  await testRejectedBind(createTracker)
  await testAgyOtherWorkspace(createTracker)
  console.log('PASS 啟動基準、新對話綁定、遺失記錄與多終端機歸屬守衛')
}

/** 標題在這一輪已經讀過之後才換；後到的查詢不能沿用那次快照。 */
async function testLateCapture(createTracker) {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let markEntered
  const entered = new Promise(resolve => { markEntered = resolve })
  let title = 'OC | 第一段'
  let reads = 0
  const changes = []
  let terms = [{ id: 't_race', preset: 'opencode', cwd: 'D:/project', agentSessionId: 'ses_first12345', agentStartedAt: 1000 }]
  const rows = [
    { agent: 'opencode', id: 'ses_first12345', title: '第一段', mtime: 50 },
    { agent: 'opencode', id: 'ses_second1234', title: '第二段', mtime: 90 }
  ]
  const tracker = createTracker({
    list: async () => terms,
    setAgentSession: async (key, agent, sessionId) => {
      terms = terms.map(item => item.id === key ? { ...item, preset: agent, agentSessionId: sessionId } : item)
      return true
    }
  }, { sessions: async () => rows, resume: async () => ({}) }, () => 1000, async () => {
    reads += 1
    const snapshot = title
    if (reads === 1) { markEntered(); await gate }
    return [{ id: 't_race', title: snapshot }]
  }, async () => new Map(), (key, sessionId) => changes.push({ key, sessionId }))
  await tracker.begin(terms[0], true)
  const first = tracker.capture()
  await entered
  title = 'OC | 第二段'
  const later = Promise.all([tracker.capture(), tracker.capture()])
  release()
  await first
  await later
  assert.equal(terms[0].agentSessionId, 'ses_second1234', '掃描進行中又來的查詢要看到換過的標題')
  assert.equal(reads, 2, '同一輪進行中只補掃一次')
  assert.deepEqual(changes, [{ key: 't_race', sessionId: 'ses_second1234' }])
  await tracker.capture()
  assert.equal(changes.length, 1, '同一段對話不可重複通知')
  tracker.stop()
}

async function testRejectedBind(createTracker) {
  const tracker = createTracker({
    list: async () => [{ id: 't_reject', preset: 'opencode', cwd: 'D:/project', agentSessionId: 'ses_oldreject1', agentStartedAt: 1000 }],
    setAgentSession: async () => false
  }, {
    sessions: async () => [{ agent: 'opencode', id: 'ses_newreject1', title: '新標題啊啊', mtime: 90 }],
    resume: async () => ({})
  }, () => 1000, async () => [{ id: 't_reject', title: 'OC | 新標題啊啊' }], async () => new Map(),
    () => { throw new Error('寫入被拒不可通知') })
  await tracker.begin({ id: 't_reject', preset: 'opencode' }, true)
  await tracker.capture()
  tracker.stop()
}

async function testAgyOtherWorkspace(createTracker) {
  const saved = []
  const sessionId = '7673a2d8-0000-4000-8000-000000000001'
  const tracker = createTracker({
    list: async () => [{ id: 't_agy', preset: 'agy', cwd: 'D:/VoiceInk', agentStartedAt: 1000 }],
    setAgentSession: async (_id, _agent, value) => { saved.push(value); return true }
  }, {
    sessions: async () => [],
    resume: async () => { throw Object.assign(new Error('missing'), { code: 'SESSION_NOT_FOUND' }) },
    ownedConversation: () => ({ file: 'conversation.db' })
  }, () => 1000, async () => [{ id: 't_agy' }], async () => new Map([['t_agy', sessionId]]), () => {})
  await tracker.begin({ id: 't_agy', preset: 'agy' }, true)
  await tracker.capture()
  tracker.stop()
  assert.equal(saved[0], sessionId, 'AGY 工作區路徑和終端機目錄不同，仍綁定這次程序的對話')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
