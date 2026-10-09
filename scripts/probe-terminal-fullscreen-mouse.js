'use strict'
// 真 Chromium 滑鼠事件，隔離隱藏視窗；不連 AI、不改剪貼簿。
const path = require('node:path')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(path.join(__dirname, '../node_modules/electron/dist/electron.exe'), [__filename], {
    env, windowsHide: true, stdio: 'inherit'
  })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code || 0 })
} else {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const assert = require('node:assert/strict')
  const { pathToFileURL } = require('node:url')
  const dir = require('./lib/test-temp').tempDir('native-mouse-')
  app.setPath('userData', dir)
  const url = rel => pathToFileURL(path.resolve(__dirname, '..', rel)).href
  const html = path.join(dir, 'index.html')
  fs.writeFileSync(html, `<link rel="stylesheet" href="${url('node_modules/@xterm/xterm/css/xterm.css')}"><div id="term" style="width:800px;height:500px"></div>`)
  let win
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { backgroundThrottling: false } })
    await win.loadFile(html)
    const run = code => win.webContents.executeJavaScript(code)
    await run(`(async()=>{
      const {Terminal}=await import(${JSON.stringify(url('node_modules/@xterm/xterm/lib/xterm.mjs'))});
      const {blockMouseReporting}=await import(${JSON.stringify(url('src/renderer/scripts/term-mouse.js'))});
      window.term=new Terminal({cols:80,rows:24});term.open(document.querySelector('#term'));
      blockMouseReporting(term,true);window.sent=[];term.onData(data=>sent.push(data));
      await new Promise(r=>term.write('\\x1b[?1049h\\x1b[?1002h\\x1b[?1006hMouse selection sample',r));
    })()`)
    assert.equal(await run('term.modes.mouseTrackingMode'), 'drag')
    const box = await run('document.querySelector(".xterm-screen").getBoundingClientRect().toJSON()')
    win.webContents.debugger.attach('1.3')
    const mouse = (type, extra = {}) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, x: box.x + 40, y: box.y + 8, ...extra
    })
    await mouse('mousePressed', { button: 'left', buttons: 1, clickCount: 1 })
    await mouse('mouseMoved', { x: box.x + 120, button: 'left', buttons: 1 })
    await mouse('mouseReleased', { x: box.x + 120, button: 'left', buttons: 0, clickCount: 1 })
    await mouse('mouseWheel', { deltaX: 0, deltaY: 120 })
    const events = await run('sent.join("")')
    assert(/\x1b\[<0;\d+;\d+M/.test(events), 'CLI 應收到左鍵')
    assert(/\x1b\[<32;\d+;\d+M/.test(events), 'CLI 應收到拖曳')
    assert(/\x1b\[<65;\d+;\d+M/.test(events), 'CLI 應收到滾輪')
    await run('sent.length=0')
    await mouse('mouseWheel', { modifiers: 2, deltaX: 0, deltaY: 120 })
    assert.equal(await run('sent.join("")'), '', 'Ctrl+滾輪不可送 CLI')
    await mouse('mousePressed', { modifiers: 8, button: 'left', buttons: 1, clickCount: 1 })
    await mouse('mouseMoved', { modifiers: 8, x: box.x + 140, button: 'left', buttons: 1 })
    await mouse('mouseReleased', { modifiers: 8, x: box.x + 140, button: 'left', buttons: 0, clickCount: 1 })
    assert(await run('term.hasSelection()'), 'Shift+拖曳應保留本地選取')
    assert.equal(await run('sent.join("")'), '', 'Shift 選取不能誤操作 CLI')
    console.log('PASS 真滑鼠：全螢幕點擊、拖曳、滾輪；Ctrl+滾輪與 Shift+本地選取')
  }).then(() => { win?.destroy(); app.exit(0) }).catch(error => {
    console.error(error); win?.destroy(); app.exit(1)
  })
}
