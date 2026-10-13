'use strict'
// 真實清單唯讀驗證；按鈕流程改接隔離程序裡的 mock，絕不安裝／移除使用者程式。
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const DATA = tempDir('installer-cdp-')
let PORT, INSPECT
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ sysmonSensors: false, agyEnabled: false, dictationEnabled: false }))
fs.writeFileSync(path.join(DATA, 'explorer.json'), JSON.stringify({ uffsAuto: false }))
async function waitFor(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result } catch (error) { last = error }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`${label}: ${last?.message || 'timeout'}`)
}
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = ({ data }) => {
      const m = JSON.parse(data)
      if (m.method === 'Runtime.exceptionThrown') this.exceptions.push(m.params.exceptionDetails.text)
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id); clearTimeout(p.timer)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    await this.send('Runtime.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method)) }, 25000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  close() { for (const p of this.pending.values()) clearTimeout(p.timer); this.ws.close() }
}
require('./lib/page-cdp').followMainPage(Cdp)

async function main() {
  const freePort = () => new Promise((resolve, reject) => {
    const server = require('net').createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
  PORT = await freePort(); INSPECT = await freePort()
  const child = spawn(EXE, [`--user-data-dir=${DATA}`, `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, '--hidden', '--disable-backgrounding-occluded-windows'], { detached: true, stdio: 'ignore' })
  let ui, mainCdp
  try {
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).find((p) => /index\.html/.test(p.url)), 'renderer')
    ui = new Cdp(target.webSocketDebuggerUrl); await ui.connect()
    const inspector = (await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`, { signal: AbortSignal.timeout(3000) })).json())[0]
    mainCdp = new Cdp(inspector.webSocketDebuggerUrl); mainCdp.fixedPage = true; await mainCdp.connect()
    await mainCdp.eval("process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w=>w.showInactive())")
    await waitFor(() => ui.eval('!!window.electronAPI?.pages'), 'preload')
    const navigation = await ui.eval("window.electronAPI.pages.navigate({page:'settings',subtab:'install'})")
    assert.equal(navigation.ok, true)
    await waitFor(() => ui.eval("document.querySelector('#set-install.active') && document.querySelectorAll('[data-catalog]').length===18"), 'catalog')
    await waitFor(() => ui.eval("window.electronAPI.appInstaller.status().then(r=>r.ok && r.data.checkedAt && !r.data.scanning)"), 'real scan')
    const live = await ui.eval('window.electronAPI.appInstaller.status().then(r=>({count:r.data.installed.length,catalog:r.data.catalog.length,errors:r.data.catalog.filter(x=>x.sourceError).map(x=>x.name)}))')
    assert.equal(live.catalog, 18); assert.ok(live.count > 0); assert.deepEqual(live.errors, [])
    console.log('PASS real packaged IPC inventory', JSON.stringify(live))
    const realState = await ui.eval('window.electronAPI.appInstaller.status().then(r=>r.data)')
    const invalid = await ui.eval("window.electronAPI.appInstaller.start({action:'install',key:'not-a-package'})")
    assert.equal(invalid.ok, false)
    await ui.eval("document.querySelector('[data-filter=installed]').click(); document.querySelector('#installSearch').value='NVIDIA'; document.querySelector('#installSearch').dispatchEvent(new Event('input'))")
    assert.ok(await ui.eval("[...document.querySelectorAll('#installList h3')].every(x=>x.textContent.includes('NVIDIA'))"))
    await ui.eval("document.querySelector('[data-filter=updates]').click(); document.querySelector('#installSearch').value=''; document.querySelector('#installSearch').dispatchEvent(new Event('input'))")
    assert.ok(await ui.eval("document.querySelectorAll('#installList .install-row').length>0"))
    await ui.eval("document.querySelector('[data-filter=installed]').click(); document.querySelector('[data-category=\"開發工具\"]').click()")
    assert.ok(await ui.eval("[...document.querySelectorAll('#installList .install-row')].every(x=>x.querySelector('.install-meta').textContent==='開發工具')"))
    await ui.eval("document.querySelector('[data-category=\"\"]').click()")
    console.log('PASS installed search, available updates, category filter, invalid request rejected')

    // 替換的只有測試程序的 IPC；production module 另有真執行邏輯測試。
    await mainCdp.eval(`(() => {
      const {ipcMain,webContents}=process.mainModule.require('electron');
      globalThis.installerCalls=[];
      globalThis.installerState={checkedAt:Date.now(),scanning:false,busy:false,scanError:'',jobs:[],installed:[{key:'qa-row',id:'QA.App',name:'QA 測試程式',version:'1.0',available:'2.0',canUpgrade:true,canUninstall:true}],catalog:[{key:'qa-install',name:'QA 新程式',group:'測試',source:'測試來源',installedKeys:[],canInstall:true}]};
      globalThis.emitInstaller=()=>webContents.getAllWebContents().filter(w=>/index\\.html/.test(w.getURL())).forEach(w=>w.send('appInstaller:state',globalThis.installerState));
      for(const c of ['status','refresh','start','upgradeAll'])ipcMain.removeHandler('appInstaller:'+c);
      ipcMain.handle('appInstaller:upgradeAll',()=>{globalThis.installerCalls.push({action:'upgradeAll'});return {ok:true,data:{count:1}}});
      ipcMain.handle('appInstaller:status',()=>({ok:true,data:globalThis.installerState}));
      ipcMain.handle('appInstaller:refresh',()=>({ok:true,data:globalThis.installerState}));
      ipcMain.handle('appInstaller:start',(_e,r)=>{globalThis.installerCalls.push(r); globalThis.installerState={...globalThis.installerState,busy:true,jobs:[{id:'qa-job',name:'QA 測試程式',action:r.action,phase:'running',message:'測試背景進度',progress:42}]};globalThis.emitInstaller();return {ok:true,data:{id:'qa-job'}}});
      globalThis.emitInstaller(); return true;
    })()`)
    await ui.eval("document.querySelector('[data-filter=catalog]').click(); document.querySelector('#installList button').click()")
    await waitFor(() => ui.eval("document.querySelector('#installJobs progress')?.value===42"), 'progress')
    assert.equal(await ui.eval("[...document.querySelectorAll('#installList button')].every(b=>b.disabled)"), true)
    await ui.eval("document.querySelector('[data-section=basic]').click(); document.querySelector('[data-section=install]').click()")
    await waitFor(() => ui.eval("document.querySelector('#installJobs progress')?.value===42"), 'persistent progress')
    await mainCdp.eval("globalThis.installerState={...globalThis.installerState,busy:false,jobs:[{...globalThis.installerState.jobs[0],phase:'failed',message:'測試失敗提示',progress:null}]};globalThis.emitInstaller()")
    await waitFor(() => ui.eval("document.querySelector('#installJobs').textContent.includes('測試失敗提示')"), 'failure')
    await ui.eval("document.querySelector('[data-filter=installed]').click(); [...document.querySelectorAll('#installList button')].find(b=>b.textContent==='解除安裝').click()")
    await waitFor(() => ui.eval("!!document.querySelector('dialog[open]')"), 'confirmation')
    await ui.eval("document.querySelector('dialog[open] .btn-secondary').click()")
    assert.equal(await mainCdp.eval('globalThis.installerCalls.length'), 1)
    await ui.eval("[...document.querySelectorAll('#installList button')].find(b=>b.textContent==='更新').click()")
    await waitFor(() => mainCdp.eval('globalThis.installerCalls.length===2'), 'upgrade')
    assert.equal(await mainCdp.eval('globalThis.installerCalls[1].action'), 'upgrade')
    await mainCdp.eval("globalThis.installerState={...globalThis.installerState,busy:false,jobs:[]};globalThis.emitInstaller()")
    await waitFor(() => ui.eval("!document.querySelector('#installUpgradeAll').disabled && !document.querySelector('#installUpgradeAll').hidden"), 'upgrade all ready')
    await ui.eval("document.querySelector('#installUpgradeAll').click()")
    await waitFor(() => ui.eval("!!document.querySelector('dialog[open] .btn-primary')"), 'upgrade all confirmation')
    await ui.eval("document.querySelector('dialog[open] .btn-primary').click()")
    await waitFor(() => mainCdp.eval("globalThis.installerCalls.at(-1)?.action==='upgradeAll'"), 'upgrade all')
    console.log('PASS install/update controls, cancellation, background progress, failure UI, repeat-click lock, upgrade all')

    await mainCdp.eval(`globalThis.installerState=${JSON.stringify(realState)};globalThis.emitInstaller();process.mainModule.require('electron').BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().includes('host=1')).forEach(w=>w.showInactive())`)
    await ui.eval("document.querySelector('[data-filter=catalog]').click()")
    await ui.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    for (const width of [1200, 650]) {
      await ui.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
      await waitFor(() => ui.eval("document.querySelector('#set-install').offsetHeight>0"), 'visible layout')
      assert.equal(await ui.eval("document.querySelector('#settingsScroll').scrollWidth<=document.querySelector('#settingsScroll').clientWidth"), true)
      if (process.env.INSTALLER_SCREENSHOTS) {
        const capture = await ui.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(process.env.INSTALLER_SCREENSHOTS, `installer-${width}.png`), capture.data, 'base64')
      }
    }
    assert.deepEqual(ui.exceptions, [])
    console.log('PASS wide/narrow layout; no renderer exceptions')
  } finally {
    ui?.close(); mainCdp?.close()
    if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
    child.kill()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
