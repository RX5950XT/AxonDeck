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
  return { ws, eval: expression => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout')) }, 30000)
    pending.set(key, msg => {
      clearTimeout(timer)
      if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)))
      else resolve(msg.result.result?.value)
    })
    ws.send(JSON.stringify({ id: key, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  }) }
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
async function main() {
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ closeToTray: false, sysmonSensors: false, dictationEnabled: false, agyEnabled: false, autoUpdate: false }))
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({ projects: [
    { id: projectId, name: 'AI 紀錄验收', path: project, createdAt: Date.now() },
    { id: 'w_agents_other', name: '空白專案', path: other, createdAt: Date.now() }
  ] }))
  const port = await freePort(), inspectPort = await freePort()
  child = spawn(exe, ['--hidden', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`, `--user-data-dir=${profile}`], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, ...fixture.env, USERPROFILE: path.dirname(fixture.env.CLAUDE_CONFIG_DIR), LOCALAPPDATA: profile }
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
  // CLI argv 的真 ConPTY 驗證另由 probe-terminal-agent-host 負責；此處避免呼叫登入 API。
  await mainCdp.eval(`globalThis.__hostClass=process.mainModule.require(process.mainModule.require('electron').app.getAppPath()+'/src/main/terminal/host-client.js').HostClient;globalThis.__hostRequest=__hostClass.prototype.request;globalThis.__hostOpens=[];__hostClass.prototype.request=async function(op,args){if(op==='list')return [];if(op==='open'){__hostOpens.push(args);return {id:args.sessionId,state:'idle',exitCode:0,buffer:'DUMMY',seq:0,cols:args.cols,rows:args.rows}}return true}`)
  for (const [agent, id] of Object.entries(fixture.ids)) {
    const row = rows.find(row => row.agent === agent && row.id === id)
    await cdp.eval(`import('./scripts/ws-tabs.js').then(m => m.openAiSessionTab({id:'${projectId}',path:${JSON.stringify(project)}},${JSON.stringify(row)}))`)
    const hash = createHash('sha256')
    let pages = 0, lastText = ''
    while (true) {
      const page = await cdp.eval(`(() => ({ texts:[...document.querySelectorAll('#wsAiSessionBody .ws-ai-turn-text')].map(n => n.textContent), next:!!document.querySelector('#wsAiSessionBody [data-action="next-page"]:not(:disabled)'), note:document.getElementById('wsAiSessionMeta').textContent }))()`)
      assert.ok(page.texts.length > 0)
      assert.ok(!page.note.includes('只讀了'))
      page.texts.forEach(text => hash.update(text))
      lastText = page.texts.findLast(text => text) || lastText
      pages++
      assert.ok(pages < 150, '分頁沒有前進')
      if (!page.next) break
      const before = await cdp.eval('document.getElementById("wsAiSessionBody").textContent')
      await cdp.eval('document.querySelector("#wsAiSessionBody [data-action=next-page]").click()')
      await wait(() => cdp.eval(`document.getElementById('wsAiSessionBody').textContent !== ${JSON.stringify(before)} && document.querySelectorAll('#wsAiSessionBody .ws-ai-turn-text').length > 0`), '下一頁沒有載入')
    }
    assert.equal(hash.digest('hex'), expectedHash(agent), `${agent} 全文內容被截短或重複`)
    if (agent === 'claude') assert.equal(lastText, '回答74')
    else assert.ok(lastText.endsWith('最末尾驗收'))
    if (pages > 1) {
      const before = await cdp.eval('document.getElementById("wsAiSessionBody").textContent')
      await cdp.eval('document.querySelector("#wsAiSessionBody [data-action=previous-page]").click()')
      await wait(() => cdp.eval(`document.getElementById('wsAiSessionBody').textContent !== ${JSON.stringify(before)}`), '上一頁不能返回')
    }
    console.log(`PASS ${agent} 全文 SHA-256 一致，${pages} 頁，前後切頁正常`)
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
    await cdp.eval("import('./scripts/ws-tabs.js').then(m => m.closeActiveTab())")
  }
  await mainCdp.eval('__hostClass.prototype.request=__hostRequest')
  await cdp.eval(`document.querySelector('#projList [data-id=w_agents_other] .chat-list-open').click()`)
  assert.equal((await cdp.eval("electronAPI.workspace.agentSessions('w_agents_other')")).data.length, 0)
  assert.equal(await cdp.eval('document.querySelectorAll("#wsAiSessionBody .ws-ai-turn-text").length'), 0)
  console.log('PASS 換專案後紀錄隔離，關分頁清除內容')
  await cdp.eval(`document.querySelector('#projList [data-id=${projectId}] .chat-list-open').click()`)
  await mainCdp.eval(`globalThis.__agentErrors=[]; process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).webContents.on('console-message', (...args)=>{const d=args[1];if(d?.level==='error')__agentErrors.push(d.message)})`)
  const memory = await mainCdp.eval(`(async () => { const search=process.mainModule.require(process.mainModule.require('electron').app.getAppPath()+'/src/main/workspace/search.js'); const before=process.memoryUsage();let peak=before.rss;const timer=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),5);try{for(let i=0;i<3;i++) await search.search(${JSON.stringify(root)},'unlikely-packaged-search-memory-228981',false)}finally{clearInterval(timer)}return {beforeMiB:Math.round(before.rss/1048576),peakMiB:Math.round(peak/1048576),growthMiB:Math.round((peak-before.rss)/1048576)} })()`)
  console.log('PACKAGED 搜尋記憶體 ' + JSON.stringify(memory))
  console.log('PASS packaged 五種 AI 完整紀錄')
}
main().catch(error => { console.error('FAIL', error.stack); process.exitCode = 1 }).finally(() => {
  cdp?.ws.close(); mainCdp?.ws.close()
  if (child?.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 本輪程序已退出 */ } }
})
