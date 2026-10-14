/** 功能頁右鍵彈出／收回：隔離資料，真實 CDP 滑鼠，永不呼叫上游或模型下載。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const { NAV_PAGES } = require('./lib/nav-pages')

const PORT = 9287
const profile = tempDir('page-windows-')
const fixture = path.join(profile, 'fixture-project')
fs.mkdirSync(fixture)
fs.writeFileSync(path.join(fixture, 'hello.txt'), '獨立視窗測試')
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  sysmonSensors: false, uffsAuto: false, dictationEnabled: false, agyEnabled: false,
  updateAutoCheck: false, telegramPanes: []
}))
const source = process.env.AXONDECK_TEST_SOURCE === '1'
const exe = source ? require('electron') : process.env.AXONDECK_EXE || path.resolve('dist/win-unpacked/AxonDeck.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(exe, [...(source ? ['.'] : []), `--remote-debugging-port=${PORT}`,
  `--inspect=${PORT + 1}`, `--user-data-dir=${profile}`, '--hidden'], { detached: true, stdio: 'ignore', env })
const clients = []
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(read, description) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await pause(100)
  }
  throw new Error(`逾時：${description}`)
}

async function targets(port = PORT) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() }
  catch { return [] }
}

async function connect(query, port = PORT) {
  const target = await until(async () => (await targets(port)).find((t) => t.url.includes(query)), query)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP ${method} 逾時：${String(params.expression || '').slice(0, 120)}`)) }, 45000)
    pending.set(key, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const client = { send, evaluate, ws, target }
  clients.push(client)
  if (port === PORT) await until(() => evaluate('!!window.electronAPI && document.readyState === "complete"'), `${query} ready`)
  return client
}

async function rightClick(client, page) {
  await client.evaluate(`Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('畫面未更新')), 5000))
  ])`)
  const point = await client.evaluate(`(() => {
    const r = document.querySelector('.nav-tab[data-page="${page}"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, ...point })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, ...point })
}

async function main() {
  const inspector = await connect('', PORT + 1)
  const showInactive = (page = 'chat') => inspector.evaluate(`(() => {
    const electron = process.mainModule.require('electron');
    electron.BrowserWindow.getAllWindows().forEach(w => w.showInactive());
    // 測試可能被使用者前景視窗遮住；只解除本輪 renderer 節流，不改產品行為。
    electron.webContents.getAllWebContents().find(w => w.getURL().includes(${JSON.stringify(`page=${page}`)}))?.setBackgroundThrottling(false);
  })()`)
  const host = await connect('host=1')
  const chat = await connect('page=chat')
  await until(() => chat.evaluate('!!document.querySelector("#page-chat.active")'), 'chat active')
  await showInactive()
  const invalid = await host.evaluate('electronAPI.pages.navigate({page:"../../evil"}, true)')
  assert.equal(invalid.ok, false)
  console.log('PASS 無效頁面拒絕')
  for (const page of NAV_PAGES) {
    console.log(`CHECK ${page}`)
    // host 是實際導覽列；CDP 可在 hidden 模式送滑鼠，不搶使用者焦點。
    await host.evaluate(`electronAPI.pages.navigate({page:${JSON.stringify(page)}})`)
    const client = page === 'chat' ? chat : await connect(`page=${page}`)
    await showInactive(page)
    await client.send('Page.captureScreenshot')
    await rightClick(client, page)
    await until(() => client.evaluate('document.body.classList.contains("page-floating")'), `${page} floating`)
    await showInactive(page)
    await client.send('Page.captureScreenshot')
    const token = `keep-${page}`
    await client.evaluate(`window.__pageTest = ${JSON.stringify(token)}; document.querySelector('#page-${page}').dataset.keep = window.__pageTest`)
    assert.equal(await client.evaluate('document.querySelector("#winMin").getAttribute("aria-label")'), '收回主視窗')
    assert.equal(await client.evaluate('!!document.querySelector(".page.active")?.offsetHeight'), true)
    // 重複右鍵不重建 renderer。
    await rightClick(client, page)
    assert.equal((await targets()).filter((t) => t.url.includes(`page=${page}`)).length, 1)
    await client.evaluate('document.querySelector("#winMin").click()')
    await until(() => client.evaluate('!document.body.classList.contains("page-floating")'), `${page} docked`)
    assert.equal(await client.evaluate('window.__pageTest'), token)
    assert.equal(await client.evaluate(`document.querySelector('#page-${page}').dataset.keep`), token)
    // 再彈出、關閉同樣收回；同一個 webContents 與 JS 狀態仍在。
    await showInactive(page)
    await rightClick(client, page)
    await until(() => client.evaluate('document.body.classList.contains("page-floating")'), `${page} reopened`)
    await client.evaluate('document.querySelector("#winClose").click()')
    await until(() => client.evaluate('!document.body.classList.contains("page-floating")'), `${page} closed to dock`)
    assert.equal(await client.evaluate('window.__pageTest'), token)
    console.log(`PASS ${page}：右鍵、重複、最小化、關閉、內容保留`)
  }
  const translation = clients.find((c) => c.target.url.includes('page=translate'))
  await translation.evaluate(`import('./scripts/app.js').then(m => m.openSettingsPage('appearance'))`)
  const settings = clients.find((c) => c.target.url.includes('page=settings'))
  await until(() => settings.evaluate('document.querySelector("#set-appearance").classList.contains("active")'), '跨頁設定')
  console.log('PASS 跨頁前往設定')
  await translation.evaluate(`import('./scripts/app.js').then(m => m.openInFilesPage(${JSON.stringify(fixture)}))`)
  const explorer = clients.find((c) => c.target.url.includes('page=explorer'))
  await until(() => explorer.evaluate(`document.querySelector('#page-explorer').textContent.includes('hello.txt')`), '跨頁開資料夾')
  await explorer.evaluate(`import('./scripts/app.js').then(m => m.openFolderInWorkspace(${JSON.stringify(fixture)}))`)
  await until(() => chat.evaluate(`document.querySelector('#projPanel').textContent.includes('fixture-project')`), '跨頁加入專案')
  console.log('PASS 跨頁開資料夾與加入工作區專案')
  const speech = clients.find((c) => c.target.url.includes('page=speech'))
  await speech.evaluate(`document.querySelector('#speechText').value = '保留尚未生成的語音內容'`)
  await host.evaluate('electronAPI.pages.navigate({page:"translate"}, true)')
  await host.evaluate('electronAPI.pages.navigate({page:"speech"}, true)')
  assert.equal(await translation.evaluate('document.body.classList.contains("page-floating")'), true)
  assert.equal(await clients.find((c) => c.target.url.includes('page=speech')).evaluate('document.body.classList.contains("page-floating")'), true)
  await translation.evaluate('electronAPI.window.minimize()')
  console.log('PASS 兩個獨立視窗同時開啟，收回其中一個')
  await showInactive('speech')
  assert.equal(await inspector.evaluate(`(() => {
    const electron = process.mainModule.require('electron');
    const wc = electron.webContents.getAllWebContents().find(w => w.getURL().includes('page=speech'));
    const win = electron.BrowserWindow.fromWebContents(wc);
    if (!win) return false;
    win.minimize(); return true;
  })()`), true)
  await until(() => speech.evaluate('!document.body.classList.contains("page-floating")'), '原生最小化收回')
  assert.equal(await speech.evaluate('document.querySelector("#speechText").value'), '保留尚未生成的語音內容')
  console.log('PASS 原生最小化事件與真實輸入內容保留')
}

main().then(() => console.log('PASS 功能頁獨立視窗驗收完成')).catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  for (const client of clients) client.ws.close()
  if (child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已退出 */ }
    child.kill()
  }
})
