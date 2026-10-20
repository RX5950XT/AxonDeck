/** npx electron scripts/test-telegram-page.js — 真實 webview 切頁，隔離資料、不連 Telegram。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')
const { tempDir } = require('./lib/test-temp')

app.setPath('userData', tempDir('telegram-page-'))
const root = tempDir('telegram-fixture-')
const timeout = setTimeout(() => { console.error('FAIL Telegram 切頁逾時'); app.exit(1) }, 45000)
let main

async function run() {
  const appRoot = process.env.AXONDECK_ASAR || path.resolve(__dirname, '..')
  const { createPageWindows } = require(path.join(appRoot, 'src/main/page-windows'))
  const original = process.env.TELEGRAM_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:src/renderer/scripts/telegram-page.js'], { encoding: 'utf8' })
    : fs.readFileSync(path.join(appRoot, 'src/renderer/scripts/telegram-page.js'), 'utf8')
  const source = original.replace("import { electronAPI } from './app.js'", `
    window.clock = Date.now()
    Date.now = () => window.clock
    window.setInterval = (callback) => { window.watch = callback }
    const electronAPI = { ...window.electronAPI,
      store: { get: async () => ['https://web.telegram.org/a/#one'],
        set: async (_key, urls) => { window.saved = urls } }
    }`)
  fs.writeFileSync(path.join(root, 'telegram.mjs'), source)
  fs.writeFileSync(path.join(root, 'page.html'), `<style>
    html,body,#telegramFrame { margin:0; height:100%; display:flex; width:100% }
    .telegram-pane { flex:1; display:flex; flex-direction:column; min-width:0 }
    webview { flex:1 }
  </style><div id="telegramFrame"></div>
  <script type="module">
    import { refreshTelegramPage } from './telegram.mjs'
    window.refresh = refreshTelegramPage
    await refreshTelegramPage()
    window.ready = true
  </script>`)
  const fixture = `<body style="height:5000px"><input id="draft"><script>
    window.token = Math.random()
    window.sizes = []
    window.addEventListener('resize', () => sizes.push([innerWidth,innerHeight]))
  </script>`
  main = new BrowserWindow({ show: false, width: 1200, height: 760 })
  const pages = createPageWindows({ main, isDev: false, hidden: true, icon: '',
    background: () => '#ffffff', secure: ({ webContents }) => {
      webContents.loadFile = () => webContents.loadURL(`file:///${path.join(root, 'page.html').replaceAll('\\', '/')}`)
      webContents.once('did-finish-load', () => pages.ready(webContents))
    } })
  // Telegram guests 使用自己的 partition；只攔截這份隔離 profile 的流量。
  require('electron').session.fromPartition('persist:telegram').protocol.handle('https', () =>
    new Response(fixture, { headers: { 'content-type': 'text/html' } }))
  await pages.navigate({ page: 'telegram' })
  main.showInactive()
  const wc = pages.contents('telegram')
  const evaluate = (code) => wc.executeJavaScript(code)
  const until = async (code) => {
    const deadline = Date.now() + 5000
    while (!await evaluate(code)) {
      if (Date.now() > deadline) throw new Error(`未符合：${code}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await until('window.ready')
  for (let count = 1; count <= 4; count++) {
    if (count > 1) await evaluate("document.querySelector('.telegram-pane:last-child .telegram-pane-add').click()")
    await until(`document.querySelectorAll('webview').length === ${count} &&
      [...document.querySelectorAll('webview')].every(v => { try { return !v.isLoading() && v.getURL().startsWith('https:') } catch { return false } })`)
    const before = await evaluate(`Promise.all([...document.querySelectorAll('webview')].map((v,i) =>
      v.executeJavaScript('location.hash = "room' + i + '"; document.querySelector("#draft").value = "draft' + i +
        '"; scrollTo(0,' + (200 + i * 100) + '); ({ token, hash:location.hash, draft:document.querySelector("#draft").value, y:scrollY })')))`)
    await until(`[...document.querySelectorAll('webview')].every((v,i) => v.dataset.src.endsWith('#room' + i))`)
    await pages.navigate({ page: 'settings' })
    await pages.navigate({ page: 'telegram' })
    const unchanged = await evaluate(`Promise.all([...document.querySelectorAll('webview')].map(v =>
      v.executeJavaScript('({ token, hash:location.hash, draft:document.querySelector("#draft").value, y:scrollY })')))`)
    assert.deepEqual(unchanged, before, '一般切頁完整保留每格狀態')
    await pages.navigate({ page: 'settings' })
    await evaluate(`window.loads = []; [...document.querySelectorAll('webview')].forEach(v => {
      const load = v.loadURL.bind(v)
      v.loadURL = (url) => { window.loads.push(url); return load(url) }
    })`)
    await evaluate(`Promise.all([...document.querySelectorAll('webview')].map(v =>
      v.executeJavaScript('document.body.insertAdjacentHTML("beforeend", "<div id=ConnectionStatusOverlay>等待網路連線</div>")')))`)
    await evaluate('window.watch()')
    await evaluate('window.clock += 61000; window.watch()')
    assert.equal(await evaluate('window.loads.length'), 0, '背景等待連線超過一分鐘也不能重載')
    // Web A 背景重新同步／重連改網址時，不能蓋掉使用者離開前每格各自的聊天室。
    await evaluate(`Promise.all([...document.querySelectorAll('webview')].map((v,i) =>
      v.executeJavaScript('location.hash = ' + JSON.stringify(i % 2 ? '' : 'other-room'))))`)
    await until(`[...document.querySelectorAll('webview')].every((v,i) => v.getURL().endsWith(i % 2 ? '#' : '#other-room'))`)
    await pages.navigate({ page: 'telegram' })
    await evaluate('window.refresh()')
    await until(`[...document.querySelectorAll('webview')].every((v,i) => v.getURL().endsWith('#room' + i))`)
    const after = await evaluate(`Promise.all([...document.querySelectorAll('webview')].map(v =>
      v.executeJavaScript('({ token, hash:location.hash, draft:document.querySelector("#draft").value, y:scrollY })')))`)
    assert.deepEqual(after.map(({ token, hash, draft }) => ({ token, hash, draft })),
      before.map(({ token, hash, draft }) => ({ token, hash, draft })))
    assert.deepEqual(await evaluate('window.saved'), before.map(({ hash }) => `https://web.telegram.org/a/${hash}`))
    console.log(`PASS ${count} 格：一般切頁完整保留；背景超過一分鐘不重載；背景改址後還原各自聊天室及草稿`)
  }
  await evaluate(`document.querySelector('webview').executeJavaScript(\`new Promise(resolve => {
    const child = document.createElement('iframe')
    child.src = 'https://web.telegram.org/a/embedded'
    child.onload = () => {
      child.contentWindow.addEventListener('hashchange', () => resolve(true), { once: true })
      child.contentWindow.location.hash = 'embedded-room'
    }
    document.body.appendChild(child)
  })\`)`)
  assert.equal(await evaluate('window.saved[0]'), 'https://web.telegram.org/a/#room0')
  console.log('PASS 內嵌頁面導覽不覆蓋聊天室')
  await evaluate('window.loads = []; window.watch()')
  await evaluate('window.clock += 61000; window.watch()')
  assert.ok(await evaluate('window.loads.length > 0'), '前景持續斷線仍會復原')
  await until(`[...document.querySelectorAll('webview')].every((v,i) =>
    !v.isLoading() && v.getURL().endsWith('#room' + i))`)
  console.log('PASS 前景持續斷線仍重連原本四個聊天室')
}

app.whenReady().then(run).then(() => {
  clearTimeout(timeout)
  main.destroy()
  app.exit(0)
}).catch((error) => {
  console.error(error)
  clearTimeout(timeout)
  main?.destroy()
  app.exit(1)
})
