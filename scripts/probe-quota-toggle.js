'use strict'
// 額度條：同一顆點兩下要收起來（抽屜按鈕與各家額度詳情都要）。真滑鼠事件，隔離 profile。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const root = path.resolve(__dirname, '..')
const exe = process.env.AXONDECK_EXE || path.join(root, 'dist/win-unpacked/AxonDeck.exe')
const profile = tempDir('quota-toggle-')
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
    const value = await check().catch(() => null)
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
    const callback = pending.get(msg.id)
    if (!callback) return
    pending.delete(msg.id)
    callback(msg)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    pending.set(key, msg => (msg.error || msg.result?.exceptionDetails ? reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails))) : resolve(msg.result)))
    ws.send(JSON.stringify({ id: key, method, params }))
  })
  return { ws, send, eval: async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value }
}
async function click(selector) {
  const point = await cdp.eval(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.scrollIntoView({block:'nearest',inline:'nearest'}); const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await delay(250)
}

async function main() {
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ closeToTray: false, sysmonSensors: false, uffsAuto: false, dictationEnabled: false, agyEnabled: false, autoUpdate: false }))
  const realUsage = path.join(process.env.APPDATA, 'voiceink', 'usage.json')
  if (fs.existsSync(realUsage)) fs.copyFileSync(realUsage, path.join(profile, 'usage.json'))
  const port = await freePort(), inspectPort = await freePort()
  child = spawn(exe, ['--hidden', `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`, `--user-data-dir=${profile}`], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile }
  })
  const page = await wait(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.url.includes('page=chat')), '主畫面沒有啟動')
  cdp = await connect(page.webSocketDebuggerUrl)
  mainCdp = await connect((await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0].webSocketDebuggerUrl)
  await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w=>{w.setPosition(-3000,-3000);w.showInactive()})`)
  await wait(() => cdp.eval('!!document.querySelector("#quotaBar") && document.querySelector("#quotaBar").offsetParent !== null'), '額度條沒出現')
  await wait(() => cdp.eval('innerWidth>400 && !!document.elementFromPoint(innerWidth/2, innerHeight-10)'), '視窗沒有尺寸')
  await delay(1500)

  await click('#quotaStatsBtn')
  assert.equal(await cdp.eval('document.getElementById("quotaDrawer").hidden'), false, '抽屜點了沒打開')
  await click('#quotaStatsBtn')
  assert.equal(await cdp.eval('document.getElementById("quotaDrawer").hidden'), true, '抽屜再點同一顆沒收起來')
  console.log('PASS 抽屜：點開、再點收起')

  await wait(() => cdp.eval('document.querySelectorAll(".quota-item-open").length>0'), '條上沒有任何一家')
  const open = () => cdp.eval('document.getElementById("quotaPopover").matches(":popover-open")')
  await click('.quota-item-open')
  assert.equal(await open(), true, '額度詳情點了沒打開')
  await click('.quota-item-open')
  assert.equal(await open(), false, '額度詳情再點同一家沒收起來')
  if (await cdp.eval('document.querySelectorAll(".quota-item-open").length>1')) {
    await click('.quota-item-open')
    const second = `.quota-item[data-id="${await cdp.eval('document.querySelectorAll(".quota-item")[1].dataset.id')}"] .quota-item-open`
    await click(second)
    assert.equal(await open(), true, '點別家要換成別家')
    await click(second)
    assert.equal(await open(), false, '別家再點也要收起來')
  }
  await click('.quota-item-open')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(200)
  assert.equal(await open(), false, 'Esc 要收起來')
  await click('.quota-item-open')
  await click('#chatInput, textarea, main')
  assert.equal(await open(), false, '點外面要收起來')
  console.log('PASS 額度詳情：點開、再點收起、換家、Esc、點外面')
}
main().catch(error => { console.error('FAIL', error.message); process.exitCode = 1 }).finally(() => {
  cdp?.ws.close(); mainCdp?.ws.close()
  if (child?.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 已退出 */ } }
})
