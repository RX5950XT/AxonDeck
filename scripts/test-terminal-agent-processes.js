'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const { identifySessions, resumeId } = require('../src/main/terminal/agent-processes')
const home = tempDir('agent-process-')
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
;(async () => {
  try {
    fs.mkdirSync(path.join(home, 'sessions'))
    fs.writeFileSync(path.join(home, 'sessions/30.json'), JSON.stringify({ pid: 30, sessionId: id }))
    const states = [{ id: 't_own', pid: 10 }], terminals = [{ id: 't_own', preset: 'claude' }]
    const processes = [{ ProcessId: 30, ParentProcessId: 20, Name: 'claude.exe' },
      { ProcessId: 20, ParentProcessId: 10, Name: 'cmd.exe' },
      { ProcessId: 40, ParentProcessId: 99, Name: 'claude.exe', CommandLine: 'claude --resume bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' }]
    const identify = () => identifySessions(states, terminals, [home], async () => processes)
    assert.equal((await identify()).get('t_own'), id, '只採用自身 PTY 子程序，支援亂序程序表')
    fs.writeFileSync(path.join(home, 'sessions/30.json'), JSON.stringify({ pid: 31, sessionId: id }))
    assert.equal((await identify()).size, 0, 'PID 不符不可綁定')
    fs.writeFileSync(path.join(home, 'sessions/30.json'), '{')
    assert.equal((await identify()).size, 0, '讀到半寫入檔不可誤綁')
    assert.equal(resumeId('codex', `codex resume --no-daemon --no-alt-screen ${id}`), id)
    assert.equal(resumeId('grok', `grok --minimal --no-alt-screen --resume ${id}`), id)
    assert.equal(resumeId('grok', `grok --fullscreen --no-alt-screen --resume ${id}`), id)
    assert.equal(resumeId('agy', 'agy --conversation bad;calc'), '')
    assert.equal(resumeId('claude', 'claude --resume ../../file'), '')
    process.env.GROK_HOME = home; process.env.AGY_HOME = home
    const current = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    terminals[0] = { id: 't_own', preset: 'grok', cwd: home }
    processes[0] = { ProcessId: 30, ParentProcessId: 20, Name: 'grok.exe', StartedAt: new Date(Date.now() - 1000).toISOString() }
    fs.writeFileSync(path.join(home, 'active_sessions.json'), JSON.stringify([
      { pid: 30, cwd: home, session_id: id, opened_at: new Date(Date.now() - 500).toISOString() },
      { pid: 30, cwd: home, session_id: current, opened_at: new Date().toISOString() },
      { pid: 40, cwd: home, session_id: id, opened_at: new Date(Date.now() + 1000).toISOString() },
    ]))
    assert.equal((await identify()).get('t_own'), current, 'Grok resume 採用同 PID 最新開啟的 session，不猜標題')
    terminals[0].preset = 'agy'; processes[0].Name = 'agy.exe'
    fs.mkdirSync(path.join(home, 'log'))
    const log = path.join(home, 'log/cli-test.log')
    fs.writeFileSync(log, `I1009 server.go:1624] Starting language server process with pid 30\nI1009 conversation_manager.go:967] Streaming conversation ${id}\n`)
    assert.equal((await identify()).get('t_own'), id)
    fs.appendFileSync(log, `I1009 conversation_manager.go:967] Streaming conversation ${current}\n`)
    assert.equal((await identify()).get('t_own'), current, 'Antigravity resume 依同 PID 的目前串流對話更新')
    const resumed = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    fs.mkdirSync(path.join(home, 'cache'), { recursive: true })
    fs.writeFileSync(path.join(home, 'cache', 'last_conversations.json'), JSON.stringify({ [path.resolve(home)]: resumed, 'D:\\other': id }))
    fs.writeFileSync(log, `I1009 server.go:1624] Starting language server process with pid 30\nI1009 server.go:1675] Language server version: 1.3.2\n`)
    processes[0].StartedAt = new Date().toISOString()
    terminals[0].cwd = home
    assert.equal((await identify()).get('t_own'), resumed, '沒有串流紀錄時用這個目錄最後開過的對話')
    processes[0].StartedAt = new Date(Date.now() + 10000).toISOString()
    assert.equal((await identify()).size, 0, '舊 PID 的紀錄不得被新程序沿用')
    const project = path.join(home, 'Work Project')
    const folder = project.replace(/[^A-Za-z0-9-]/g, '-')
    const dir = path.join(home, 'projects', folder)
    fs.mkdirSync(dir, { recursive: true })
    const older = id
    const newer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    fs.writeFileSync(path.join(dir, `${older}.jsonl`), '{}\n')
    fs.writeFileSync(path.join(dir, `${newer}.jsonl`), '{}\n')
    const now = Date.now()
    fs.utimesSync(path.join(dir, `${older}.jsonl`), now / 1000, (now - 5000) / 1000)
    fs.utimesSync(path.join(dir, `${newer}.jsonl`), now / 1000, now / 1000)
    const pidFile = path.join(home, 'sessions/30.json')
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 30, sessionId: older }))
    fs.utimesSync(pidFile, (now - 60000) / 1000, (now - 60000) / 1000)
    terminals[0] = { id: 't_own', preset: 'claude', cwd: project }
    processes[0] = { ProcessId: 30, ParentProcessId: 20, Name: 'claude.exe', StartedAt: new Date(now - 60000).toISOString() }
    assert.equal((await identify()).get('t_own'), newer, 'Claude /resume 不改 pid 檔時，改綁這個目錄裡較新的紀錄')
    const peers = [{ id: 't_own', preset: 'claude', cwd: project }, { id: 't_other', preset: 'claude', cwd: project }]
    const peerStates = [{ id: 't_own', pid: 10 }, { id: 't_other', pid: 11 }]
    assert.equal((await identifySessions(peerStates, peers, [home], async () => processes)).get('t_own'), older, '同一個目錄兩支 Claude 不猜較新的那份')
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 30, sessionId: newer }))
    fs.utimesSync(pidFile, now / 1000, now / 1000)
    fs.utimesSync(path.join(dir, `${older}.jsonl`), (now + 80) / 1000, (now + 80) / 1000)
    assert.equal((await identify()).get('t_own'), newer, 'pid 檔已改到新對話時，同一秒再寫入的舊 jsonl 不得蓋過')
    delete process.env.GROK_HOME; delete process.env.AGY_HOME
    console.log('PASS 真實程序歸屬、Claude PID 記錄、恢復參數與無效資料守衛')
  } finally { removeTree(home) }
})().catch(error => { console.error(error); process.exitCode = 1 })
