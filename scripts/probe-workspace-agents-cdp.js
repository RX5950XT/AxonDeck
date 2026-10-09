'use strict'
// 五種真實記錄格式走 packaged IPC 與畫面；隔離 profile，只收本輪 PID。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { createHash } = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const { seedAgentFixtures } = require('./lib/workspace-agent-fixtures')
const root = path.resolve(__dirname, '..')
const exe = process.env.AXONDECK_EXE || path.join(root, 'dist/win-unpacked/AxonDeck.exe')
const profile = tempDir('agents-profile-')
const project = tempDir('agents-project-')
const other = tempDir('agents-other-')
const fixture = seedAgentFixtures(tempDir('agents-home-'), project, true)
const projectId = 'w_agents_probe'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, cdp, mainCdp

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function wait(check, message, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await delay(150)
  }
  throw new Error(message)
}
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data)
    if (!pending.has(msg.id)) return
    const callback = pending.get(msg.id)
    pending.delete(msg.id)
    callback(msg)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout')) }, 30000)
    pending.set(key, msg => {
      clearTimeout(timer)
      if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)))
      else resolve(msg.result)
    })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
  return { ws, send, eval: async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value }
}
async function target(port) {
  return wait(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => /index\.html/.test(t.url)) } catch { return null }
  }, '主畫面沒有啟動')
}
function expectedHash(agent) {
  const hash = createHash('sha256')
  if (agent === 'claude') {
    for (let i = 0; i < 75; i++) { hash.update(fixture.user + i); hash.update(i === 0 ? fixture.text : '回答' + i) }
  } else { hash.update(fixture.user); hash.update(fixture.text) }
  return hash.digest('hex')
}

async function click(selector) {
  const point = await cdp.eval(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function screenshot(name) {
  const out = path.join(root, 'dist/ai-session-layout-qa')
  fs.mkdirSync(out, { recursive: true })
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, name), Buffer.from(shot.data, 'base64'))
}

async function compactLayout() {
  const text = '完整對話\n'.repeat(50) + '最末尾驗收'
  const detail = '工具第一行\n第二行\n' + '很長的路徑/'.repeat(80) + '<script>不可當作 HTML</script>'
  const data = { agent: 'codex', sessionId: 'layout-test', file: 'C:/layout-record.jsonl', prompts: [text], toolCallsCount: 3,
    toolCallsBreakdown: { Read: 2, Write: 1 }, editedFiles: ['src/完整路徑.js'], readFiles: ['src/只是讀過.js'],
    turns: [{ role: 'user', text }, { role: 'assistant', text: '先檢查' },
      { role: 'assistant', tools: [{ name: 'Read', detail }] },
      { role: 'assistant', tools: [{ name: 'Write', detail: '第二份完整內容' }] },
      { role: 'assistant', text: '完整回答\n最末尾驗收' },
      { role: 'assistant', tools: [{ name: 'Read', detail: '最後一份完整內容' }] }]
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.eval(`import('./scripts/ws-ai-session.js').then(m => {
    m.stopAiSessionWatch(); globalThis.__layoutActions=[];
    globalThis.__layoutTab={title:'排版驗收',sessionRow:{agentLabel:'Claude Code',title:'長標題排版驗收完整內容 '.repeat(80)},sessionData:${JSON.stringify(data)}};
    const els={bar:document.getElementById('wsAiSessionBar'),body:document.getElementById('wsAiSessionBody'),
      title:document.getElementById('wsAiSessionTitle'),meta:document.getElementById('wsAiSessionMeta'),
      resumeBtn:document.getElementById('wsAiResumeBtn'),resumeIntoBtn:document.getElementById('wsAiResumeIntoBtn'),copyPathBtn:document.getElementById('wsAiCopyPathBtn')};
    globalThis.__layoutPaint=()=>m.paintAiSession({ tab:__layoutTab,
      els, terminals:()=>[], onResume:id=>__layoutActions.push('resume:'+id),onCopyPath:file=>__layoutActions.push(file),
      onOpenFile:rel=>__layoutActions.push(rel) });
    __layoutPaint();
    document.getElementById('wsAiSessionBody').scrollTop=0;
  })`)
  await wait(() => cdp.eval('document.querySelector(".ws-ai-overview").offsetHeight>0'), '概況沒有尺寸')
  assert.deepEqual(await cdp.eval('[...document.querySelectorAll("#wsAiSessionBody .ws-ai-turn-text")].map(n=>n.textContent)'), [text, '先檢查', '完整回答\n最末尾驗收'])
  assert.equal(await cdp.eval('document.querySelectorAll("#wsAiSessionBody .ws-ai-tool-group").length'), 2)
  assert.ok(await cdp.eval('(() => {const f=document.querySelector(".ws-ai-tool-group");return !f.open && f.offsetHeight<=f.querySelector("summary").offsetHeight+6})()'), '工具區預設只占摘要的高度')
  assert.equal(await cdp.eval('document.querySelectorAll("#wsAiSessionBody script").length'), 0)
  for (const theme of ['dark', 'light']) {
    for (const width of [320, 600, 1000]) {
      await cdp.eval(`document.documentElement.dataset.theme='${theme}';document.getElementById('wsAiSession').style.maxWidth='${width}px'`)
      const sizes = await cdp.eval(`(() => {const b=document.getElementById('wsAiSessionBody'),h=b.querySelector('.ws-ai-overview');return {width:b.clientWidth,scrollWidth:b.scrollWidth,height:h.offsetHeight}})()`)
      assert.ok(sizes.scrollWidth <= sizes.width + 1, `${theme}/${width}px 不可橫向溢出`)
      assert.ok(sizes.height <= 160, `${theme}/${width}px 置頂控制列過高：${sizes.height}`)
    }
  }
  await cdp.eval('document.getElementById("wsAiSession").style.maxWidth="600px";document.documentElement.dataset.theme="dark";document.getElementById("wsAiSessionBody").scrollTop=0')
  const bodyRect = await cdp.eval('(() => {const r=document.getElementById("wsAiSessionBody").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...bodyRect, deltaX: 0, deltaY: 900 })
  await wait(() => cdp.eval('document.getElementById("wsAiSessionBody").scrollTop>100'), '真滑鼠滾輪沒有捲動對話')
  assert.ok(await cdp.eval('Math.abs(document.querySelector(".ws-ai-overview").getBoundingClientRect().top-document.getElementById("wsAiSessionBody").getBoundingClientRect().top)<2'), '捲動後控制列要留在頂部')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-overview").contains(document.getElementById("wsAiSessionBar"))'), '標題與按鈕必須併入置頂區塊')
  assert.equal(await cdp.eval('document.querySelectorAll("#wsAiSessionBody [data-action]").length'), 0, '不再顯示上下頁')
  await click('#wsAiCopyPathBtn')
  await click('#wsAiResumeBtn')
  assert.deepEqual(await cdp.eval('__layoutActions'), ['C:/layout-record.jsonl', 'resume:'], '合併後按鈕仍可操作')
  await click('.ws-ai-title-fold > summary')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-title-fold").open && document.querySelector(".ws-ai-title-fold > div").textContent=== "Claude Code · "+__layoutTab.sessionRow.title'), '長標題仍能完整展開')
  await cdp.eval('__layoutPaint()')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-title-fold").open'), '更新保留標題展開')
  await click('.ws-ai-title-fold > summary')
  await click('.ws-ai-overview > details > summary')
  await wait(() => cdp.eval('document.querySelector(".ws-ai-overview > details").open'), '概況不能展開')
  assert.equal(await cdp.eval('document.querySelectorAll(".ws-ai-overview .ws-ai-tool-badge").length'), 2)
  await cdp.eval('document.getElementById("wsAiSession").style.maxWidth="1000px"')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-meta-item").getBoundingClientRect().width<300'), '概況欄位不能拉成等寬大格')
  await screenshot('overview-expanded.png')
  await cdp.eval('document.getElementById("wsAiSession").style.maxWidth="600px"')
  await cdp.eval('document.querySelector(".ws-ai-overview > details > summary").focus()')
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
  await wait(() => cdp.eval('!document.querySelector(".ws-ai-overview > details").open'), '鍵盤不能收合概況')
  await cdp.eval('document.querySelector(".ws-ai-tool-group").scrollIntoView({block:"center"})')
  await click('.ws-ai-tool-group > summary')
  await wait(() => cdp.eval('document.querySelector(".ws-ai-tool-group").open'), '工具區不能展開')
  assert.deepEqual(await cdp.eval('[...document.querySelectorAll(".ws-ai-turn-tool-detail")].map(n=>n.textContent)'), [detail, '第二份完整內容', '最後一份完整內容'])
  assert.equal(await cdp.eval('getComputedStyle(document.querySelector(".ws-ai-turn-tool-detail")).whiteSpace'), 'pre-wrap')
  assert.ok(await cdp.eval('document.getElementById("wsAiSessionBody").scrollWidth<=document.getElementById("wsAiSessionBody").clientWidth+1'), '展開工具後不能橫向溢出')
  await cdp.eval('__layoutTab.sessionData.turns[2].tools[0].detail+="\\n即時追加";__layoutPaint()')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-tool-group").open && document.querySelector(".ws-ai-turn-tool-detail").textContent.endsWith("即時追加")'), '即時更新要保留工具展開與追加內容')
  await cdp.eval('(() => {const b=document.getElementById("wsAiSessionBody"),g=b.querySelector(".ws-ai-tool-group"),h=b.querySelector(".ws-ai-overview");b.scrollTop+=g.getBoundingClientRect().top-b.getBoundingClientRect().top-h.offsetHeight-8})()')
  await screenshot('expanded.png')
  await findConversation()
  await cdp.eval('__layoutTab.sessionData.sessionId="other-layout";__layoutPaint()')
  assert.ok(await cdp.eval('!document.querySelector(".ws-ai-tool-group").open'), '換對話重新收合工具區')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-find").hidden && !document.querySelector(".ws-ai-find-input").value && !CSS.highlights.has("ws-ai-find-current")'), '換對話清除搜尋與標示')
  await cdp.eval('document.getElementById("wsAiSession").style.maxWidth=""')
  console.log('PASS 緊湊排版：合併標題／按鈕、無上下頁、深淺主題／320–1000px、真滾輪置頂、工具全文／鍵盤／保留展開')
}

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers })
}

async function findConversation() {
  await cdp.eval('document.querySelectorAll(".ws-ai-tool-group").forEach(n=>n.open=false)')
  await key('f', 'KeyF', 70, 2)
  assert.ok(await cdp.eval('!document.querySelector(".ws-ai-find").hidden && document.activeElement.classList.contains("ws-ai-find-input")'), 'Ctrl+F 開啟搜尋並聚焦')
  await cdp.send('Input.insertText', { text: '完整' })
  await wait(() => cdp.eval('document.querySelector(".ws-ai-find-count").textContent==="1 / 53"'), '搜尋要算進收合工具內容')
  await key('Enter', 'Enter', 13, 8)
  assert.equal(await cdp.eval('document.querySelector(".ws-ai-find-count").textContent'), '53 / 53', 'Shift+Enter 循環到最後一筆')
  assert.ok(await cdp.eval('[...document.querySelectorAll(".ws-ai-tool-group")].at(-1).open'), '跳轉自動展開命中工具')
  assert.ok(await cdp.eval('(() => {const r=[...CSS.highlights.get("ws-ai-find-current")][0].getBoundingClientRect(),b=document.getElementById("wsAiSessionBody").getBoundingClientRect(),h=document.querySelector(".ws-ai-overview").getBoundingClientRect();return r.top>=h.bottom && r.bottom<=b.bottom})()'), '命中不能被置頂列遮住')
  await key('F3', 'F3', 114)
  assert.equal(await cdp.eval('document.querySelector(".ws-ai-find-count").textContent'), '1 / 53')
  await cdp.eval('__layoutTab.sessionData.turns.push({role:"assistant",text:"新增完整內容"});__layoutPaint()')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-find-count").textContent==="1 / 54" && document.activeElement.classList.contains("ws-ai-find-input")'), '即時更新保留搜尋與輸入焦點')
  await key('a', 'KeyA', 65, 2)
  await cdp.send('Input.insertText', { text: '<script>' })
  await wait(() => cdp.eval('document.querySelector(".ws-ai-find-count").textContent==="1 / 1"'), '工具中的原文符號也能搜尋')
  assert.ok(await cdp.eval('[...CSS.highlights.get("ws-ai-find-current")][0].toString()==="<script>"'), '標示保留原文')
  for (const theme of ['dark', 'light']) {
    await cdp.eval(`document.documentElement.dataset.theme='${theme}';document.getElementById('wsAiSession').style.maxWidth='320px'`)
    assert.ok(await cdp.eval('(() => {const b=document.getElementById("wsAiSessionBody");return b.scrollWidth<=b.clientWidth+1 && b.querySelector(".ws-ai-overview").offsetHeight<230})()'), `${theme} 窄視窗搜尋列不能溢出`)
  }
  await cdp.eval('document.documentElement.dataset.theme="dark";document.getElementById("wsAiSession").style.maxWidth="600px"')
  await screenshot('search.png')
  await key('a', 'KeyA', 65, 2)
  await cdp.send('Input.insertText', { text: '沒有這個字zz' })
  await wait(() => cdp.eval('document.querySelector(".ws-ai-find-count").textContent==="找不到"'), '沒有結果要明確提示')
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-find button").disabled'), '無結果停用跳轉')
  await key('Escape', 'Escape', 27)
  assert.ok(await cdp.eval('document.querySelector(".ws-ai-find").hidden && !CSS.highlights.has("ws-ai-find-current")'), 'Esc 清除搜尋標示')
  await click('#wsAiFindBtn')
  assert.ok(await cdp.eval('!document.querySelector(".ws-ai-find").hidden'), '按鈕也能開啟搜尋')
  console.log('PASS 長標題與真鍵盤搜尋：全文／工具命中、Enter／Shift+Enter／F3 循環、跳轉展開、更新保留焦點、無結果／Esc')
}
async function main() {
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ closeToTray: false, sysmonSensors: false, uffsAuto: false, dictationEnabled: false, agyEnabled: false, autoUpdate: false }))
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({ projects: [
    { id: projectId, name: 'AI 紀錄验收', path: project, createdAt: Date.now() },
    { id: 'w_agents_other', name: '空白專案', path: other, createdAt: Date.now() }
  ] }))
  const port = await freePort(), inspectPort = await freePort()
  child = spawn(exe, ['--hidden', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`, `--user-data-dir=${profile}`], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...fixture.env, USERPROFILE: path.dirname(fixture.env.CLAUDE_CONFIG_DIR), LOCALAPPDATA: profile }
  })
  cdp = await connect((await target(port)).webSocketDebuggerUrl)
  mainCdp = await connect((await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0].webSocketDebuggerUrl)
  await wait(() => cdp.eval('!!window.electronAPI?.workspace'), 'IPC 未就緒')
  const rows = await cdp.eval(`electronAPI.workspace.agentSessions('${projectId}').then(r => { if(!r.ok) throw new Error(r.error.message); return r.data })`)
  for (const [agent, id] of Object.entries(fixture.ids)) assert.ok(rows.some(row => row.agent === agent && row.id === id), `${agent} 不在紀錄清單`)
  console.log('PASS 五種 AI 紀錄真格式與專案歸屬')
  await cdp.eval('document.getElementById("sidebarModeProjects").click()')
  await wait(() => cdp.eval(`!!document.querySelector('#projList [data-id=${projectId}] .chat-list-open')`), '專案清單未就緒')
  await cdp.eval(`document.querySelector('#projList [data-id=${projectId}] .chat-list-open').click()`)
  await sidebarCopy(rows)
  // CLI argv 的真 ConPTY 驗證另由 probe-terminal-agent-host 負責；此處避免呼叫登入 API。
  await mainCdp.eval(`globalThis.__hostClass=process.mainModule.require(process.mainModule.require('electron').app.getAppPath()+'/src/main/terminal/host-client.js').HostClient;globalThis.__hostRequest=__hostClass.prototype.request;globalThis.__hostOpens=[];__hostClass.prototype.request=async function(op,args){if(op==='list')return [];if(op==='open'){__hostOpens.push(args);return {id:args.sessionId,state:'idle',exitCode:0,buffer:'DUMMY',seq:0,cols:args.cols,rows:args.rows}}return true}`)
  for (const [agent, id] of Object.entries(fixture.ids)) {
    const row = rows.find(row => row.agent === agent && row.id === id)
    await cdp.eval(`import('./scripts/ws-tabs.js').then(m => m.openAiSessionTab({id:'${projectId}',path:${JSON.stringify(project)}},${JSON.stringify(row)}))`)
    const ending = agent === 'claude' ? '回答74' : '最末尾驗收'
    await wait(() => cdp.eval(`!document.querySelector('#wsAiSessionBody .ws-ai-overview > .ws-ai-fold > summary')?.textContent.includes('載入完整對話中') && [...document.querySelectorAll('#wsAiSessionBody .ws-ai-turn-text')].at(-1)?.textContent.endsWith(${JSON.stringify(ending)})`), `${agent} 完整對話沒有自動讀到末尾`)
    const texts = await cdp.eval('[...document.querySelectorAll("#wsAiSessionBody .ws-ai-turn-text")].map(n=>n.textContent)')
    const hash = createHash('sha256')
    texts.forEach(text => hash.update(text))
    assert.equal(hash.digest('hex'), expectedHash(agent), `${agent} 單頁全文內容被截短或重複`)
    assert.equal(await cdp.eval('document.querySelectorAll("#wsAiSessionBody [data-action]").length'), 0)
    assert.equal(await cdp.eval('document.getElementById("wsAiSessionBody").scrollTop'), 0, '初次載入從第一則開始，不跳到末尾')
    console.log(`PASS ${agent} 單頁全文 SHA-256 一致，${texts.length} 個文字片段，無需翻頁`)
    await click('#wsAiFindBtn')
    await cdp.send('Input.insertText', { text: ending })
    await wait(() => cdp.eval('document.querySelector(".ws-ai-find-count").textContent==="1 / 1"'), `${agent} 搜尋不到分段讀取後的最後一句`)
    assert.equal(await cdp.eval('[...CSS.highlights.get("ws-ai-find-current")][0].toString()'), ending)
    await key('Escape', 'Escape', 27)
    await cdp.eval('document.getElementById("wsAiResumeBtn").click()')
    const resumed = await wait(async () => {
      const list = await cdp.eval('electronAPI.terminal.list()')
      return list.data?.find(row => row.preset === agent && row.agentSessionId === id)
    }, `${agent} 從紀錄接續時沒有保存對話 ID`)
    await wait(() => mainCdp.eval(`__hostOpens.some(item=>item.meta.preset===${JSON.stringify(agent)}&&item.meta.agentSessionId===${JSON.stringify(id)})`), '宿主沒有收到還原 metadata')
    assert.equal(resumed.cwd.toLowerCase(), project.toLowerCase())
    assert.ok(JSON.parse(fs.readFileSync(path.join(profile, 'terminals.json'), 'utf8')).sessions.some(row => row.id === resumed.id && row.agentSessionId === id))
    await cdp.eval(`electronAPI.terminal.delete(${JSON.stringify(resumed.id)})`)
    await cdp.eval(`import('./scripts/ws-tabs.js').then(m => m.closeTab(${JSON.stringify(resumed.id)}))`)
    await cdp.eval(`import('./scripts/ws-tabs.js').then(m => m.openAiSessionTab({id:'${projectId}'},${JSON.stringify(row)}))`)
    if (agent === 'agy') await compactLayout()
    await cdp.eval("import('./scripts/ws-tabs.js').then(m => m.closeActiveTab())")
  }
  await mainCdp.eval('__hostClass.prototype.request=__hostRequest')
  await cdp.eval(`document.querySelector('#projList [data-id=w_agents_other] .chat-list-open').click()`)
  assert.equal((await cdp.eval("electronAPI.workspace.agentSessions('w_agents_other')")).data.length, 0)
  assert.equal(await cdp.eval('document.querySelectorAll("#wsAiSessionBody .ws-ai-turn-text").length'), 0)
  await key('f', 'KeyF', 70, 2)
  assert.ok(await cdp.eval('document.getElementById("wsAiSession").hidden && !CSS.highlights.has("ws-ai-find-current")'), '離開紀錄後不攔截搜尋')
  console.log('PASS 換專案後紀錄隔離，關分頁清除內容')
  await cdp.eval(`document.querySelector('#projList [data-id=${projectId}] .chat-list-open').click()`)
  await mainCdp.eval(`globalThis.__agentErrors=[]; process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).webContents.on('console-message', (...args)=>{const d=args[1];if(d?.level==='error')__agentErrors.push(d.message)})`)
  const memory = await mainCdp.eval(`(async () => { const search=process.mainModule.require(process.mainModule.require('electron').app.getAppPath()+'/src/main/workspace/search.js'); const before=process.memoryUsage();let peak=before.rss;const timer=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),5);try{for(let i=0;i<3;i++) await search.search(${JSON.stringify(root)},'unlikely-packaged-search-memory-228981',false)}finally{clearInterval(timer)}return {beforeMiB:Math.round(before.rss/1048576),peakMiB:Math.round(peak/1048576),growthMiB:Math.round((peak-before.rss)/1048576)} })()`)
  console.log('PACKAGED 搜尋記憶體 ' + JSON.stringify(memory))
  console.log('PASS packaged 五種 AI 完整紀錄')
}

async function sidebarCopy(rows) {
  await click('.ws-right-tab[data-panel="agents"]')
  await wait(() => cdp.eval('document.querySelectorAll("#wsAgentList .ws-agent-row-wrap").length>0'), 'AI 紀錄側欄未載入')
  assert.equal(await cdp.eval('document.querySelectorAll("#wsAgentList .ws-agent-copy").length'), rows.length, '每筆紀錄要有複製鈕')
  await mainCdp.eval(`globalThis.__copyService=process.mainModule.require(process.mainModule.require('electron').app.getAppPath()+'/src/main/terminal/service.js');globalThis.__copyWrite=__copyService.clipboardWrite;globalThis.__copiedPaths=[];__copyService.clipboardWrite=text=>{__copiedPaths.push(text);return true}`)
  try {
    for (const [agent, id] of Object.entries(fixture.ids)) {
      const selector = `#wsAgentList [data-id="${agent}:${id}"] .ws-agent-copy`
      const expected = await cdp.eval(`electronAPI.workspace.agentSessionDetail('${projectId}',${JSON.stringify(agent)},${JSON.stringify(id)}).then(r=>r.data.file)`)
      await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
      assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).textContent`), '複製')
      await click(selector)
      await wait(() => mainCdp.eval(`__copiedPaths.includes(${JSON.stringify(expected)})`), `${agent} 沒有複製正確紀錄檔路徑`)
      assert.ok(await cdp.eval('document.getElementById("wsAiSession").hidden'), '複製不應開啟對話')
    }
    for (const width of [260, 320]) {
      await cdp.eval(`document.getElementById('wsRight').style.width='${width}px'`)
      const layout = await cdp.eval(`(() => {const list=document.getElementById('wsAgentList');return {width:list.clientWidth,scroll:list.scrollWidth,rows:[...list.querySelectorAll('.ws-agent-row-wrap')].map(row=>{const a=row.querySelector('.ws-agent-actions').getBoundingClientRect(),r=row.getBoundingClientRect();return {inside:a.right<=r.right,overlap:[...row.querySelectorAll('.ws-agent-head > span')].some(n=>{const t=n.getBoundingClientRect();return t.right>a.left+1 && t.top<a.bottom && t.bottom>a.top})}})}})()`)
      assert.ok(layout.scroll <= layout.width + 1 && layout.rows.every(row => row.inside && !row.overlap), `${width}px 側欄操作不能遮住標籤或溢出：${JSON.stringify(layout)}`)
    }
    await screenshot('sidebar-copy.png')
  } finally {
    await mainCdp.eval('__copyService.clipboardWrite=__copyWrite')
    await cdp.eval('document.getElementById("wsRight").style.width=""')
  }
  console.log('PASS 側欄複製：五家紀錄檔路徑、真點擊／IPC、文字「複製」、不開對話、窄側欄無重疊；保留系統剪貼簿')
}
main().catch(error => { console.error('FAIL', error.stack); process.exitCode = 1 }).finally(() => {
  cdp?.ws.close(); mainCdp?.ws.close()
  if (child?.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 本輪程序已退出 */ } }
})
