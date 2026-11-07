/** npx electron scripts/test-telegram-page.js — 真實 webview 切頁，隔離資料、不連 Telegram。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')
const { tempDir } = require('./lib/test-temp')

// 測試視窗被別的視窗蓋住時 document.hidden 會變 true（Windows 遮蔽偵測），頁面會當成看不到
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setPath('userData', tempDir('telegram-page-'))
const root = tempDir('telegram-fixture-')
const timeout = setTimeout(() => { console.error('FAIL Telegram 切頁逾時'); app.exit(1) }, 90000)
let main

async function run() {
  const appRoot = process.env.AXONDECK_ASAR || path.resolve(__dirname, '..')
  const { createPageWindows } = require(path.join(appRoot, 'src/main/page-windows'))
  const original = process.env.TELEGRAM_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:src/renderer/scripts/telegram-page.js'], { encoding: 'utf8' })
    : fs.readFileSync(path.join(appRoot, 'src/renderer/scripts/telegram-page.js'), 'utf8')
  const source = original.replace('const SETTLE_MS = 15000', 'const SETTLE_MS = 1500').replace("import { electronAPI } from './app.js'", `
    window.clock = Date.now()
    window.savedLog = []
    Date.now = () => window.clock
    window.setInterval = (callback) => { window.watch = callback }
    const electronAPI = { ...window.electronAPI,
      store: { get: async () => ['https://web.telegram.org/a/#one'],
        set: async (_key, urls) => { window.saved = urls; window.savedLog.push(urls) } }
    }`)
  fs.writeFileSync(path.join(root, 'telegram.mjs'), source)
  fs.writeFileSync(path.join(root, 'page.html'), `<style>
    html,body,#telegramFrame { margin:0; height:100%; display:flex; width:100% }
    .telegram-pane { flex:1; display:flex; flex-direction:column; min-width:0 }
    webview { flex:1 }
  </style><div id="telegramFrame"></div>
  <script type="module">
    import { refreshTelegramPage, setTelegramPaneVisible } from './telegram.mjs'
    window.refresh = refreshTelegramPage
    window.setPane = setTelegramPaneVisible
    await refreshTelegramPage()
    window.ready = true
  </script>`)
  const fixture = `<body style="height:5000px"><input id="draft"><script>
    window.token = Math.random()
    window.sizes = []
    window.addEventListener('resize', () => sizes.push([innerWidth,innerHeight]))
    // 跟真實 Web A 一樣：剛載好時網址閃回列表再回聊天室；開著時外部改 hash 會被彈回列表
    const opened = location.hash
    // 載入後被彈回列表（真實 Web A 量到會這樣）
    if (opened === '#cold') {
      setTimeout(() => { location.hash = '' }, 100)
    } else if (opened) {
      setTimeout(() => { if (location.hash === opened) { history.replaceState(null, '', location.pathname); location.hash = opened } }, 100)
    }
    window.addEventListener('hashchange', () => {
      if (window.bounce) location.hash = ''
    })
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
  await pages.navigate({ page: 'chat' })
  main.showInactive()
  const wc = pages.contents('chat')
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
    await pages.navigate({ page: 'chat' })
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
    await evaluate(`Promise.all([...document.querySelectorAll('webview')].map(v => v.executeJavaScript('window.bounce = true')))`)
    await evaluate('window.savedLog = []')
    await pages.navigate({ page: 'chat' })
    await evaluate('window.refresh()')
    // 彈回列表的頁面只能靠整頁重載帶回（token 會換）；閃回列表那一下不能存進設定
    await until(`[...document.querySelectorAll('webview')].every((v,i) => v.getURL().endsWith('#room' + i))`)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const after = await evaluate(`Promise.all([...document.querySelectorAll('webview')].map(v =>
      v.executeJavaScript('({ token, hash:location.hash })')))`)
    assert.deepEqual(after.map(({ hash }) => hash), before.map(({ hash }) => hash), '每格回到原本的聊天室')
    assert.ok(after.every(({ token }, i) => token !== before[i].token), '背景改址只能整頁重載')
    const expected = before.map(({ hash }) => `https://web.telegram.org/a/${hash}`)
    assert.deepEqual(await evaluate('window.saved'), expected)
    assert.ok((await evaluate('window.savedLog')).flat().every((url) => url.includes('#room')), '過程中不把列表存進設定')
    console.log(`PASS ${count} 格：一般切頁完整保留；背景超過一分鐘不重載；背景改址後重載回各自聊天室，列表不寫入設定`)
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
  // 同一頁換到對話、專案：跟切頁一樣算看不到，背景改址不記、切回帶回原聊天室
  await evaluate(`window.savedLog = []; window.setPane(false); document.querySelector('webview').executeJavaScript('location.hash = "other-room"; 1')`)
  await until(`document.querySelector('webview').getURL().endsWith('#other-room')`)
  assert.deepEqual(await evaluate('window.savedLog'), [], '換主區後背景改址不寫入設定')
  await evaluate('window.setPane(true)')
  await until(`document.querySelector('webview').getURL().endsWith('#room0')`)
  console.log('PASS 換主區切回：回到原本的聊天室')
  // 閒置收格：第一格留著連線；有草稿或翻舊訊息的留著；切回來全部回原本的聊天室
  await evaluate(`Promise.all([...document.querySelectorAll('webview')].map(v =>
    v.executeJavaScript('document.body.insertAdjacentHTML("beforeend", "<div id=editable-message-text></div><div class=MessageList style=height:50px;overflow:auto><div style=height:500px></div></div>"); document.querySelector(".MessageList").scrollTop = 450; 1')))`)
  const panes = `[...document.querySelectorAll('webview')]`
  await evaluate(`${panes}[2].executeJavaScript('document.getElementById("editable-message-text").textContent = "打到一半"; 1')`)
  await evaluate(`${panes}[3].executeJavaScript('document.querySelector(".MessageList").scrollTop = 0; 1')`)
  await pages.navigate({ page: 'settings' })
  await evaluate('window.watch()')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(await evaluate(`${panes}.map(v => v.getURL() === 'about:blank')`), [false, false, false, false], '沒滿 1 小時不收')
  await evaluate('window.clock += 3601000; window.watch()')
  await until(`${panes}[1].getURL() === 'about:blank'`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(await evaluate(`${panes}.map(v => v.getURL() === 'about:blank')`), [false, true, false, false], '只收第二格：第一格留著連線，草稿與翻舊訊息的不收')
  await pages.navigate({ page: 'chat' })
  await until(`${panes}.every((v,i) => v.getURL().endsWith('#room' + i))`)
  assert.deepEqual(await evaluate('window.saved'), ['#room0', '#room1', '#room2', '#room3'].map((hash) => `https://web.telegram.org/a/${hash}`))
  console.log('PASS 閒置只收乾淨的非第一格；切回來回到原本的聊天室')
  await evaluate(`Promise.all([...document.querySelectorAll('webview')].map(v =>
    v.executeJavaScript('document.body.insertAdjacentHTML("beforeend", "<div id=ConnectionStatusOverlay>等待網路連線</div>")')))`)
  await evaluate('window.loads = []; window.watch()')
  await evaluate('window.clock += 61000; window.watch()')
  assert.ok(await evaluate('window.loads.length > 0'), '前景持續斷線仍會復原')
  await until(`[...document.querySelectorAll('webview')].every((v,i) =>
    !v.isLoading() && v.getURL().endsWith('#room' + i))`)
  console.log('PASS 前景持續斷線仍重連原本四個聊天室')
  await evaluate(`${panes}[0].dataset.src = 'https://web.telegram.org/a/#cold'`)
  await pages.navigate({ page: 'settings' })
  await pages.navigate({ page: 'chat' })
  await new Promise((resolve) => setTimeout(resolve, 3000))
  assert.ok((await evaluate(`${panes}[0].getURL()`)).endsWith('#'), 'Web A 彈回列表')
  assert.equal(await evaluate(`${panes}[0].dataset.src`), 'https://web.telegram.org/a/#cold', '彈回列表不蓋掉記住的聊天室')
  await evaluate('window.loads = []')
  await pages.navigate({ page: 'settings' })
  await pages.navigate({ page: 'chat' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(await evaluate('window.loads.length'), 0, '彈回列表後切回不一直重載')
  console.log('PASS 載入後被彈回列表：記住的聊天室留著、切回不重載迴圈')
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
