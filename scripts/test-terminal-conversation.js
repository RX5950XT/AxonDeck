'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const formats = require('../src/main/workspace/agent-formats')

// 導覽只收人類提問與最終文字；不能把思考、工具結果或進度當回答。
assert.equal(typeof formats.conversationTurns, 'function', '缺少對話文字解析')
const user = formats.conversationTurns('claude', { type: 'user', message: { content: '提問' } })
assert.equal(user[0].text, '提問')
assert.deepEqual(formats.conversationTurns('claude', { type: 'user', message: { content: [{ type: 'tool_result', content: '秘密工具結果' }] } }), [])
assert.deepEqual(formats.conversationTurns('claude', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '秘密思考' }] } }), [])
assert.deepEqual(formats.conversationTurns('claude', { type: 'assistant', message: { content: [{ type: 'text', text: '先讀檔' }, { type: 'tool_use', name: 'Read' }] } }), [])
assert.deepEqual(formats.conversationTurns('claude', { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: '先讀檔' }] } }), [], 'Claude 把工具前的文字另存一列，仍不可當最終回答')
for (const channel of ['analysis', 'commentary']) assert.deepEqual(formats.conversationTurns('codex', { type: 'response_item', payload: { type: 'message', role: 'assistant', channel, content: [{ type: 'output_text', text: '過程' }] } }), [])
assert.equal(formats.conversationTurns('codex', { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: '答案' }] } })[0].text, '答案')
assert.deepEqual(formats.conversationTurns('codex', { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '過程' }] } }), [])
assert.deepEqual(formats.conversationTurns('codex', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for D:/test' }] } }), [])
assert.equal(formats.conversationTurns('grok', { type: 'user', content: [{ type: 'text', text: '<user_info>背景</user_info><user_query>真正提問</user_query>' }] })[0].text, '真正提問')
assert.deepEqual(formats.conversationTurns('grok', { type: 'user', content: [{ type: 'text', text: '<system-reminder>\nskills\n</system-reminder>' }] }), [], '系統提醒不是提問')
assert.equal(formats.conversationTurns('grok', { type: 'user', content: [{ type: 'text', text: 'AXON_NAV_GROK_A: 這是測試提問' }] })[0].text, 'AXON_NAV_GROK_A: 這是測試提問')

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/term-conversation.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
const api = vm.runInNewContext(source + '\n;({ appendConversation, findConversationLine, findLastConversationLine, terminalHistoryText, scrollsToBottom, chooseConversationLine, searchBuffer })', { setTimeout, clearTimeout })
assert.equal(api.terminalHistoryText('安全\x1b[2J\x07內容\n下一行'), '安全[2J內容\r\n下一行', '保存紀錄不可執行 ANSI 控制碼')
const cursor = (offset, text = 0) => ({ offset, part: 0, text })
let pairs = api.appendConversation([], [
  { role: 'user', text: '同一個提問', cursor: cursor(1) },
  { role: 'assistant', text: '回答一', cursor: cursor(2) },
  { role: 'assistant', text: '接續', continued: true, cursor: cursor(2, 3) },
  { role: 'user', text: '同一個提問', cursor: cursor(3) },
  { role: 'assistant', text: '中途文字', cursor: cursor(4) },
  { role: 'assistant', text: '回答二', cursor: cursor(5) }
])
assert.equal(pairs.length, 2)
assert.equal(pairs[0].answer, '回答一接續')
assert.equal(pairs[1].answer, '回答二', '只留最後一則回答')
assert.equal(api.scrollsToBottom(pairs, pairs[1], 'answer'), false, '最後一則也停在該則，額度中斷後的輸出留在下面')
assert.equal(api.scrollsToBottom(pairs, pairs[1], 'prompt'), false, '同一輪上面的提問仍跳到該則')
assert.equal(api.scrollsToBottom([{ key: 'only', prompt: '只有提問', answer: '' }], { key: 'only' }, 'prompt'), false, '只有提問時也不把滾軸送到底')
assert.equal(api.chooseConversationLine([9, 17], 1, 0), 9, '同一則在畫面上出現兩次時直接跳到那一列')
assert.equal(api.chooseConversationLine([3, 8], 2, 1), 8, '出現次數相同仍按順序對應')
assert.equal(api.chooseConversationLine([3, 8], 3, 1), -1, '對不上的重複提問不亂猜')
assert.notEqual(pairs[0].key, pairs[1].key, '重複提示詞仍是不同輪')
pairs = api.appendConversation(pairs, [{ role: 'assistant', text: '尾段', continued: true, cursor: cursor(5, 3) }])
assert.equal(pairs[1].answer, '回答二尾段', '跨頁接續不能少字')
const long = api.appendConversation([], [{ role: 'user', text: '長'.repeat(80000), cursor: cursor(9) }])
assert(long[0].prompt.length <= 2000, '導覽只留短預覽，全文按需讀')
assert(long[0].promptTruncated)
const lines = [
  ['› 同一個提問', false], ['回答一接續', false], ['', false],
  ['› 同一個', false], ['提問', true], ['回答二尾段', false]
]
const buffer = { length: lines.length, getLine: i => lines[i] && ({ isWrapped: lines[i][1], translateToString: () => lines[i][0] }) }
assert.equal(api.findConversationLine(buffer, pairs[0].prompt, 0), 0)
assert.equal(api.findConversationLine(buffer, pairs[1].prompt, 1), 3, '折行與相同提問各自定位')
assert.equal(api.findConversationLine(buffer, '不存在', 0), -1, '不猜位置')
const echoLines = ['❯ 很長的第一則提問內容', '很長的第一則提問內容', '● 最終回答第一行', '回答第二行']
const echoBuffer = { length: echoLines.length, getLine: i => ({ isWrapped: false, translateToString: () => echoLines[i] }) }
assert.equal(api.findConversationLine(echoBuffer, '很長的第一則提問內容', 0, true), 0)
assert.equal(api.findConversationLine(echoBuffer, '很長的第一則提問內容', 1, true), -1, 'CLI 回音不是第二則提問')
assert.equal(api.findConversationLine(echoBuffer, '最終回答第一行\n回答第二行', 0), 2, '最終回答有硬換行仍可定位')
const hardWrap = ['修好了。原因很單純：卡片裡四列各用各的小格線排版，', '名字跟倒數文字一長一短，就把中間灰色軌道擠成不一樣長。']
assert.equal(api.findConversationLine({ length: 2, getLine: i => ({ isWrapped: false, translateToString: () => hardWrap[i] }) }, hardWrap.join('')), 0, 'CLI 自己硬換行的回答也要定位')
const fullscreen = { type: 'alternate', length: 1, baseY: 0, cursorY: 0, getLine: () => ({ isWrapped: false, translateToString: () => '› AXON_NAV_OPENCODE_A 測試提問' }) }
const fullscreenTerm = { buffer: { active: fullscreen, normal: { type: 'normal', length: 0, getLine: () => null } } }
const fullscreenBuffer = api.searchBuffer(fullscreenTerm)
assert.ok(fullscreenBuffer, '全螢幕畫面上的提問也要能定位')
assert.equal(api.findConversationLine(fullscreenBuffer, 'AXON_NAV_OPENCODE_A 測試提問', 0), 0)
const gutter = { length: 1, getLine: () => ({ isWrapped: false, translateToString: () => '│ › 很長的第一則提問內容 │' }) }
assert.equal(api.findConversationLine(gutter, '很長的第一則提問內容', 0), 0, '框線不擋定位')
const late = { length: 3, getLine: i => ({ isWrapped: false, translateToString: () => ['舊的', '中間', '› 最新這則提問內容很長'][i] }) }
assert.equal(api.findLastConversationLine(late, '最新這則提問內容很長'), 2, '從畫面底部先找到最新一份')
console.log('PASS 對話篩選、跨頁、重複提問、預覽上限與 xterm 折行定位')

;(async () => {
  const os = require('node:os')
  const { tempDir, removeTree } = require('./lib/test-temp')
  const { seedAgentFixtures } = require('./lib/workspace-agent-fixtures')
  const agents = require('../src/main/workspace/agents')
  const home = tempDir('terminal-conversation-'), project = path.join(home, 'project')
  const fixture = seedAgentFixtures(home, project, true), oldHome = os.homedir
  const saved = Object.fromEntries(Object.keys(fixture.env).map(k => [k, process.env[k]]))
  os.homedir = () => home
  Object.assign(process.env, fixture.env)
  try {
    for (const [agent, id] of Object.entries(fixture.ids)) {
      let next = null, prompts = '', answers = '', pages = 0
      do {
        const page = await agents.sessionConversation(project, agent, id, next)
        for (const turn of page.turns) {
          assert(turn.cursor && !turn.tools?.length && !turn.thought)
          if (turn.role === 'user') prompts += turn.text
          else answers += turn.text
        }
        next = page.nextCursor
        assert(++pages < 100)
      } while (next)
      assert(prompts.includes(fixture.user))
      assert(answers.includes(fixture.text), `${agent} 分頁全文不能少字`)
      if (agent === 'agy') {
        const moved = await agents.sessionConversation(path.join(home, 'other'), agent, id)
        assert(moved.turns.some(turn => turn.role === 'user' && turn.text.includes(fixture.user.slice(0, 8))), '終端機目錄和 AGY 工作區不同仍讀得到這次程序的對話')
      } else {
        await assert.rejects(agents.sessionConversation(path.join(home, 'other'), agent, id), e => e.code === 'SESSION_NOT_FOUND')
      }
      await assert.rejects(agents.sessionConversation(project, agent, id, { offset: -1, part: 0, text: 0 }), e => e.code === 'BAD_CURSOR')
      console.log(`PASS ${agent} 導覽真格式、長文 ${pages} 頁與所有權驗證`)
    }
    // main 只收 terminal id；不能拿 renderer 送來的 session id 或 cwd 去讀檔。
    const service = fs.readFileSync(path.join(__dirname, '../src/main/terminal/service.js'), 'utf8')
    const source = service.slice(service.indexOf('async function conversation('), service.indexOf('\nmodule.exports ='))
    let meta = { cwd: project, preset: 'codex', agentSessionId: fixture.ids.codex }
    const read = vm.runInNewContext(source + '\n;conversation', { agents, store: { get: async id => id === 'mine' ? meta : null }, agentResume: { capture: async () => {} } })
    await assert.rejects(read('other'), e => e.code === 'NO_SESSION')
    const own = await read('mine')
    assert.equal(own.sessionId, fixture.ids.codex)
    assert(!('file' in own), '不把原始檔路徑曝露給導覽')
    meta = { cwd: path.join(home, 'other'), preset: 'codex', agentSessionId: fixture.ids.codex }
    await assert.rejects(read('mine'), e => e.code === 'SESSION_NOT_FOUND')
    meta = { cwd: project, preset: 'shell' }
    assert.equal((await read('mine')).turns.length, 0)
    for (const file of ['src/main/main.js', 'src/main/terminal/ipc.js', 'src/preload/preload.js']) {
      assert(fs.readFileSync(path.join(__dirname, '..', file), 'utf8').includes('conversation'), `${file} 必須接線`)
    }
    console.log('PASS terminal id 邊界、未綁定狀態與 IPC 接線')
  } finally {
    os.homedir = oldHome
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    removeTree(home)
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
