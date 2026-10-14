// npx electron scripts/test-terminal-session-switch.js
'use strict'
const assert = require('node:assert/strict')
const { app } = require('electron')
const { tempDir } = require('./lib/test-temp')
const home = tempDir('terminal-session-switch-')
app.setPath('userData', home)
app.whenReady().then(async () => {
  const store = require('../src/main/terminal/store')
  const { createTracker } = require('../src/main/terminal/agent-resume')
  const terminal = await store.create({ shell: 'cmd', preset: 'grok', cwd: home })
  const rows = [
    { agent: 'grok', id: 'grok-session-a', title: 'First', mtime: 1000 },
    { agent: 'grok', id: 'grok-session-b', title: 'Second', mtime: 2000 },
  ]
  let title = 'First - grok'
  const tracker = createTracker(store, { sessions: async () => rows }, () => 1000,
    async () => [{ id: terminal.id, title }])
  try {
    await tracker.begin(terminal)
    await tracker.capture()
    assert.equal((await store.get(terminal.id)).agentSessionId, rows[0].id)
    title = 'Second - grok'
    await tracker.capture()
    assert.equal((await store.get(terminal.id)).agentSessionId, rows[1].id, '同一 CLI 切換後，真 store 必須保存新的對話 ID')
    assert.equal(await store.setAgentSession(terminal.id, 'grok', rows[0].id, 999), false, '舊執行階段不可蓋過新的追蹤')
    assert.equal(await store.setAgentSession(terminal.id, 'codex', 'codex-session', 1000), false, '不同工具不可蓋過原追蹤')
    assert.equal((await store.get(terminal.id)).agentSessionId, rows[1].id)
    console.log('PASS 真 store 切換對話與過期追蹤守衛')
  } finally { tracker.stop() }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
