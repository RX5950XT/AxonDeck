'use strict'
// 打包版：本機擴充功能真的作用於網頁、商店真安裝、點腳本開本機服務；資料與程序全部隔離。
// --tts-only：共用隔離啟動，單獨驗證四語試聽與翻譯朗讀，不重跑腳本／商店下載。
// --scripts-only：驗證本機套件與 cmd／PowerShell 腳本，不下載商店套件。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const DATA = tempDir('browser-scripts-data-')
const ROOT = tempDir('browser-scripts-project-')
const EXT = path.join(ROOT, 'custom-extension')
const NESTED = path.join(ROOT, "中文 it's nested")
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
const PARENT_ID = 'w_script_parent'
const NESTED_ID = 'w_script_nested'
const STORE_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const DEFAULTS = [STORE_ID, 'ldgfbffkinooeloadekpmfoklnobpien', 'nnnkddnnlpamobajfibfdgfnbcnkgngh', 'ndcooeababalnlpkfedmmbbbgkljhpjf', 'modkelfkcfjpgbfmnbnllalkiogfofhb']
const quote = JSON.stringify
let child, childLog = '', ui, inspector, hostPid = 0
async function waitFor(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value } catch (error) { last = error }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`${label}: ${last?.message || 'timeout'}`)
}
const freePort = () => new Promise((resolve) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
})
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = ({ data }) => {
      const row = JSON.parse(data), pending = this.pending.get(row.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(row.id)
      if (row.error) pending.reject(new Error(row.error.message)); else pending.resolve(row.result)
    }
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }, 60000)
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const row = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (row.exceptionDetails) throw new Error(row.exceptionDetails.exception?.description || row.exceptionDetails.text)
    return row.result?.value
  }
  close() { for (const row of this.pending.values()) clearTimeout(row.timer); this.ws.close() }
}
require('./lib/page-cdp').followMainPage(Cdp)
function seed() {
  fs.mkdirSync(EXT); fs.mkdirSync(NESTED)
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'AxonDeck custom test', version: '1.0',
    permissions: ['tabs','storage'], options_ui: {page:'options.html'}, action: { default_title: 'Custom test', default_popup:'popup.html' }, content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }] }))
  fs.writeFileSync(path.join(EXT, 'content.js'), "document.documentElement.dataset.customExtension='ok'")
  fs.writeFileSync(path.join(EXT, 'options.html'), '<!doctype html><title>Own settings</title><h1>Complete settings</h1>')
  fs.writeFileSync(path.join(EXT, 'popup.html'), '<!doctype html><title>Own popup</title><p id="origin"></p><script src="popup.js"></script>')
  fs.writeFileSync(path.join(EXT, 'popup.js'), 'chrome.tabs.query({active:true,currentWindow:true}).then(t=>document.querySelector("#origin").textContent=t[0]?.url||"missing")')
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ sysmonSensors: false, agyEnabled: false, dictationEnabled: false }))
  fs.writeFileSync(path.join(DATA, 'explorer.json'), JSON.stringify({ uffsAuto: false }))
  fs.writeFileSync(path.join(DATA, 'workspaces.json'), JSON.stringify({ projects: [
    { id: PARENT_ID, name: 'parent project', path: ROOT, createdAt: Date.now() },
    { id: NESTED_ID, name: 'nested project', path: NESTED, createdAt: Date.now() }
  ] }))
  fs.mkdirSync(path.join(DATA, 'browser-extensions'))
  fs.writeFileSync(path.join(DATA, 'browser-extensions/.defaults-seeded'), JSON.stringify(DEFAULTS))
}
async function start() {
  const port = await freePort(), inspect = await freePort()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')))
  childLog = ''
  child = spawn(EXE, [`--user-data-dir=${DATA}`, `--remote-debugging-port=${port}`, `--inspect=${inspect}`, '--hidden', '--disable-backgrounding-occluded-windows'], { env, detached: true, stdio: ['ignore','pipe','pipe'] })
  for(const stream of [child.stdout,child.stderr]) stream.on('data',bytes=>{childLog=(childLog+bytes).slice(-6000)})
  const list = (p) => fetch(`http://127.0.0.1:${p}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json())
  const target = await waitFor(async () => {
    if(child.exitCode!==null) throw new Error('App exited '+child.exitCode+' '+childLog.slice(-2000))
    return (await list(port)).find((row) => /index\.html/.test(row.url))
  }, 'renderer')
  ui = new Cdp(target.webSocketDebuggerUrl); await ui.connect()
  const main = await waitFor(async () => (await list(inspect))[0], 'main inspector')
  inspector = new Cdp(main.webSocketDebuggerUrl); inspector.fixedPage = true; await inspector.connect()
  await inspector.eval(`(() => {
    const e=process.mainModule.require('electron'); globalThis.testElectron=e;
    globalThis.outside=[]; globalThis.messages=[];
    e.shell.openExternal=async url=>{outside.push(url)};
    e.dialog.showMessageBox=async (...args)=>{messages.push(args.at(-1).message);return {response:0}};
    e.dialog.showOpenDialog=async ()=>({canceled:false,filePaths:[${quote(EXT)}]});
    const build=e.Menu.buildFromTemplate.bind(e.Menu);
    e.Menu.buildFromTemplate=items=>{const menu=build(items);if(items.some(r=>r.label==='安裝本機擴充功能資料夾…')){globalThis.extensionMenu=items;menu.popup=()=>{}};return menu};
    e.BrowserWindow.getAllWindows().forEach(w=>w.showInactive());
  })()`)
  await waitFor(() => ui.eval('!!window.electronAPI?.workspace'), 'preload')
  await ui.eval(`import('./scripts/app.js').then(m=>m.setSidebarMode('projects'))`)
  await waitFor(() => ui.eval(`!!document.querySelector('#projList [data-id="${PARENT_ID}"]')`), 'projects')
  await ui.eval(`document.querySelector('#projList [data-id="${PARENT_ID}"] .chat-list-open').click()`)
}
async function menu() {
  await ui.eval(`window.electronAPI.workspace.extensionsMenu(null,{x:100,y:40,width:32,height:32})`)
}
async function loaded() {
  return inspector.eval("testElectron.session.fromPartition('persist:wsbrowser').extensions.getAllExtensions().map(e=>({id:e.id,name:e.name}))")
}
async function installLocal() {
  await menu()
  assert.ok(await inspector.eval("extensionMenu.some(r=>r.label==='從 Chrome 線上應用程式商店安裝')"))
  await inspector.eval("extensionMenu.find(r=>r.label==='安裝本機擴充功能資料夾…').click()")
  const ext = await waitFor(async () => (await loaded()).find((row) => row.name === 'AxonDeck custom test'), 'local extension')
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'browser-extensions/local-extensions.json')))[0].id, ext.id)
  console.log('PASS native install menu and persistent custom extension', ext.id)
  return ext.id
}
async function runScript(kind) {
  const port = await freePort(), url = `http://127.0.0.1:${port}/?a=1&b=2`
  const file = kind === 'cmd' ? 'launch.cmd' : 'launch.ps1'
  fs.writeFileSync(path.join(NESTED, 'server.js'), `const http=require('http');const server=http.createServer((req,res)=>res.end('<!doctype html><title>script-ready</title><body data-project="'+process.env.AXONDECK_PROJECT+'">ready</body>'));setTimeout(()=>server.listen(${port},'127.0.0.1',()=>{process.stdout.write('Local: htt');setTimeout(()=>process.stdout.write('p://127.0.0.1:${port}/?a=1&b=2\\r\\n'),30)}),300);`)
  const text = kind === 'cmd'
    ? `@echo off\r\ncd /d "%~dp0"\r\nset "URL=${url}"\r\nstart "" "%URL%"\r\n"${process.execPath}" "%~dp0server.js"\r\n`
    : `$URL='${url}'; Start-Process -FilePath $URL; & '${process.execPath.replace(/'/g, "''")}' "$PSScriptRoot/server.js"`
  fs.writeFileSync(path.join(NESTED, file), text)
  await ui.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)
  const directory = "中文 it's nested"
  await waitFor(() => ui.eval(`Array.from(document.querySelectorAll('.ws-tree-row')).some(r=>r.dataset.rel===${quote(directory)})`), 'folder')
  await ui.eval(`(()=>{const r=[...document.querySelectorAll('.ws-tree-row')].find(r=>r.dataset.rel===${quote(directory)});if(r.getAttribute('aria-expanded')!=='true')r.click()})()`)
  await waitFor(() => ui.eval(`Array.from(document.querySelectorAll('.ws-tree-row')).some(r=>r.dataset.rel===${quote(`${directory}/${file}`)})`), 'script row')
  await ui.eval(`Array.from(document.querySelectorAll('.ws-tree-row')).find(r=>r.dataset.rel===${quote(`${directory}/${file}`)}).click()`)
  await waitFor(() => ui.eval(`!!document.querySelector('#wsEditorRunBtn:not([hidden])')?.offsetHeight`), 'editor run button')
  await ui.eval(`document.getElementById('wsEditorRunBtn').click()`)
  const terminal = await waitFor(() => ui.eval(`window.electronAPI.terminal.list().then(r=>r.data.find(t=>t.title===${quote(`執行 ${file}`)}))`), 'terminal')
  const guestId = await waitFor(() => ui.eval(`(()=>{const w=Array.from(document.querySelectorAll('#wsBrowserFrame webview')).find(w=>w.getURL?.()===${quote(url)});return w?.getWebContentsId()})()`), 'project browser')
  const contents = `testElectron.webContents.fromId(${guestId})`
  await waitFor(() => inspector.eval(`${contents}.executeJavaScript("document.title==='script-ready' && document.documentElement.dataset.customExtension==='ok'")`), 'live server and content script')
  assert.equal(await inspector.eval(`${contents}.executeJavaScript('document.body.dataset.project')`), PARENT_ID, '不可選巢狀專案')
  assert.equal(await ui.eval(`Array.from(document.querySelectorAll('#wsBrowserFrame webview')).filter(w=>w.getURL?.()===${quote(url)}).length`), 1, '主動開網址與日誌不能重複開')
  assert.deepEqual(await inspector.eval('outside'), [], '不能開系統瀏覽器')
  assert.equal(fs.readFileSync(path.join(NESTED, file), 'utf8'), text, '不能改原腳本')
  const denied = await ui.eval(`window.electronAPI.workspace.scriptCommand(${quote(NESTED_ID)},${quote(file)},${quote(terminal.id)})`)
  assert.equal(denied.ok, false, '不能跨專案控制終端機')
  await ui.eval(`window.electronAPI.terminal.delete(${quote(terminal.id)})`)
  console.log(`PASS click ${kind}: real server, custom content script, original project, no external browser, no duplicate tab`)
}
async function stop() {
  if (inspector) {
    try {
      hostPid = await inspector.eval(`(async()=>{const Client=process.mainModule.require('./terminal/host-client').HostClient;const c=new Client(testElectron.app.getPath('userData'),()=>{});await c.ensure(false);const pid=c.host.pid;c.disconnect();return pid})()`)
    } catch { /* 尚未啟動終端機，或 App 已經結束 */ }
  }
  ui?.close(); inspector?.close(); ui = inspector = null
  const kill = (pid) => spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  if (hostPid) { kill(hostPid); hostPid = 0 }
  if (child?.pid) { kill(child.pid); child.kill(); child = null }
}
async function extensionTabs(id) {
  const server=require('node:http').createServer((req,res)=>{
    if(req.url==='/redirect') { res.writeHead(302,{Location:'/origin'});res.end();return }
    res.end('<!doctype html><title>Origin</title><h1>Website</h1>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port+'/origin'
  const guest=async(url,host='#wsBrowserFrame')=>waitFor(()=>ui.eval(`(()=>{const w=[...document.querySelectorAll(${quote(host+' webview')})].find(w=>{try{return w.getURL()===${quote(url)}}catch{return false}});return w?.getWebContentsId()})()`),'browser tab '+url)
  const count=()=>inspector.eval('testElectron.BrowserWindow.getAllWindows().length')
  const popupFor=(extensionUrl)=>inspector.eval(`(()=>{const w=testElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===${quote(extensionUrl)});return w?.webContents.id||0})()`)
  const url='chrome-extension://'+id+'/'
  try {
    await ui.eval(`import('./scripts/workspace-page.js').then(m=>m.openUrlInProject(${quote(origin)},${quote(PARENT_ID)}))`)
    const source=await guest(origin),windows=await count(),projectTabs=await ui.eval("document.querySelectorAll('#wsBrowserFrame webview').length")
    console.log('STEP project browser origin ready')
    assert.equal(await inspector.eval(`testElectron.webContents.fromId(${source}).executeJavaScript('typeof browserExtensionsAPI')`),'undefined')
    await ui.eval(`document.querySelector('#projList [data-id="${NESTED_ID}"] .chat-list-open').click()`)
    await ui.eval(`window.electronAPI.workspace.extensionActivate(${source},${quote(id)},{x:10,y:10,width:20,height:20})`)
    const popup=await waitFor(()=>popupFor(url+'popup.html'),'floating project extension popup')
    await waitFor(()=>inspector.eval(`testElectron.webContents.fromId(${popup}).executeJavaScript('document.querySelector("#origin").textContent===${quote(origin)}')`),'popup original website')
    assert.equal(await ui.eval("document.querySelectorAll('#wsBrowserFrame webview').length"),projectTabs,'toolbar action popup is not a browser tab')
    assert.equal(await count(),windows+1,'toolbar action popup is a floating child window')
    assert.ok(await inspector.eval(`(()=>{const w=testElectron.BrowserWindow.fromWebContents(testElectron.webContents.fromId(${popup}));return w.isVisible()&&!!w.getParentWindow()})()`))
    console.log('STEP project toolbar popup floated')
    await ui.eval(`window.electronAPI.workspace.extensionActivate(${source},${quote(id)},{x:10,y:10,width:20,height:20})`)
    await waitFor(async()=>!(await popupFor(url+'popup.html')),'toolbar icon toggles the project popup closed')
    assert.equal(await count(),windows)
    await ui.eval(`window.electronAPI.workspace.extensionActivate(${source},${quote(id)},{x:10,y:10,width:20,height:20})`)
    const settingsPopup=await waitFor(()=>popupFor(url+'popup.html'),'project popup reopens for settings')
    await inspector.eval(`(()=>{void testElectron.webContents.fromId(${settingsPopup}).executeJavaScript('chrome.runtime.openOptionsPage()');return true})()`)
    const options=await guest(url+'options.html')
    assert.ok(await count()<=windows+1,'options page opens in the browser without creating another window')
    console.log('STEP options page opened in project browser')
    const created=await inspector.eval(`testElectron.webContents.fromId(${options}).executeJavaScript('chrome.tabs.create({url:${quote(url+'options.html?api=tab')},active:true})')`)
    assert.equal(created.url,url+'options.html?api=tab')
    await guest(created.url)
    const redirected=await inspector.eval(`testElectron.webContents.fromId(${options}).executeJavaScript('chrome.tabs.create({url:${quote(origin.replace('/origin','/redirect'))},active:true})')`)
    assert.equal(redirected.url,origin)
    assert.notEqual(redirected.id,source)
    await inspector.eval(`testElectron.webContents.fromId(${options}).executeJavaScript('window.open(${quote(url+'options.html?api=window')})')`)
    await guest(url+'options.html?api=window')
    await ui.eval(`window.electronAPI.workspace.extensionsMenu(${options},{x:10,y:10,width:20,height:20})`)
    await inspector.eval(`extensionMenu.find(i=>i.label===${quote('AxonDeck custom test')}).submenu.find(i=>i.label==='詳細設定…').click()`)
    const manager=await waitFor(()=>ui.eval(`(()=>{const w=[...document.querySelectorAll('#wsBrowserFrame webview')].find(w=>{try{return w.getURL().startsWith('axon-extensions://manager/')}catch{return false}});return w?.getWebContentsId()})()`),'manager tab')
    await waitFor(()=>inspector.eval(`testElectron.webContents.fromId(${manager}).executeJavaScript('!!document.querySelector("#detail input")')`),'manager IPC')
    await inspector.eval(`testElectron.webContents.fromId(${manager}).executeJavaScript('document.documentElement.dataset.theme="light"')`)
    await waitFor(()=>inspector.eval(`testElectron.webContents.fromId(${manager}).executeJavaScript('getComputedStyle(document.body).color==="rgb(30, 37, 40)"')`),'manager light theme color')
    assert.ok(await count()<=windows+1,'manager page opens in a browser tab')
    const priorOptions=await ui.eval(`[...document.querySelectorAll('#wsBrowserFrame webview')].filter(w=>{try{return w.getURL()===${quote(url+'options.html')}}catch{return false}}).map(w=>w.getWebContentsId())`)
    await inspector.eval(`testElectron.webContents.fromId(${manager}).executeJavaScript('Array.from(document.querySelectorAll("#detail button")).find(b=>b.textContent==="開啟完整設定").click()')`)
    await waitFor(()=>ui.eval(`[...document.querySelectorAll('#wsBrowserFrame webview')].some(w=>{try{return w.getURL()===${quote(url+'options.html')}&&!${quote(priorOptions)}.includes(w.getWebContentsId())}catch{return false}})`),'manager opens a new options tab')
    assert.ok(await count()<=windows+1,'full settings open in a browser tab')
    console.log('PASS project toolbar popup floats; options / tabs.create / window.open / manager use tabs and preserve project context')
    await ui.eval(`import('./scripts/app.js').then(m=>m.openUrlInApp(${quote(origin)},'','browser'))`)
    await guest(origin,'#browserFrame')
    await waitFor(()=>ui.eval(`!!document.querySelector('#browserActions [data-ext="${id}"]')?.offsetHeight`),'plugin toolbar button')
    const browserWindows=await count(),browserTabs=await ui.eval("document.querySelectorAll('#browserFrame webview').length")
    await ui.eval(`document.querySelector('#browserActions [data-ext="${id}"]').click()`)
    const browserPopup=await waitFor(()=>popupFor(url+'popup.html'),'floating Browser-mode extension popup')
    console.log('STEP Browser-mode toolbar popup floated')
    assert.equal(await ui.eval("document.querySelectorAll('#browserFrame webview').length"),browserTabs,'Browser-mode popup is not a tab')
    assert.equal(await count(),browserWindows+1)
    await inspector.eval(`(()=>{void testElectron.webContents.fromId(${browserPopup}).executeJavaScript('chrome.action.openPopup()');return true})()`)
    await waitFor(async()=>!(await popupFor(url+'popup.html')),'action.openPopup toggles the floating popup closed')
    assert.equal(await ui.eval("document.querySelectorAll('#browserFrame webview').length"),browserTabs)
    assert.equal(await count(),browserWindows)
    assert.deepEqual(await inspector.eval('outside'),[])
    console.log('PASS Browser-mode toolbar and action.openPopup use a floating popup without a new tab or system browser')
    await inspector.eval(`testElectron.webContents.fromId(${manager}).loadURL(${quote(origin)})`)
    assert.equal(await inspector.eval(`testElectron.webContents.fromId(${manager}).executeJavaScript('typeof browserExtensionsAPI')`),'undefined')
    console.log('PASS management privilege is absent after navigation to an ordinary website')
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)) }
}
async function edgeTts() {
  await ui.eval('window.electronAPI.pages.navigate({page:"translate"})')
  await waitFor(()=>ui.eval('document.querySelector("#page-translate")?.classList.contains("active") && document.querySelector("#translateStatus")?.textContent.includes("翻譯：")'),'translate page initialized')
  await ui.eval(`(()=>{globalThis.ttsPlayed=[];globalThis.ttsAudio=[];const AudioType=globalThis.Audio;globalThis.Audio=function(...args){const audio=new AudioType(...args);ttsAudio.push(audio);audio.muted=true;audio.addEventListener('playing',()=>ttsPlayed.push({duration:audio.duration,ready:audio.readyState}));return audio};document.querySelector('.translate-voice').open=true})()`)
  for(const lang of ['zh-TW','zh-CN','en','ja']) {
    const selector='.tts-preview-btn[data-tts-preview="'+lang+'"]'
    const before=await ui.eval('ttsPlayed.length')
    await ui.eval(`document.querySelector(${quote(selector)}).click()`)
    await waitFor(()=>ui.eval('ttsPlayed.length>'+before),'real TTS playback '+lang,30000).catch(async error=>{
      console.log('Preview diagnostic',await ui.eval(`({button:document.querySelector(${quote(selector)}).outerHTML,toast:document.querySelector('.toast-message')?.textContent})`))
      throw error
    })
    const audio=await ui.eval('ttsPlayed.at(-1)')
    assert.ok(audio.duration>0 && audio.ready>=2)
    await ui.eval(`document.querySelector(${quote(selector)}).click()`)
    console.log('PASS Edge TTS actual preview playback',lang,audio.duration+'s')
    await new Promise(resolve=>setTimeout(resolve,2500))
  }
  const before=await ui.eval('ttsPlayed.length')
  await ui.eval(`(()=>{const input=document.querySelector('#translateInput');input.value='你好，這是翻譯頁的朗讀測試。';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#translateSpeakInputBtn').click()})()`)
  await waitFor(()=>ui.eval('ttsPlayed.length>'+before),'translation read aloud',30000).catch(async error=>{
    console.log('TTS diagnostic',await ui.eval(`({button:document.querySelector('#translateSpeakInputBtn').outerHTML,input:document.querySelector('#translateInput').value,toast:document.querySelector('.toast-message')?.innerText,played:ttsPlayed,audio:ttsAudio.map(a=>({error:a.error?.code,ready:a.readyState,duration:a.duration,paused:a.paused,source:a.src.slice(0,30)}))})`))
    throw error
  })
  await ui.eval(`document.querySelector('#translateSpeakInputBtn').click()`)
  console.log('PASS Edge TTS translation read-aloud button and native MP3 playback')
}
async function main() {
  seed()
  try {
    await start()
    if(process.argv.includes('--tts-only')) { await edgeTts();return }
    if(process.argv.includes('--extension-tabs-only')) { await extensionTabs(await installLocal());return }
    const localId = await installLocal()
    assert.equal(await installLocal(), localId, '重裝本機套件保留 ID')
    assert.equal((await loaded()).filter((row) => row.id === localId).length, 1)
    await runScript('cmd'); await runScript('ps1')
    if(process.argv.includes('--scripts-only')) return
    await stop(); await start()
    await waitFor(async () => (await loaded()).some((row) => row.id === localId), 'restore extension after restart')
    await waitFor(async () => {
      await menu()
      return inspector.eval("!!globalThis.extensionMenu?.some(r=>r.label==='AxonDeck custom test')")
    }, 'restored extension menu')
    await inspector.eval("extensionMenu.find(r=>r.label==='AxonDeck custom test').submenu.find(r=>r.label==='移除').click()")
    assert.ok(!(await loaded()).some((row) => row.id === localId))
    assert.ok(fs.existsSync(path.join(EXT, 'manifest.json')), '移除不能刪來源')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'browser-extensions/local-extensions.json'))), [])
    console.log('PASS restart restores local extension; uninstall keeps source files')
    await inspector.eval(`testElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${quote(NESTED)}]})`)
    await menu(); await inspector.eval("extensionMenu.find(r=>r.label==='安裝本機擴充功能資料夾…').click()")
    assert.ok(await inspector.eval("messages.some(m=>m.includes('manifest.json'))"))
    console.log('PASS rejects folder without manifest')
    const storeUrl = `https://chromewebstore.google.com/detail/${STORE_ID}`
    await ui.eval(`import('./scripts/workspace-page.js').then(m=>m.openUrlInProject(${quote(storeUrl)},${quote(PARENT_ID)}))`)
    const guest = await waitFor(() => ui.eval(`(()=>{const w=Array.from(document.querySelectorAll('#wsBrowserFrame webview')).find(w=>w.getURL?.().includes(${quote(STORE_ID)}));return w?.getWebContentsId()})()`), 'store tab')
    await ui.eval(`window.electronAPI.workspace.extensionsMenu(${guest},{x:100,y:40,width:32,height:32})`)
    await inspector.eval("extensionMenu.find(r=>r.label==='安裝這個擴充功能').click()")
    await waitFor(async () => (await loaded()).some((row) => row.id === STORE_ID), 'real Google CRX installation', 90000)
    console.log('PASS real Chrome store CRX download and load')
    assert.deepEqual(await inspector.eval('outside'), [])
  } finally { await stop() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
