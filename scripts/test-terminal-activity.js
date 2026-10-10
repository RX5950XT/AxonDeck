'use strict'
/**
 * Grok 對話標題與回合狀態。
 * 分頁不要停在 OSC `grok`；側欄狀態看 events.jsonl 的最後一筆，不看整支程序。
 * 用法：node scripts/test-terminal-activity.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { tempDir } = require('./lib/test-temp')
const activity = require('../src/main/terminal/agent-activity')

const ID = '01a12277-56a0-7f30-80cf-fca2dbdd8df7'
const CWD = 'D:\\Workspace\\Personal_Project\\VoiceInk'

function events(rows) {
  return rows.map(row => JSON.stringify(row)).join('\n')
}

function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

check('回合結束是 idle', () => {
  assert.equal(activity.latestGrokState(events([{ type: 'turn_started' }, { type: 'turn_ended' }])), 'idle')
})

check('權限詢問與 permission_prompt 是 waiting', () => {
  assert.equal(activity.latestGrokState(events([{ type: 'permission_requested' }])), 'waiting')
  assert.equal(activity.latestGrokState(events([{ type: 'phase_changed', phase: 'permission_prompt' }])), 'waiting')
})

check('回合開始、工作階段、權限通過後的工具執行是 working', () => {
  assert.equal(activity.latestGrokState(events([{ type: 'turn_started' }])), 'working')
  for (const phase of ['waiting_for_model', 'streaming_reasoning', 'streaming_text', 'tool_execution']) {
    assert.equal(activity.latestGrokState(events([{ type: 'phase_changed', phase }])), 'working', phase)
  }
  assert.equal(activity.latestGrokState(events([
    { type: 'permission_requested' },
    { type: 'permission_resolved' },
    { type: 'phase_changed', phase: 'tool_execution' }
  ])), 'working')
})

check('只有 mcp 事件的新工作階段是 idle，空檔是 null', () => {
  assert.equal(activity.latestGrokState(events([
    { type: 'mcp_config_resolved' },
    { type: 'mcp_init_completed' }
  ])), 'idle')
  assert.equal(activity.latestGrokState(''), null)
  assert.equal(activity.latestGrokState('not-json'), null)
})

check('標題用 generated_title，清掉控制字元並限長', () => {
  assert.equal(activity.grokTitle({ generated_title: 'from generated', session_summary: 'from summary' }), 'from generated')
  assert.equal(activity.grokTitle({ generated_title: '  ', session_summary: 'from summary' }), 'from summary')
  assert.equal(activity.grokTitle({ generated_title: 'hello\u0007world' }), 'helloworld')
  assert.equal(activity.grokTitle({ session_summary: 'a  \n  b' }), 'a b')
  assert.equal(activity.grokTitle({ generated_title: 'x'.repeat(100) }).length, 80)
  assert.equal(activity.grokTitle(null), '')
})

check('安靜逾時不算指令結束，有結束代碼才放開', () => {
  assert.equal(activity.shellCommandOpen({ state: 'running', exitCode: null }), true)
  assert.equal(activity.shellCommandOpen({ state: 'idle', exitCode: null }), true)
  assert.equal(activity.shellCommandOpen({ state: 'idle', exitCode: 0 }), false)
  assert.equal(activity.shellCommandOpen({ state: 'exited', exitCode: 0 }), false)
  assert.equal(activity.shellCommandOpen({ state: 'stopped' }), false)
  assert.equal(activity.shellCommandOpen(null), false)
})

check('工作階段目錄留在 sessions 底下，拒絕跳出與壞 id', () => {
  const home = tempDir('grok-dir-')
  const dir = activity.sessionDir(home, CWD, ID)
  const root = path.resolve(home, 'sessions') + path.sep
  assert.ok(dir.toLowerCase().startsWith(root.toLowerCase()))
  assert.equal(path.basename(dir), ID)
  assert.equal(path.basename(path.dirname(dir)), encodeURIComponent(path.resolve(CWD)))
  assert.equal(activity.sessionDir(home, 'D:\\foo\\..\\bar', ID), '')
  assert.equal(activity.sessionDir(home, 'relative\\path', ID), '')
  assert.equal(activity.sessionDir(home, CWD, '../secret'), '')
  assert.equal(activity.sessionDir(home, CWD, 'short'), '')
})

async function waitFor(fn, label) {
  const start = Date.now()
  while (Date.now() - start < 2000) {
    if (fn()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(label)
}

async function main() {
  const home = tempDir('grok-activity-')
  const dir = activity.sessionDir(home, CWD, ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events([{ type: 'phase_changed', phase: 'tool_execution' }]))
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated_title: 'Terminal tab titles' }))
  const seen = []
  const watcher = activity.createActivity((event, payload) => seen.push({ event, ...payload }), {
    home: () => home,
    debounce: 15
  })
  try {
    const meta = { id: 't_grok', preset: 'grok', cwd: CWD, agentSessionId: ID }
    await watcher.follow(meta)
    assert.equal(watcher.stateOf('t_grok'), 'working')
    assert.equal(seen.some(item => item.event === 'terminal:agent' && item.state === 'working'), true)
    fs.appendFileSync(path.join(dir, 'updates.jsonl'), `${JSON.stringify({ type: 'turn_ended' })}\n`)
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(watcher.stateOf('t_grok'), 'working', 'updates.jsonl 不能拿來判斷狀態')
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `\n${JSON.stringify({ type: 'turn_ended' })}\n`)
    await waitFor(() => watcher.stateOf('t_grok') === 'idle', '回合結束後狀態沒有變成 idle')
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated_title: 'Realtime sidebar status' }))
    await waitFor(() => seen.some(item => item.event === 'terminal:title' && item.title === 'Realtime sidebar status'), '標題沒有跟著 summary.json 更新')
    const other = activity.sessionDir(home, CWD, '01a1228b-39cc-7081-ace6-b48b11db8d35')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'events.jsonl'), events([{ type: 'permission_requested' }]))
    const before = seen.length
    await watcher.follow({ ...meta, agentSessionId: '01a1228b-39cc-7081-ace6-b48b11db8d35' })
    assert.equal(watcher.stateOf('t_grok'), 'waiting')
    assert.equal(seen.slice(before).some(item => item.state === null), false, '換對話不能先送出空狀態')
    watcher.drop('t_grok')
    assert.equal(watcher.stateOf('t_grok'), null)
    assert.equal(seen.at(-1).state, null)
    await watcher.follow({ id: 't_shell', preset: 'shell', cwd: CWD })
    assert.equal(seen.at(-1).id, 't_grok', '不是 Grok 的終端機不該清掉別的狀態')
    console.log('PASS 監看 events.jsonl 與 summary.json')
  } finally {
    watcher.stop()
  }

  const title = await import(pathToFileURL(path.join(__dirname, '../src/renderer/scripts/term-title.js')).href)
  const long = 'Terminal tab titles and realtime sidebar status'
  check('使用者改過的名字優先', () => {
    assert.equal(title.terminalTabTitle({ renamed: true, title: '我自己取的', osTitle: 'VI-TITLE-OK', agentTitle: 'generated' }), '我自己取的')
  })
  check('OSC grok 讓給對話標題，有意義的 OSC 仍優先', () => {
    assert.equal(title.terminalTabTitle({ title: 'Grok CLI · VoiceInk', osTitle: 'grok', agentTitle: 'Terminal tab titles' }), 'Terminal tab titles')
    assert.equal(title.terminalTabTitle({ title: 'Grok CLI · VoiceInk', osTitle: '⠋ grok', agentTitle: 'Terminal tab titles' }), 'Terminal tab titles')
    assert.equal(title.terminalTabTitle({ title: 'Grok CLI · VoiceInk', osTitle: 'VI-TITLE-OK', agentTitle: 'Terminal tab titles' }), 'VI-TITLE-OK')
    assert.equal(title.terminalTabTitle({ title: 'store', osTitle: 'My task - grok', agentTitle: 'generated' }), 'My task - grok')
    assert.equal(title.terminalTabTitle({ title: 'store', osTitle: 'oc | title', agentTitle: '' }), 'oc | title')
  })
  check('沒有對話標題時退回工作階段名稱，通用殼層名稱也讓路', () => {
    assert.equal(title.terminalTabTitle({ title: 'Grok CLI · VoiceInk', osTitle: 'grok', agentTitle: '' }), 'Grok CLI · VoiceInk')
    assert.equal(title.terminalTabTitle({ title: 'Antigravity CLI · VoiceInk', osTitle: 'Windows PowerShell' }), 'Antigravity CLI · VoiceInk')
    assert.equal(title.terminalTabTitle(null), '')
  })
  check('終端機分頁從開頭截斷', () => {
    const label = title.terminalLabel(long, 28)
    assert.equal(label.length, 28)
    assert.equal(label.startsWith('Terminal tab titles'), true)
    assert.equal(label.endsWith('status'), false)
    assert.equal(title.terminalLabel('短標題', 28), '短標題')
  })
}

// 監看與 debounce 都 unref，沒有這個 interval 的話程序會在 await 之前直接退出。
const keepAlive = setInterval(() => {}, 500)
main()
  .catch(error => {
    console.error(`FAIL 監看或分頁標題: ${error.message}`)
    process.exitCode = 1
  })
  .finally(() => clearInterval(keepAlive))
