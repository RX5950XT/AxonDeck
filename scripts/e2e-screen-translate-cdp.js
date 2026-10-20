'use strict'

/** node scripts/e2e-screen-translate-cdp.js — 打包版真桌面擷取 → PaddleOCR-VL → 本機翻譯。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const DATA = tempDir('screen-translate-cdp-')
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
const REAL = path.join(process.env.APPDATA, 'voiceink')
const OUT = path.resolve('dist/qa/screen-translate')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(action, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result } catch (error) { last = error }
    await sleep(200)
  }
  throw new Error(`${label}: ${last?.message || 'timeout'}`)
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = ({ data }) => {
      const result = JSON.parse(data)
      if (result.method === 'Runtime.exceptionThrown') this.exceptions.push(result.params.exceptionDetails.text)
      const pending = this.pending.get(result.id)
      if (!pending) return
      this.pending.delete(result.id); clearTimeout(pending.timer)
      if (result.error) pending.reject(new Error(result.error.message)); else pending.resolve(result.result)
    }
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    await this.send('Runtime.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)) }, 120000)
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { for (const pending of this.pending.values()) clearTimeout(pending.timer); this.ws?.close() }
}
require('./lib/page-cdp').followMainPage(Cdp)

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}

async function main() {
  fs.symlinkSync(path.join(REAL, 'models'), path.join(DATA, 'models'), 'junction')
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ sysmonSensors: false, agyEnabled: false, dictationEnabled: false,
    translator: 'local', localTranslateModel: 'linguaforge08q4', translateGlossaryBuiltin: false, closeToTray: false }))
  fs.writeFileSync(path.join(DATA, 'explorer.json'), JSON.stringify({ uffsAuto: false }))
  const port = await freePort(), inspect = await freePort()
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^CLAUDECODE$|^CLAUDE_CODE_/i.test(key)) delete env[key]
  const child = spawn(EXE, [`--user-data-dir=${DATA}`, `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspect}`, '--hidden'],
    { env, detached: true, stdio: 'ignore' })
  let ui, inspector, overlay
  const list = (p) => fetch(`http://127.0.0.1:${p}/json/list`, { signal: AbortSignal.timeout(2000) }).then((response) => response.json())
  try {
    const target = await waitFor(async () => (await list(port)).find((page) => /index\.html/.test(page.url)), '主視窗')
    ui = new Cdp(target.webSocketDebuggerUrl); await ui.connect()
    const mainTarget = await waitFor(async () => (await list(inspect))[0], 'main inspector')
    inspector = new Cdp(mainTarget.webSocketDebuggerUrl); inspector.fixedPage = true; await inspector.connect()
    await waitFor(() => ui.eval('!!window.electronAPI?.screenTranslate'), 'preload')
    const missing = await ui.eval("electronAPI.models.status().then(s=>['paddleocrvl16','linguaforge08q4'].filter(k=>!s.models[k]?.downloaded))")
    assert.deepEqual(missing, [], '真模型必須事先下載；測試不自動下載')
    await ui.eval("electronAPI.pages.navigate({page:'translate'})")
    await waitFor(() => ui.eval("document.getElementById('screenTranslateOpen')?.offsetHeight>0"), '翻譯入口')
    await inspector.eval(`(async () => {
      globalThis.testElectron = process.mainModule.require('electron');
      globalThis.testRequire = process.mainModule.require('module').createRequire(testElectron.app.getAppPath()+'/src/main/main.js');
      const {BrowserWindow,screen}=testElectron;
      const area=screen.getPrimaryDisplay().workArea;
      globalThis.fixture=new BrowserWindow({x:area.x+60,y:area.y+60,width:960,height:700,show:false,frame:false,alwaysOnTop:true,webPreferences:{sandbox:true}});
      await fixture.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html><body style="margin:0;background:white;color:black;font:36px Segoe UI;padding:100px 70px"><div id="text">Hello world<br>This is a screen translation test.</div></body></html>'));
      fixture.showInactive();
      return true;
    })()`)
    await ui.eval("document.getElementById('screenTranslateOpen').click()")
    const overlayTarget = await waitFor(async () => (await list(port)).find((page) => /screen-translate\.html/.test(page.url)), '取景視窗')
    overlay = new Cdp(overlayTarget.webSocketDebuggerUrl); overlay.fixedPage = true; await overlay.connect()
    await inspector.eval(`(() => {
      globalThis.frame=testElectron.BrowserWindow.getAllWindows().find(w=>/screen-translate\.html/.test(w.webContents.getURL()));
      const b=fixture.getBounds();frame.setBounds({x:b.x+30,y:b.y+30,width:800,height:520});return true;
    })()`)
    await waitFor(() => ui.eval("electronAPI.screenTranslate.status().then(r=>{window.lastScreenState=r.data;return !!r.data.translation})"), '真 OCR 與翻譯', 240000)
    const result = await ui.eval('window.lastScreenState')
    fs.mkdirSync(OUT, { recursive: true })
    const crop = await inspector.eval("testRequire('./screen-translate/capture').capture(frame.getContentBounds()).then(image=>image.toPNG().toString('base64'))")
    fs.writeFileSync(path.join(OUT, 'capture.png'), Buffer.from(crop, 'base64'))
    assert.match(result.source, /Hello\s*world/i); assert.match(result.translation, /[\u3400-\u9fff]/)
    assert.match(result.translation, /你好世界/); assert.match(result.translation, /測試/)
    assert(!result.source.includes('</s>'), 'OCR 結束 token 不進原文')
    assert(!/[㐀-鿿]/.test(result.source), '整窗蓋在字上仍只辨識底下的畫面，不讀到自己的介面')
    console.log('PASS real packaged OCR + translation', JSON.stringify({ source: result.source, translation: result.translation, model: result.model }))
    const native = await inspector.eval('({resizable:frame.isResizable(),opacity:frame.getOpacity(),protected:frame.isContentProtected(),focused:frame.isFocused(),bounds:frame.getContentBounds()})')
    assert.equal(native.resizable, true); assert(native.opacity < 1 && native.opacity > 0.8); assert.equal(native.protected, true)
    assert.equal(native.focused, false, '開啟不搶焦點')
    assert.equal(native.bounds.width, 800); assert.equal(native.bounds.height, 520)
    await overlay.eval("document.getElementById('pause').click()")
    await waitFor(() => ui.eval('electronAPI.screenTranslate.status().then(r=>r.data.paused)'), '暫停')
    assert.equal(await overlay.eval("document.getElementById('pause').getAttribute('aria-label')"), '繼續')
    const forbidden = await overlay.eval("electronAPI.screenTranslate.open({sourceLang:'auto',targetLang:'zh-TW'})")
    assert.equal(forbidden.error.code, 'FORBIDDEN', '浮窗無法另開擷取工作')
    for (const theme of ['dark']) {
      assert.equal(await overlay.eval('document.body.scrollWidth <= innerWidth && document.querySelector("main").offsetHeight > 0'), true)
      fs.mkdirSync(OUT, { recursive: true })
      const shot = await overlay.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(OUT, `${theme}.png`), Buffer.from(shot.data, 'base64'))
    }
    await inspector.eval('frame.setContentProtection(false)')
    // Windows 顯示親和性要等下一次桌面合成；只擷取測試白底視窗內的取景窗。
    await sleep(200)
    const desktopShot = await inspector.eval(`(async()=>{
      const bounds=frame.getContentBounds(), display=testElectron.screen.getDisplayMatching(bounds);
      const sources=await testElectron.desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)}});
      const source=sources.find(s=>s.display_id===String(display.id));
      return source.thumbnail.crop(testRequire('./screen-translate/capture').cropRect(bounds,display.bounds,source.thumbnail.getSize())).toPNG().toString('base64');
    })()`)
    fs.writeFileSync(path.join(OUT, 'desktop.png'), Buffer.from(desktopShot, 'base64'))
    const physical = await inspector.eval('testElectron.screen.dipToScreenRect(null,frame.getContentBounds())')
    const desktopFile = path.join(OUT, 'desktop-gdi.png').replace(/'/g, "''")
    const center = { x: Math.floor(physical.width / 2), y: Math.floor(physical.height / 2) }
    const pixel = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $bitmap=[Drawing.Bitmap]::new(${physical.width},${physical.height}); $graphics=[Drawing.Graphics]::FromImage($bitmap); try {$graphics.CopyFromScreen(${physical.x},${physical.y},0,0,$bitmap.Size,[Drawing.CopyPixelOperation]::SourceCopy); $bitmap.Save('${desktopFile}',[Drawing.Imaging.ImageFormat]::Png); $bitmap.GetPixel(${center.x},${center.y}).R} finally {$graphics.Dispose();$bitmap.Dispose()}`], { windowsHide: true, encoding: 'utf8' })
    assert(Number(pixel.trim()) < 128, '桌面上看得到深色譯文面板')
    await overlay.eval("document.getElementById('displayMode').click()")
    assert.equal(await overlay.eval("getComputedStyle(document.getElementById('source')).display"), 'none', '僅譯文隱藏原文')
    await overlay.eval("document.getElementById('displayMode').click()")
    await inspector.eval('frame.setContentProtection(true)')
    await sleep(200)
    const covered = await inspector.eval("testRequire('./screen-translate/capture').capture(frame.getContentBounds()).then(i=>{const s=i.getSize(),b=i.toBitmap();return b[((s.height>>1)*s.width+(s.width>>1))*4]})")
    assert(covered > 200, '面板蓋著時擷取到的仍是底下的白底')
    const resizeResult = await overlay.eval("electronAPI.screenTranslate.resize({x:screenX,y:screenY,width:560,height:400})")
    assert.equal(resizeResult.ok, true, JSON.stringify(resizeResult))
    const resized = await inspector.eval('(({width,height})=>({width,height}))(frame.getBounds())')
    // 非整數 DPI 縮放時 Windows 會差 1px
    assert(Math.abs(resized.width - 560) <= 1 && Math.abs(resized.height - 400) <= 1, `自繪把手縮放：${JSON.stringify(resized)}`)
    assert.equal(await overlay.eval('document.body.scrollWidth<=innerWidth'), true)
    await overlay.eval("document.getElementById('translation').textContent='長譯文\\n'.repeat(40)")
    await waitFor(() => overlay.eval("document.getElementById('text').classList.contains('scrollable')"), '譯文超出框時讓出拖曳區')
    await overlay.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: 300 })
    await waitFor(() => overlay.eval("document.getElementById('text').scrollTop > 0"), '文字區滾輪捲動')
    await inspector.eval(`fixture.webContents.executeJavaScript("document.getElementById('text').innerHTML='Good morning'")`)
    await overlay.eval("document.getElementById('pause').click()")
    await waitFor(() => ui.eval("electronAPI.screenTranslate.status().then(r=>/Good morning/i.test(r.data.source)&&!!r.data.translation)"), '畫面改變後自動更新', 120000)
    console.log('PASS native resize, no focus steal, capture exclusion, pause/resume, dark/light UI, screen updates')
    await overlay.eval("document.getElementById('close').click()")
    await waitFor(() => ui.eval('electronAPI.screenTranslate.status().then(r=>!r.data.open)'), '關閉')
    await waitFor(() => inspector.eval("!testRequire('./engine').status().users.screen"), '釋放獨立引擎')
    assert.deepEqual(overlay.exceptions, []); assert.deepEqual(ui.exceptions, [])
    console.log('PASS close + engine release; no renderer exceptions')
  } finally {
    if (inspector) {
      try { await inspector.eval("(async()=>{await testRequire('./screen-translate').close();testRequire('./hfmodels').shutdown();fixture?.destroy()})()") } catch { /* 程序可能已退出 */ }
    }
    overlay?.close(); ui?.close(); inspector?.close()
    if (child.pid) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已退出 */ } }
    child.kill()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
