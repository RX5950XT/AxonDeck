'use strict'
// npx electron scripts/e2e-browser-settings.js：五個預設插件各自的完整介面，使用隔離設定。
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow, session, protocol } = require('electron')
const { tempDir } = require('./lib/test-temp')
const DATA = tempDir('s-'), ROOT = process.env.AXONDECK_ASAR || path.join(__dirname,'..')
const IDS = ['ddkjiahejlhfcafbddmgiahcphecmpfh','ldgfbffkinooeloadekpmfoklnobpien','nnnkddnnlpamobajfibfdgfnbcnkgngh','ndcooeababalnlpkfedmmbbbgkljhpjf','modkelfkcfjpgbfmnbnllalkiogfofhb']
app.setPath('userData',DATA)
protocol.registerSchemesAsPrivileged([require(path.join(ROOT,'src/main/browser-extension-manager')).PRIVILEGES])
app.commandLine.appendSwitch('log-level','3')
async function wait(fn,label) {
  const end = Date.now()+20000
  while(Date.now()<end) { if(await fn()) return; await new Promise(r=>setTimeout(r,100)) }
  throw new Error(label+': timeout')
}
async function main() {
  await app.whenReady()
  const ses=session.fromPartition('persist:wsbrowser'),dir=path.join(DATA,'browser-extensions')
  let service
  const browser=require('./lib/browser-tabs').browserTabs(ses,(contents,win)=>service.attachTab(contents,win))
  service=require(path.join(ROOT,'src/main/browser-extensions')).createBrowserExtensions({session:ses,dir,fetch,chromeVersion:process.versions.chrome,
    aliasPreload:path.join(ROOT,'src/preload/crx-browser-alias.js'),identityPreload:path.join(ROOT,'src/preload/crx-identity.js'),openUrl:browser.openUrl})
  const installed=path.join(process.env.APPDATA,'voiceink/browser-extensions')
  for(const id of IDS) {
    const source=fs.existsSync(installed) && fs.readdirSync(installed).filter(n=>n.startsWith(id+'_')).sort().at(-1)
    if(source) await fs.promises.cp(path.join(installed,source),path.join(dir,id+'_1'),{recursive:true})
    else await service.install(id)
  }
  ses.serviceWorkers.on('console-message',(_e,d)=>{if(d?.level>=2) console.log('worker error',String(d.message).slice(0,250))})
  await service.loadInstalled()
  const original=new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true,contextIsolation:true}})
  await original.loadURL('https://example.com/');service.attachTab(original.webContents,original)
  const failures=[]
  for(const id of IDS) {
    try {
    const record=service.list().find(r=>r.id===id)
    assert.ok(record.options||record.newtab||record.popup, record.name+' interface')
    const windowCount=BrowserWindow.getAllWindows().length
    await service.change(id,'options')
    let win
    await wait(()=>{win=browser.find('chrome-extension://'+id+'/');return !!win},record.name+' tab')
    assert.equal(BrowserWindow.getAllWindows().length,windowCount, 'settings must not create another window')
    const inspect = '(()=>{const roots=[];const visit=r=>{roots.push(r);for(const e of r.querySelectorAll("*"))if(e.shadowRoot)visit(e.shadowRoot)};visit(document);const controls=roots.flatMap(r=>[...r.querySelectorAll("button,input,a,select,textarea,[role=button]")]).filter(e=>e.getBoundingClientRect().height>0);const text=roots.map(r=>[...r.querySelectorAll("*")].filter(e=>!e.children.length && !["STYLE","SCRIPT","NOSCRIPT"].includes(e.tagName) && e.getBoundingClientRect().height>0).map(e=>e.textContent).join(" ")).join(" ");return {controls:controls.length,text:text.slice(0,2000),roots:roots.length}})()'
    await wait(async()=>{const view=await win.webContents.executeJavaScript(inspect);return view.controls>0 && view.text.length>3 && !view.text.includes("Loading settings...")},record.name+' rendered settings').catch(async e=>{console.log('UI diagnostic',await win.webContents.executeJavaScript(inspect));throw e})
    const text=await win.webContents.executeJavaScript(inspect)
    await win.webContents.executeJavaScript('chrome.storage.local.set({axonSettingsProbe:"saved"})')
    await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload()})
    await wait(()=>win.webContents.executeJavaScript('chrome.storage.local.get("axonSettingsProbe").then(r=>r.axonSettingsProbe==="saved")').catch(()=>false),record.name+' persisted settings')
    console.log('PASS',record.name,record.options?'full options':record.newtab?'newtab settings':'popup settings',JSON.stringify(text))
    if(id==='ddkjiahejlhfcafbddmgiahcphecmpfh') {
      assert.equal(record.userScripts,false)
      const file=ses.extensions.getExtension(id).manifest.background.service_worker
      await win.webContents.executeJavaScript('chrome.scripting.registerContentScripts('+JSON.stringify([{id:'ordinary-probe',matches:['https://unused.example/*'],js:[file]}])+')')
      const ordinary=await win.webContents.executeJavaScript('chrome.scripting.getRegisteredContentScripts()')
      assert.ok(ordinary.some(s=>s.id==='ordinary-probe'), 'ordinary scripting works without userScripts approval')
      await wait(()=>win.webContents.executeJavaScript('!!document.querySelector("#developerMode input")'), 'uBO setting')
      const changed=await win.webContents.executeJavaScript('(()=>{const el=document.querySelector("#developerMode input");el.click();return el.checked})()')
      await wait(()=>win.webContents.executeJavaScript('chrome.storage.local.get("rulesetConfig").then(r=>r.rulesetConfig?.developerMode==='+JSON.stringify(changed)+')'), 'uBO actual setting saved')
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload()})
      await wait(()=>win.webContents.executeJavaScript('document.querySelector("#developerMode input")?.checked==='+JSON.stringify(changed)), 'uBO setting restored')
      console.log('PASS uBO actual developer setting persists; ordinary scripting works with userScripts disabled')
    }
    if(id==='nnnkddnnlpamobajfibfdgfnbcnkgngh') {
      await win.webContents.executeJavaScript('(()=>{const roots=[];const visit=r=>{roots.push(r);for(const e of r.querySelectorAll("*"))if(e.shadowRoot)visit(e.shadowRoot)};visit(document);const item=roots.flatMap(r=>[...r.querySelectorAll("*")]).find(e=>e.textContent.trim()==="Settings" && !e.children.length && e.getBoundingClientRect().height>0);if(!item)throw new Error("Settings button missing");item.click()})()')
      await wait(async()=>{const view=await win.webContents.executeJavaScript(inspect);return /Appearance|General|Wallpaper|Search engine|一般|外觀|搜尋引擎/.test(view.text)},'Infinity settings panel')
      console.log('PASS Infinity opens its full settings panel')
    }
    if(id==='modkelfkcfjpgbfmnbnllalkiogfofhb') {
      const code='(async()=>{chrome.contextMenus.create({id:"axon-menu",title:"Original",type:"checkbox",checked:false,contexts:["page"]});chrome.contextMenus.onClicked.addListener(info=>{if(info.menuItemId==="axon-menu")chrome.storage.local.set({axonClick:info})});await chrome.contextMenus.update("axon-menu",{title:"Changed",checked:true,enabled:false,visible:false});})()'
      await win.webContents.executeJavaScript(code)
      const flatten=items=>items.flatMap(item=>[item,...(item.submenu?flatten(item.submenu.items):[])])
      const params={pageURL:original.webContents.getURL(),isEditable:false,mediaType:'none'}
      let item=flatten(service.contextMenuItems(original.webContents,params)).find(item=>item.id==='axon-menu')
      assert.equal(item,undefined, 'hidden menu is excluded')
      await win.webContents.executeJavaScript('chrome.contextMenus.update("axon-menu",{visible:true})')
      item=flatten(service.contextMenuItems(original.webContents,params)).find(item=>item.id==='axon-menu')
      assert.ok(item);assert.equal(item.label,'Changed');assert.equal(item.checked,true);assert.equal(item.enabled,false)
      await win.webContents.executeJavaScript('chrome.contextMenus.update("axon-menu",{enabled:true,visible:true})')
      item=flatten(service.contextMenuItems(original.webContents,params)).find(item=>item.id==='axon-menu')
      assert.equal(item.visible,true);item.click(item,original)
      await wait(()=>win.webContents.executeJavaScript('chrome.storage.local.get("axonClick").then(r=>r.axonClick?.checked===false && r.axonClick.wasChecked===true)'), 'menu checked event')
      assert.equal(await win.webContents.executeJavaScript('chrome.contextMenus.update("axon-menu",{parentId:"axon-menu"}).then(()=>false,()=>true)'),true)
      assert.equal(await win.webContents.executeJavaScript('new Promise(resolve=>chrome.contextMenus.update("missing",{title:"x"},()=>resolve(!!chrome.runtime.lastError)))'),true)
      await win.webContents.executeJavaScript('chrome.contextMenus.remove("axon-menu")')
      console.log('PASS real context menu title / visible / enabled / checked / event, invalid update errors')
    }
    win.destroy()
    } catch(e) { failures.push(e.message);console.log('FAIL',id,e.stack) }
  }
  assert.deepEqual(failures,[])
  for(const win of BrowserWindow.getAllWindows())win.destroy()
  for(const ext of ses.extensions.getAllExtensions())ses.extensions.removeExtension(ext.id)
}
main().then(()=>app.exit(0),e=>{console.error(e);app.exit(1)})
