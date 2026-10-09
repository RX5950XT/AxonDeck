'use strict'
/** 真實 IPC／五家記錄／xterm／滑鼠；不啟動 AI CLI，也不碰真實登入或剪貼簿。
 * 用法：node scripts/e2e-terminal-conversation-cdp.js（AXONDECK_EXE 可指向隔離打包版）
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir, removeTree } = require('./lib/test-temp')
const { seedAgentFixtures } = require('./lib/workspace-agent-fixtures')
const root = path.join(__dirname, '..')
const profile = tempDir('terminal-conversation-cdp-')
const home = path.join(profile, 'home'), project = path.join(profile, 'project')
fs.mkdirSync(project)
const fixture = seedAgentFixtures(home, project)
const codexFile = path.join(fixture.env.CODEX_HOME, 'sessions', 'rollout-' + fixture.ids.codex + '.jsonl')
const firstPrompt = '請確認導覽第一輪的位置', firstAnswer = '第一輪已確認，這是完整的最終回答。'
const oldPrompt = '查看已經不在終端機畫面的舊紀錄'
const giant = '完整長文內容'.repeat(60000) + '長文最後驗收'
const rows = [{ type: 'session_meta', payload: { id: fixture.ids.codex, cwd: project } }]
const message = (role, text, channel) => ({ type: 'response_item', payload: { type: 'message', role, channel, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })
rows.push(message('user', firstPrompt), message('assistant', '不應顯示的過程', 'commentary'), message('assistant', firstAnswer, 'final'))
for (const text of ['第一個重複回答', '第二個重複回答']) rows.push(message('user', '再次確認設定'), message('assistant', text, 'final'))
rows.push(message('user', oldPrompt), message('assistant', '這輪仍可閱讀完整紀錄。', 'final'))
rows.push(message('user', '請閱讀長文'), message('assistant', giant, 'final'))
rows.push(message('user', '這輪還在等待回答'))
const writeCodex = () => fs.writeFileSync(codexFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
writeCodex()
fs.writeFileSync(path.join(fixture.env.CODEX_HOME, 'session_index.jsonl'), JSON.stringify({ id: fixture.ids.codex, thread_name: 'Codex 導覽驗收' }) + '\n')
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false, agyEnabled: false, closeToTray: false, autoUpdate: false, uffsAuto: false }))
fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({ projects: [{ id: 'w_nav_test', name: '對話導覽驗收', path: project, createdAt: Date.now() }] }))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(test, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const value = await test(); if (value) return value; await delay(150) }
  throw new Error(label)
}
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) })
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let id = 0
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), fn = pending.get(message.id)
    if (fn) { pending.delete(message.id); fn(message) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id, timeout = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout ' + method)) }, 30000)
    pending.set(key, message => { clearTimeout(timeout); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result) })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
  return { ws, send, eval: async expression => {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text)
    return value.result?.value
  } }
}
let child, cdp, mainCdp, count = 0
const pass = label => { count++; console.log('PASS ' + label) }
async function main() {
  const debug = await port(), inspector = await port()
  const exe = process.env.AXONDECK_EXE || path.join(root, 'dist/win-unpacked/AxonDeck.exe')
  const env = { ...process.env, ...fixture.env }
  for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key]
  child = spawn(exe, ['--hidden', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${debug}`, `--inspect=127.0.0.1:${inspector}`, `--user-data-dir=${profile}`], { detached: true, stdio: 'ignore', env })
  const targets = p => fetch(`http://127.0.0.1:${p}/json/list`).then(r => r.json()).catch(() => [])
  cdp = await connect((await wait(async () => (await targets(debug)).find(row => /index\.html/.test(row.url)), '主視窗未啟動')).webSocketDebuggerUrl)
  mainCdp = await connect((await wait(async () => (await targets(inspector))[0], 'main inspector 未啟動')).webSocketDebuggerUrl)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await wait(() => cdp.eval('!!window.electronAPI?.terminal?.conversation'), '缺少 IPC')
  await cdp.eval(`(async () => {
    const { Terminal } = await import('../../node_modules/@xterm/xterm/lib/xterm.mjs')
    const open = Terminal.prototype.open
    window.__navTerms = new Map()
    Terminal.prototype.open = function(el) { window.__navTerms.set(el.dataset.id, this); return open.call(this, el) }
  })()`)
  const buffer = `› ${firstPrompt}\r\n${firstAnswer}\r\n` + '填充列\r\n'.repeat(80) + '› 再次確認設定\r\n第一個重複回答\r\n› 再次確認設定\r\n第二個重複回答\r\n' + '後續輸出\r\n'.repeat(70)
  await mainCdp.eval(`(() => {
    const HostClient = process.mainModule.require(process.mainModule.require('electron').app.getAppPath() + '/src/main/terminal/host-client.js').HostClient
    const states = new Map()
    HostClient.prototype.request = async function(op, args) {
      if (op === 'list') return [...states.values()]
      if (op === 'open') {
        states.set(args.sessionId, { id: args.sessionId, state: 'idle', title: args.meta.preset === 'codex' ? 'Codex 導覽驗收 | project' : args.meta.preset === 'opencode' ? 'OC | OpenCode 測試' : '' })
        return { id: args.sessionId, seq: 0, buffer: ${JSON.stringify(buffer)} }
      }
      if (op === 'forget') states.delete(args.sessionId)
      return true
    }
  })()`)
  const ids = {}
  for (const [agent, agentSessionId] of Object.entries(fixture.ids)) {
    const unbound = ['codex', 'opencode'].includes(agent)
    const created = await cdp.eval(`electronAPI.terminal.create(${JSON.stringify({ shell: 'powershell', preset: agent, cwd: project, projectId: 'w_nav_test', ...(unbound ? {} : { agentSessionId }) })})`)
    assert(created.ok, JSON.stringify(created))
    ids[agent] = created.data.id
    if (unbound) await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.openTerminalSession(${JSON.stringify(ids[agent])}))`)
    const page = await cdp.eval(`electronAPI.terminal.conversation(${JSON.stringify(ids[agent])})`)
    assert(page.ok && page.data.sessionId === agentSessionId && page.data.turns.length > 0)
    assert(page.data.turns.every(t => !t.tools?.length && !t.thought))
  }
  pass('五家記錄經真實 IPC 讀取，所有權與純對話格式正確')
  pass('Codex／OpenCode 從未綁定終端機辨識 CLI 已接續的舊對話，沒有預填 ID')
  assert.equal((await cdp.eval("electronAPI.terminal.conversation('not-mine')")).ok, false)
  pass('不存在的 terminal id 被拒絕')
  const id = ids.codex
  const pane = `.term-pane[data-id="${id}"]`
  const query = selector => `document.querySelector(${JSON.stringify(pane + ' ' + selector)})`
  await cdp.eval(`import('./scripts/terminal-page.js').then(m => m.openTerminalSession(${JSON.stringify(id)}))`)
  await wait(() => cdp.eval(`${query('.term-conversation-list')}.children.length === 6`), '六輪對話未載入')
  pass('跨頁長文完整掃描成六輪導覽')
  assert.equal(await cdp.eval(`!!${query('.term-conversation-close')}`), false)
  pass('導覽不再顯示叉叉按鈕')
  async function mouse(selector, click = false) {
    if (click) await cdp.eval(`${query(selector)}?.scrollIntoView({ block: 'nearest', behavior: 'instant' })`)
    const rect = await wait(() => cdp.eval(`(() => { const n = ${query(selector)}; if(!n || !n.offsetHeight) return null; const r=n.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+Math.min(r.height/2,14)} })()`), '控制項不可見：' + selector)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    if (click) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 })
    }
  }
  async function dragScrollbar(selector, fraction) {
    const rect = await cdp.eval(`(() => { const b=document.querySelector(${JSON.stringify(selector)}); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,start:r.top+17+(r.height-34)*Number(b.value)/Number(b.max),end:r.top+17+(r.height-34)*${fraction}} })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.start })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.start, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.end, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.end, button: 'left', clickCount: 1 })
  }
  for (const [agent, terminalId] of Object.entries(ids)) {
    await cdp.eval(`import('./scripts/terminal-page.js').then(m => m.openTerminalSession(${JSON.stringify(terminalId)}))`)
    const selector = `.term-pane[data-id="${terminalId}"] .term-scrollbar`
    await wait(() => cdp.eval(`(() => { const b=document.querySelector(${JSON.stringify(selector)}); return b?.offsetHeight > 0 && !b.disabled && Number(b.max)>0 })()`), agent + ' 缺少捲軸')
    const position = await cdp.eval(`(() => { const p=document.querySelector(${JSON.stringify(`.term-pane[data-id="${terminalId}"]`)});const b=p.querySelector('.term-scrollbar').getBoundingClientRect();const t=p.querySelector('.term-conversation-toggle').getBoundingClientRect();const r=p.getBoundingClientRect(); return {aligned:Math.abs(b.left+b.width/2-t.left-t.width/2)<1,top:t.top-r.top<1,thumb:getComputedStyle(p.querySelector('.term-scrollbar')).accentColor} })()`)
    assert(position.aligned && position.top && !['transparent', 'rgba(0, 0, 0, 0)'].includes(position.thumb), JSON.stringify(position))
    await dragScrollbar(selector, .15)
    await wait(() => cdp.eval(`__navTerms.get(${JSON.stringify(terminalId)}).buffer.active.viewportY < __navTerms.get(${JSON.stringify(terminalId)}).buffer.active.baseY / 2`), agent + ' 捲軸沒有捲到上方')
    await dragScrollbar(selector, .9)
    await wait(() => cdp.eval(`__navTerms.get(${JSON.stringify(terminalId)}).buffer.active.viewportY > __navTerms.get(${JSON.stringify(terminalId)}).buffer.active.baseY / 2`), agent + ' 捲軸沒有捲到下方')
    const before = await cdp.eval(`__navTerms.get(${JSON.stringify(terminalId)}).buffer.active.viewportY`)
    const rect = await cdp.eval(`document.querySelector(${JSON.stringify(`.term-pane[data-id="${terminalId}"] .xterm-screen`)}).getBoundingClientRect().toJSON()`)
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseWheel',x:rect.x+rect.width/2,y:rect.y+rect.height/2,deltaX:0,deltaY:-400})
    await wait(() => cdp.eval(`(() => { const t=__navTerms.get(${JSON.stringify(terminalId)}),b=document.querySelector(${JSON.stringify(selector)});return t.buffer.active.viewportY < ${before} && Number(b.value)===t.buffer.active.viewportY })()`), agent+' 滾輪和捲軸未同步')
    pass(agent + ' 真滑鼠拖曳和滾輪共用實際列號，導覽在同欄右上角')
    const agentPane = `.term-pane[data-id="${terminalId}"]`
    const agentQuery = suffix => `document.querySelector(${JSON.stringify(agentPane + ' ' + suffix)})`
    async function clickAgent(suffix) {
      const rect = await wait(() => cdp.eval(`(() => { const n=${agentQuery(suffix)}; if(!n?.offsetHeight) return null; n.scrollIntoView({block:'nearest'}); const r=n.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+Math.min(14,r.height/2)} })()`), agent + ' 清單不可見')
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type,...rect,button:'left',clickCount:1})
    }
    await clickAgent('.term-conversation-toggle')
    await clickAgent('.term-conversation-turn:first-child [data-role="prompt"]')
    await wait(() => cdp.eval(`${agentQuery('.term-conversation-turn:first-child [data-role="prompt"]')}.getAttribute('aria-current')==='true'`), agent + ' 提問未跳轉')
    const expected = agent === 'codex' ? firstPrompt : fixture.user.slice(0, 40)
    assert(await cdp.eval(`(() => { const t=__navTerms.get(${JSON.stringify(terminalId)}),b=t.buffer.active; return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||'').join('').includes(${JSON.stringify(expected)}) })()`), agent + ' 提問不在可見畫面')
    await clickAgent('.term-conversation-toggle')
    const latest = '.term-conversation-turn:last-child button:last-child'
    await clickAgent(latest)
    const deadline = Date.now() + 30000
    let detail
    while (Date.now() < deadline) {
      detail = await cdp.eval(`(() => { const t=__navTerms.get(${JSON.stringify(terminalId)}),b=t.buffer.active; const row=${agentQuery(latest)}; const needle=(row?.querySelector('span')?.textContent||'').replace(/\\s+/g,'').slice(0,16); const top=(b.getLine(b.viewportY)?.translateToString(true)||'').replace(/\\s+/g,''); return {ok:row?.getAttribute('aria-current')==='true'&&!!needle&&top.includes(needle)&&b.viewportY<b.baseY,current:row?.getAttribute('aria-current'),needle,top:top.slice(0,80),y:b.viewportY,base:b.baseY} })()`)
      if (detail?.ok) break
      await delay(150)
    }
    assert(detail?.ok, agent + ' 最新項目沒有停在該則 ' + JSON.stringify(detail))
    await cdp.eval(`window.__agentInput='';window.__agentInputSub=__navTerms.get(${JSON.stringify(terminalId)}).onData(s=>window.__agentInput+=s)`)
    await cdp.send('Input.insertText', {text:'NAV_UNSENT_DRAFT'})
    assert.equal(await cdp.eval('window.__agentInput'), 'NAV_UNSENT_DRAFT', agent + ' 跳轉後不能輸入')
    await cdp.eval('window.__agentInputSub.dispose()')
    pass(agent + ' 真點選提問定位、最新項目停在該則、同一終端機仍接收輸入')
  }
  const unbound = await cdp.eval(`electronAPI.terminal.create(${JSON.stringify({ shell: 'powershell', preset: 'grok', cwd: project, projectId: 'w_nav_test' })})`)
  const unboundId = unbound.data.id, unboundPane = `.term-pane[data-id="${unboundId}"]`
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.openTerminalSession(${JSON.stringify(unboundId)}))`)
  const unboundBar = `document.querySelector(${JSON.stringify(unboundPane + ' .term-scrollbar')})`
  assert.equal(await cdp.eval(`${unboundBar}.disabled`), false, '未綁定紀錄也必須能拖動捲軸')
  await dragScrollbar(unboundPane + ' .term-scrollbar', .2)
  assert(await cdp.eval(`__navTerms.get(${JSON.stringify(unboundId)}).buffer.active.viewportY < Number(${unboundBar}.max)/2`))
  await dragScrollbar(unboundPane + ' .term-scrollbar', .8)
  assert(await cdp.eval(`__navTerms.get(${JSON.stringify(unboundId)}).buffer.active.viewportY > Number(${unboundBar}.max)/2`))
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.deleteTerminalSession(${JSON.stringify(unboundId)}))`)
  pass('未綁定對話 ID 仍可真滑鼠拖曳上下捲動')
  await cdp.eval(`import('./scripts/terminal-page.js').then(m => m.openTerminalSession(${JSON.stringify(id)}))`)
  const row = (index, role) => `.term-conversation-turn:nth-child(${index}) [data-role="${role}"]`
  async function jump(index, role) {
    await mouse('.term-conversation-toggle')
    await mouse(row(index, role), true)
    await wait(() => cdp.eval(`${query(row(index, role))}.getAttribute('aria-current') === 'true'`), '未完成訊息跳轉')
    return cdp.eval(`(() => { const t=__navTerms.get(${JSON.stringify(id)}); const b=t.buffer.active; return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||'').join('\\n') })()`)
  }
  const cols = await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).cols`)
  await mouse('.term-conversation-toggle')
  await wait(() => cdp.eval(`${query('.term-conversation-panel')}.offsetHeight > 0`), 'hover 未展開')
  assert.equal(await cdp.eval(`!!${query('.term-conversation-preview')} || !!${query('.term-conversation-reader')} || !!${query('.term-conversation-refresh')}`), false)
  const listText = await cdp.eval(`${query('.term-conversation-list')}.textContent`)
  assert(listText.includes(firstPrompt) && listText.includes(firstAnswer) && !listText.includes('不應顯示的過程'))
  await mouse('.term-conversation-toggle', true)
  await mouse('.xterm-screen')
  await wait(() => cdp.eval(`${query('.term-conversation-panel')}.hidden`), '離開仍未收合')
  assert.equal(await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).cols`), cols)
  pass('選單只有可點選提問／回答，滑入展開離開收合，沒有閱讀面板與重讀按鈕')
  assert((await jump(1, 'prompt')).includes(firstPrompt))
  const restoredPromptLine = await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).buffer.active.viewportY`)
  assert(restoredPromptLine >= 0)
  assert((await jump(1, 'answer')).includes(firstAnswer))
  assert(await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).buffer.active.viewportY > ${restoredPromptLine}`))
  assert.equal(await cdp.eval(`!!${query('.term-history-screen')}`), false)
  pass('選單提問與回答各自直接捲到現有 xterm 訊息')
  assert((await jump(3, 'prompt')).includes('第二個重複回答'))
  assert((await jump(3, 'answer')).includes('第二個重複回答'))
  pass('相同提示詞依現場出現順序定位，回答仍在同一 CLI')
  const selectedLine = await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).buffer.active.viewportY`)
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.openTerminalSession(${JSON.stringify(ids.claude)}))`)
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.openTerminalSession(${JSON.stringify(id)}))`)
  assert.equal(await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).buffer.active.viewportY`), selectedLine)
  assert.equal(await cdp.eval(`${query('.term-conversation-list')}.children.length`), 6)
  pass('切回仍保留對話索引與原 CLI 捲動位置')
  assert((await jump(4, 'prompt')).includes(oldPrompt))
  assert((await jump(5, 'answer')).includes('完整長文內容'))
  assert.equal(await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).options.disableStdin`), false)
  pass('CLI 沒重播的舊訊息與完整長回答已補回同一顆可輸入終端機')
  await cdp.eval(`(async () => { const t=__navTerms.get(${JSON.stringify(id)}); t.reset(); await new Promise(r=>t.write('畫面已重新繪製\\r\\n',r));window.__navInputs=[]; window.__navInputSubscription=t.onData(s=>__navInputs.push(s)) })()`)
  await mouse('.term-conversation-toggle')
  await mouse(row(1,'prompt'), true)
  await wait(() => cdp.eval(`${query(row(1,'prompt'))}.getAttribute('aria-current') === 'true'`), '遺失的舊紀錄應自動補回並跳轉')
  assert.equal(await cdp.eval(`!!${query('.term-history-screen')}`), false, '點選不得替換仍可輸入的終端機')
  assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(pane)}).querySelectorAll('.term-screen').length`), 1)
  assert(await cdp.eval(`(() => { const b=__navTerms.get(${JSON.stringify(id)}).buffer.active;return b.getLine(b.viewportY).translateToString(true).includes(${JSON.stringify(firstPrompt)}) })()`))
  await mouse('.xterm-screen', true)
  await cdp.send('Input.insertText', { text: '跳轉後繼續輸入' })
  assert((await cdp.eval('__navInputs.join("")')).includes('跳轉後繼續輸入'))
  assert.equal(await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.pasteIntoFocusedTerminal('語音輸入仍可接續'))`), true)
  assert((await cdp.eval('__navInputs.join("")')).includes('語音輸入仍可接續'))
  pass('遺失的舊畫面自動補回同一終端機，鍵盤與語音仍送往原 CLI')
  await cdp.eval(`new Promise(r=>__navTerms.get(${JSON.stringify(id)}).write(${JSON.stringify(buffer)},r))`)
  await cdp.eval('window.__navInputs.length=0')
  await cdp.eval(`__navTerms.get(${JSON.stringify(id)}).scrollToBottom()`)
  await mouse('.term-conversation-toggle')
  // 同一次 JS 工作中點選並讀位置：不能等待逐步捲動完成。
  const instant = await cdp.eval(`(() => { ${query(row(1,'prompt'))}.click(); const t=__navTerms.get(${JSON.stringify(id)}); const b=t.buffer.active; return {top:b.viewportY,base:b.baseY,line:(b.getLine(b.viewportY)?.translateToString(true)||''),input:__navInputs.join('')} })()`)
  assert(instant.line.includes(firstPrompt) && instant.top < instant.base, JSON.stringify(instant))
  assert.equal(instant.input, '')
  pass('點選同一瞬間到達指定列，沒有送逐段滾輪或 CLI 指令')
  await dragScrollbar(pane + ' .term-scrollbar', .15)
  const held = await cdp.eval(query('.term-scrollbar')+'.value')
  await mainCdp.eval('process.mainModule.require("electron").BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).webContents.send("terminal:data",'+JSON.stringify({id,seq:1,data:'CLI 繼續輸出\r\n'})+')')
  await wait(() => cdp.eval('(() => { const b=__navTerms.get('+JSON.stringify(id)+').buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||"").join("").includes("CLI 繼續輸出") })()'), 'CLI 原畫面沒有繼續更新')
  assert.equal(await cdp.eval(query('.term-scrollbar')+'.value'), held)
  await dragScrollbar(pane + ' .term-scrollbar', .85)
  assert.equal(await cdp.eval('__navInputs.length'), 0)
  await cdp.eval('__navInputSubscription.dispose()')
  pass('拖曳及持續輸出不回彈，所有動作只移動原终端機視窗')
  rows.push(message('assistant', '第六輪剛剛完成', 'final')); writeCodex()
  await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).webContents.send('terminal:data',{id:${JSON.stringify(id)},seq:2,data:'新的輸出\\r\\n'})`)
  await wait(() => cdp.eval(`${query('.term-conversation-list')}.textContent.includes('第六輪剛剛完成')`), '新最終回答未更新')
  pass('索引直接讀取保存紀錄，新最終回答自動出現在清單')
  await mouse('.term-conversation-toggle')
  await cdp.eval(`${query(row(1,'prompt'))}.focus()`)
  await cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape'})
  await cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape'})
  assert.equal(await cdp.eval(`${query('.term-conversation-panel')}.hidden`), true)
  pass('鍵盤選單可用，Escape 收合')
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.toggleTerminalSplit(${JSON.stringify(ids.claude)}))`)
  await wait(() => cdp.eval('document.querySelectorAll(".term-pane.is-active").length===2'), '分割未建立')
  for (const width of [1440,900,560]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
    await mouse('.xterm-screen')
    await mouse('.term-conversation-toggle')
    await wait(() => cdp.eval(`(() => { const r=document.querySelector(${JSON.stringify(pane)}).getBoundingClientRect();const n=${query('.term-conversation-panel')}.getBoundingClientRect();return n.width>0 && n.left>=r.left-1 && n.right<=r.right+1 })()`), '窄畫面選單跨格：' + width).catch(async error => { throw new Error(error.message+' '+JSON.stringify(await cdp.eval(`({pane:document.querySelector(${JSON.stringify(pane)}).getBoundingClientRect().toJSON(),panel:${query('.term-conversation-panel')}.getBoundingClientRect().toJSON(),hidden:${query('.term-conversation-panel')}.hidden})`))) })
  }
  assert.equal(await cdp.eval('document.querySelectorAll(".term-pane.is-active .term-scrollbar").length'),2)
  pass('兩格都有獨立捲軸，1440／900／560px 清單不跨格')
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.toggleTerminalSplit(${JSON.stringify(ids.claude)}))`)
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.openTerminalSession(${JSON.stringify(id)}))`)
  await mouse('.term-scrollbar')
  await cdp.eval(`${query('.term-conversation-toggle')}.focus()`)
  await wait(() => cdp.eval(`${query('.term-conversation-panel')}.offsetHeight>0`), '截圖前選單未展開')
  const screenshot = await cdp.send('Page.captureScreenshot',{format:'png'})
  fs.writeFileSync(path.join(path.dirname(exe),'navigation.png'),Buffer.from(screenshot.data,'base64'))
  await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.deleteTerminalSession(${JSON.stringify(id)}))`)
  assert.equal(await cdp.eval(`!!document.querySelector(${JSON.stringify(pane)})`),false)
  pass('刪除終端機清除歷史畫面、索引與捲軸')
  console.log(`${count} passed, 0 failed`)
}
main().catch(error => { console.error('FAIL', error.stack); process.exitCode = 1 }).finally(() => {
  cdp?.ws.close(); mainCdp?.ws.close()
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 本測試實例已結束 */ }
    child.kill()
  }
  removeTree(profile)
})
