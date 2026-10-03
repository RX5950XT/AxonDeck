'use strict'
// 完整 packaged App 重開與宿主消失；CLI 由專案內的假 .cmd 接住，不打登入 API。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const { seedAgentFixtures } = require('./lib/workspace-agent-fixtures')
const root = path.resolve(__dirname, '..')
const exe = process.env.VOICEINK_EXE || path.join(root, 'dist/win-unpacked/VoiceInk.exe')
const profile = tempDir('agents-restart-profile-'), project = tempDir('agents-restart-project-')
const fixture = seedAgentFixtures(tempDir('agents-restart-home-'), project)
const projectId = 'w_agents_restart'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const pids = new Set()
let child, cdp, inspector
let appLog = ''
async function port() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const result = server.address().port
  await new Promise(resolve => server.close(resolve))
  return result
}
async function wait(check, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(150) }
  throw new Error(label)
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function kill(pid) { if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 本輪程序已退出 */ } } }
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data), callback = pending.get(msg.id)
    if (callback) { pending.delete(msg.id); callback(msg) }
  })
  return { ws, eval: expression => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout')) }, 30000)
    pending.set(key, msg => { clearTimeout(timer); if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails))); else resolve(msg.result.result?.value) })
    ws.send(JSON.stringify({ id: key, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  }) }
}
async function launch() {
  const cdpPort = await port(), inspectPort = await port()
  child = spawn(exe, ['--hidden', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${cdpPort}`, `--inspect=127.0.0.1:${inspectPort}`, `--user-data-dir=${profile}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...fixture.env, LOCALAPPDATA: profile } })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { appLog = (appLog + data).slice(-12000) })
  const target = await wait(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(t => /index\.html/.test(t.url)) } catch { return null }
  }, 'App 沒有啟動')
  cdp = await connect(target.webSocketDebuggerUrl)
  inspector = await connect((await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0].webSocketDebuggerUrl)
  // 只觀察真宿主 PID；不替換回應，也不攔截 ConPTY。
  await inspector.eval(`globalThis.__ownedHostPids=[];globalThis.__hostClass=process.mainModule.require(process.mainModule.require('electron').app.getAppPath()+'/src/main/terminal/host-client.js').HostClient;globalThis.__request=__hostClass.prototype.request;__hostClass.prototype.request=async function(...args){const result=await __request.apply(this,args);if(this.host.pid)__ownedHostPids.push(this.host.pid);return result}`)
  await wait(() => cdp.eval('!!window.electronAPI?.terminal'), 'IPC 尚未就緒')
  await cdp.eval('document.getElementById("sidebarModeProjects").click()')
  await wait(() => cdp.eval(`!!document.querySelector('#projList [data-id=${projectId}] .chat-list-open')`), '專案清單尚未就緒')
  await cdp.eval(`document.querySelector('#projList [data-id=${projectId}] .chat-list-open').click()`)
}
async function rememberPids() { for (const pid of await inspector.eval('__ownedHostPids')) pids.add(pid) }
async function closeApp() {
  await rememberPids()
  // Node 的主程序 debugger 會攔住結束；先斷開觀察連線，才量真正的 App 關閉。
  inspector.ws.close(); inspector = null
  const pid = child.pid
  await cdp.eval('electronAPI.window.close()').catch(() => {})
  await wait(() => !alive(pid), 'App 沒有完全關閉')
  cdp.ws.close(); cdp = child = null
}
function calls(agent) {
  try { return fs.readFileSync(path.join(project, agent + '-args.txt'), 'utf8').trim().split(/\r?\n/) } catch { return [] }
}
async function open(id) {
  await cdp.eval(`import('./scripts/terminal-page.js').then(m => m.openTerminalSession(${JSON.stringify(id)}))`)
  const result = await cdp.eval(`electronAPI.terminal.open(${JSON.stringify(id)},100,25)`)
  assert.equal(result.ok, true)
  await rememberPids()
  return result.data
}
async function main() {
  const sessions = Object.entries(fixture.ids).map(([agent, id]) => ({ id: 't_restart_' + agent, title: agent, shell: 'cmd', preset: agent, cwd: project, projectId, agentSessionId: id, createdAt: Date.now() }))
  for (const agent of Object.keys(fixture.ids)) fs.writeFileSync(path.join(project, agent + '.cmd'), `@echo off\r\necho %*>>${agent}-args.txt\r\necho DUMMY_${agent} %*\r\n`)
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ closeToTray: false, sysmonSensors: false, dictationEnabled: false, agyEnabled: false, autoUpdate: false }))
  fs.writeFileSync(path.join(profile, 'terminals.json'), JSON.stringify({ sessions }))
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({ projects: [{ id: projectId, name: '五家接續驗收', path: project, createdAt: Date.now(), tabsState: { activeId: sessions[0].id, tabs: sessions.map(row => ({ id: row.id, kind: 'terminal', title: row.title })) } }] }))
  await launch()
  const before = new Map()
  for (const row of sessions) before.set(row.id, (await open(row.id)).pid)
  await wait(() => sessions.every(row => calls(row.preset).length === 1), '五家接續指令沒有執行')
  for (const row of sessions) assert.ok(calls(row.preset)[0].includes(row.agentSessionId))
  console.log('PASS packaged 五家 metadata 經 main 驗證，真 ConPTY 收到指定對話 ID')
  await closeApp()
  for (const pid of before.values()) assert.ok(alive(pid), '關 App 不可以结束原 shell')
  await launch()
  for (const row of sessions) {
    const snapshot = await open(row.id)
    assert.equal(snapshot.pid, before.get(row.id), row.preset + ' 重開必須接回同一個 shell')
    assert.ok(snapshot.buffer.includes('DUMMY_' + row.preset), '原輸出必須還原')
    assert.equal(calls(row.preset).length, 1, '不可重送接續指令')
  }
  console.log('PASS 真正關 App 再開，五家原分頁／輸出／PID 皆還原且不重送指令')
  assert.equal((await cdp.eval('electronAPI.terminal.restartHost()')).ok, true)
  for (const row of sessions) {
    const snapshot = await open(row.id)
    assert.notEqual(snapshot.pid, before.get(row.id))
  }
  await wait(() => sessions.every(row => calls(row.preset).length === 2), '宿主消失後未接續原對話')
  for (const row of sessions) assert.equal(calls(row.preset)[0], calls(row.preset)[1])
  console.log('PASS 宿主消失後五家按原對話 ID 接續，沒有接錯成最新一筆')
  for (const row of sessions) await cdp.eval(`electronAPI.terminal.delete(${JSON.stringify(row.id)})`)
  await closeApp()
  console.log('PASS packaged 五家 App 重開與宿主重建')
}
main().catch(error => { console.error('FAIL', error.stack, appLog); process.exitCode = 1 }).finally(async () => {
  if (inspector) await rememberPids().catch(() => {})
  cdp?.ws.close(); inspector?.ws.close(); kill(child?.pid)
  for (const pid of pids) kill(pid)
})
