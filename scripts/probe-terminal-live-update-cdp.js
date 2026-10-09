'use strict'
// 手動真流量探針：node scripts/probe-terminal-live-update-cdp.js --live；qa.close() 收尾。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
assert(process.argv.includes('--live'), '須明確指定 --live；此探針會使用真實 CLI 登入')
const profile = tempDir('live-nav-profile-'), project = tempDir('live-nav-project-')
const root = path.resolve(__dirname, '..'), sessions = new Map(), hosts = new Set()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let app, cdp, inspector
async function port() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const number = server.address().port
  await new Promise(resolve => server.close(resolve))
  return number
}
async function until(fn, label, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { const value = await fn(); if (value) return value; await delay(200) }
  throw new Error(label)
}
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let seq = 0
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = ({data}) => { const row = JSON.parse(data); pending.get(row.id)?.(row) }
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, 30000)
    pending.set(id, row => { clearTimeout(timer); pending.delete(id); row.error ? reject(new Error(JSON.stringify(row.error))) : resolve(row.result) })
    ws.send(JSON.stringify({id,method,params}))
  })
  return {ws,send,eval:async expression => {
    const result = await send('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true})
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }}
}
const kill = pid => { if (pid) try { execFileSync('taskkill', ['/PID',String(pid),'/T','/F'], {stdio:'ignore',windowsHide:true}) } catch { /* 本探針程序已退出 */ } }
const qa = {
  project, sessions,
  async open(agent) {
    const row = await cdp.eval(`electronAPI.terminal.create(${JSON.stringify({shell:'powershell',preset:agent,cwd:project,projectId:'w_live_nav'})})`)
    assert(row.ok, JSON.stringify(row)); sessions.set(agent,row.data.id)
    await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.openTerminalSession(${JSON.stringify(row.data.id)}))`)
    for (const pid of await inspector.eval('__ownedHostPids')) hosts.add(pid)
    return row.data.id
  },
  async send(agent,text) { return cdp.eval(`electronAPI.terminal.write(${JSON.stringify(sessions.get(agent))},${JSON.stringify(text)})`) },
  async read(agent) {
    const id = sessions.get(agent)
    return cdp.eval(`(() => { const id=${JSON.stringify(id)}, t=__liveTerms.get(id),p=document.querySelector('.term-pane[data-id="'+id+'"]'),b=t.buffer.active;return {screen:Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||'').join(String.fromCharCode(10)),list:p.querySelector('.term-conversation-list')?.textContent,status:p.querySelector('.term-conversation-status')?.textContent,alternate:b.type} })()`)
  },
  async history(agent) { return cdp.eval(`electronAPI.terminal.conversation(${JSON.stringify(sessions.get(agent))})`) },
  async show(agent) { await cdp.eval(`import('./scripts/terminal-page.js').then(m=>m.openTerminalSession(${JSON.stringify(sessions.get(agent))}))`) },
  async expect(agent,text,timeout=60000) {
    const started=Date.now()
    await until(async()=> (await qa.read(agent)).list?.includes(text),agent+' 清單沒有 '+text,timeout)
    return {agent,text,elapsedMs:Date.now()-started}
  },
  async close() {
    for (const id of sessions.values()) await cdp?.eval(`electronAPI.terminal.delete(${JSON.stringify(id)})`).catch(()=>{})
    cdp?.ws.close(); inspector?.ws.close(); kill(app?.pid); for(const pid of hosts) kill(pid)
    process.exit(0)
  },
  eval: expression => cdp.eval(expression),
  main: expression => inspector.eval(expression),
  input: (method,params) => cdp.send(method,params),
  delay, assert,
}
async function main() {
  fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({sysmonSensors:false,dictationEnabled:false,agyEnabled:false,closeToTray:false,autoUpdate:false,uffsAuto:false}))
  fs.writeFileSync(path.join(profile,'workspaces.json'),JSON.stringify({projects:[{id:'w_live_nav',name:'真實訊息驗收',path:project,createdAt:Date.now()}]}))
  const debug=await port(), inspect=await port(), env={...process.env}
  for(const key of Object.keys(env)) if(key==='CLAUDECODE'||key.startsWith('CLAUDE_CODE_')||key==='ELECTRON_RUN_AS_NODE') delete env[key]
  const exe=process.env.AXONDECK_EXE||path.join(root,'dist/terminal-bottom/AxonDeck.exe')
  app=spawn(exe,['--hidden','--disable-backgrounding-occluded-windows',`--remote-debugging-port=${debug}`,`--inspect=127.0.0.1:${inspect}`,`--user-data-dir=${profile}`],{env,detached:true,windowsHide:true,stdio:'ignore'})
  const target=async(p,match)=>{try{return (await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()).find(match)}catch{return null}}
  cdp=await connect((await until(()=>target(debug,row=>/index\.html/.test(row.url)),'App 未啟動')).webSocketDebuggerUrl)
  inspector=await connect((await until(()=>target(inspect,()=>true),'inspector 未啟動')).webSocketDebuggerUrl)
  await inspector.eval(`globalThis.__ownedHostPids=[];globalThis.__hc=process.mainModule.require(process.mainModule.require('electron').app.getAppPath()+'/src/main/terminal/host-client.js').HostClient;globalThis.__hr=__hc.prototype.request;__hc.prototype.request=async function(...args){const r=await __hr.apply(this,args);if(this.host.pid)__ownedHostPids.push(this.host.pid);return r}`)
  await until(()=>cdp.eval('!!window.electronAPI?.terminal'),'IPC 未就緒')
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await cdp.eval(`(async()=>{const{Terminal}=await import('../../node_modules/@xterm/xterm/lib/xterm.mjs');const open=Terminal.prototype.open;window.__liveTerms=new Map();Terminal.prototype.open=function(el){__liveTerms.set(el.dataset.id,this);return open.call(this,el)}})()`)
  globalThis.qa=qa
  console.log('READY isolated live probe',JSON.stringify({profile,project,pid:app.pid}))
  require('node:repl').start({prompt:'qa> ',useGlobal:true}).on('exit',()=>void qa.close())
}
main().catch(async error=>{console.error(error);await qa.close()})
