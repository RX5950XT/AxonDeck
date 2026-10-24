/**
 * 打包版 CDP 驗證：專案工作區的 HTML 預覽與腳本開檔。
 *
 *  [H1] HTML 預覽跑得動行內／模組腳本、載得到相對路徑的 CSS 與圖片、localStorage 可用
 *  [H2] 預覽頁讀不到點開頭的檔案（.env）
 *  [H3] 沒存的修改也照樣預覽
 *  [S1] 檔案樹點 .bat 先開編輯器（不直接跑），右上角有「執行」
 *  [S2] 按「執行」才開終端機跑
 *
 * 預覽頁在另一個來源（vi-media），主頁讀不到它的 DOM：由測試頁自己 postMessage 回報。
 * 暫存 user-data-dir ＋ 暫存專案資料夾，收尾只 taskkill 自己 spawn 的那個 pid。
 *
 * 用法：node scripts/e2e-workspace-html-cdp.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { tempDir, removeTree } = require('./lib/test-temp')

const PORT = 9284
const INSPECT_PORT = 9285
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')
const USER_DATA_DIR = tempDir('axondeck-e2e-html-')
const PROJECT_DIR = tempDir('axondeck-proj-html-')
const PROJECT_ID = 'w_e2e_html'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const waiter = msg.id && this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 逾時：${method}`)) }, 30000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}
require('./lib/page-cdp').followMainPage(Cdp)

/** 主程序的 inspector：視窗要先顯示出來才收得到合成的滑鼠事件 */
async function mainProcess() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const [target] = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json()
      if (target) {
        const main = new Cdp(target.webSocketDebuggerUrl)
        await main.connect()
        return main
      }
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('main inspector 未啟動')
}

async function waitTargets(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

async function waitInPage(cdp, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(300)
  }
  return false
}

function seed() {
  const site = path.join(PROJECT_DIR, 'site')
  fs.mkdirSync(site)
  // 1x1 PNG
  fs.writeFileSync(path.join(PROJECT_DIR, 'pic.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
  fs.writeFileSync(path.join(PROJECT_DIR, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(site, 'style.css'), 'body { color: rgb(1, 2, 3) }\n')
  fs.writeFileSync(path.join(site, 'mod.js'), `window.addEventListener('load', async () => {
  localStorage.setItem('k', 'v')
  const env = (await fetch('/.env').catch(() => ({ status: 0 }))).status
  parent.postMessage({ e2e: true, inline: window.inlineRan === true, color: getComputedStyle(document.body).color,
    img: document.getElementById('i').naturalWidth, ls: localStorage.getItem('k'), env, title: document.title,
    dpr: devicePixelRatio, quirks: document.compatMode }, '*')
})
// 外層縮放有沒有真的套到頁面裡：縮放後 devicePixelRatio 會跟著變
window.addEventListener('resize', () => parent.postMessage({ e2eResize: devicePixelRatio }, '*'))
`)
  fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html><html><head><title>saved</title>
<link rel="stylesheet" href="style.css"><script type="module" src="./mod.js"></script></head>
<body><img id="i" src="/pic.png"><script>window.inlineRan = true</script></body></html>
`)
  fs.writeFileSync(path.join(PROJECT_DIR, 'run.bat'), '@echo off\r\necho e2e-run-ok\r\n')
  fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
  fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
    projects: [{ id: PROJECT_ID, name: 'e2e html', path: PROJECT_DIR, createdAt: Date.now() }]
  }))
}

const clickTreeRow = (name) => `[...document.querySelectorAll('#wsTree .ws-tree-row')]
  .find((r) => r.querySelector('.ws-tree-name')?.textContent === ${JSON.stringify(name)}).click()`

/** 收下一則預覽頁回報（先掛好再觸發） */
const LISTEN = `window.__e2eMsg = null; window.addEventListener('message', (e) => { if (e.data?.e2e) window.__e2eMsg = e.data })`

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push(Boolean(pass))
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  seed()
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${PORT}`, `--inspect=127.0.0.1:${INSPECT_PORT}`, `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-backgrounding-occluded-windows'], { stdio: 'ignore' })
  let cdp = null
  let main = null
  try {
    const pages = await waitTargets()
    cdp = new Cdp((pages.find((p) => /index\.html/i.test(p.url)) || pages[0]).webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1500)
    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    await waitInPage(cdp, `document.getElementById('page-chat').classList.contains('active')`)
    await cdp.eval(`document.querySelector('.sidebar-mode[data-mode="projects"]').click()`)
    if (!await waitInPage(cdp, `document.querySelector('#projList [data-id="${PROJECT_ID}"]')`)) throw new Error('專案沒出現')
    await cdp.eval(`document.querySelector('#projList [data-id="${PROJECT_ID}"] .chat-list-open').click()`)
    await waitInPage(cdp, `[...document.querySelectorAll('#wsTree .ws-tree-name')].some((n) => n.textContent === 'site')`)

    // ===== [H] HTML 預覽 =====
    await cdp.eval(clickTreeRow('site'))
    await waitInPage(cdp, `[...document.querySelectorAll('#wsTree .ws-tree-name')].some((n) => n.textContent === 'index.html')`)
    await cdp.eval(LISTEN)
    await cdp.eval(clickTreeRow('index.html'))
    ok('[H1] 預覽是 vi-media 網址的 iframe',
      await waitInPage(cdp, `document.querySelector('#wsEditorPreview iframe.ws-editor-frame')?.src.startsWith('vi-media://')`))
    ok('[H1] 預覽頁回報了', await waitInPage(cdp, 'window.__e2eMsg'))
    const report = await cdp.eval('window.__e2eMsg') || {}
    ok('[H1] 行內腳本有跑', report.inline === true, JSON.stringify(report))
    ok('[H1] 相對路徑的 CSS 有套上', report.color === 'rgb(1, 2, 3)')
    ok('[H1] 根路徑圖片載得到', report.img === 1)
    ok('[H1] localStorage 可用', report.ls === 'v')
    ok('[H2] 讀不到 .env', report.env === 404, String(report.env))
    ok('[H1] 磁碟版標題', report.title === 'saved')
    ok('[H1] 塞了縮放腳本仍是標準模式', report.quirks === 'CSS1Compat', report.quirks)

    // --hidden 的視窗不收合成滑鼠事件（dispatchMouseEvent 會卡到逾時）：移到螢幕外再不搶焦點地顯示，不擋使用者
    main = await mainProcess()
    await main.eval(`(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows()
      .find((w) => /index\.html/.test(w.webContents.getURL())); win.setPosition(-3000, -3000); win.showInactive() })()`)
    await sleep(500)
    // [H4] 在預覽頁上 Ctrl+滾輪：外層倍率變了、頁面內容也跟著放大，App 視窗本身沒被縮放
    await cdp.eval(`window.__e2eDpr = null; window.addEventListener('message', (e) => {
      if (typeof e.data?.e2eResize === 'number') window.__e2eDpr = e.data.e2eResize })`)
    const center = await cdp.eval(`(() => { const r = document.querySelector('#wsEditorPreview iframe').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: -100, modifiers: 2 })
    ok('[H4] Ctrl+滾輪放大預覽', await waitInPage(cdp, `Number(document.getElementById('wsEditorPreview').style.zoom) > 1`, 5000),
      await cdp.eval(`document.getElementById('wsEditorPreview').style.zoom`))
    ok('[H4] 頁面內容跟著放大', await waitInPage(cdp, `window.__e2eDpr > ${report.dpr}`, 5000),
      `${report.dpr} → ${await cdp.eval('window.__e2eDpr')}`)
    ok('[H4] App 視窗沒被縮放', (await cdp.eval('devicePixelRatio')) === report.dpr)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: 100, modifiers: 2 })
    ok('[H4] 往下滾縮回 100%', await waitInPage(cdp, `!document.getElementById('wsEditorPreview').style.zoom`, 5000))

    // 切到編輯、改標題不存，再切回預覽
    await cdp.eval(`document.getElementById('wsEditorPreviewBtn').click()`)
    await waitInPage(cdp, `document.getElementById('wsIdeContainer').offsetHeight > 0`)
    await cdp.eval(`(() => {
      const t = document.getElementById('wsEditorText')
      t.value = t.value.replace('<title>saved</title>', '<title>draft</title>')
      t.dispatchEvent(new Event('input'))
    })()`)
    await cdp.eval(LISTEN)
    await cdp.eval(`document.getElementById('wsEditorPreviewBtn').click()`)
    await waitInPage(cdp, 'window.__e2eMsg')
    ok('[H3] 沒存的修改也照樣預覽', (await cdp.eval('window.__e2eMsg?.title')) === 'draft')
    ok('[H3] 磁碟沒被改', fs.readFileSync(path.join(PROJECT_DIR, 'site', 'index.html'), 'utf8').includes('<title>saved</title>'))

    // ===== [S] 腳本 =====
    const termCount = `[...document.querySelectorAll('#wsTabStrip .ws-tab')].filter((t) => t.textContent.includes('run.bat') && t.textContent.includes('執行')).length`
    await cdp.eval(clickTreeRow('run.bat'))
    ok('[S1] 點 .bat 開編輯器', await waitInPage(cdp, `document.getElementById('wsEditorText').value.includes('e2e-run-ok')
      && document.getElementById('wsEditorName').textContent === 'run.bat'`))
    ok('[S1] 右上角有「執行」', await cdp.eval(`document.getElementById('wsEditorRunBtn').offsetHeight > 0`))
    await sleep(800)
    ok('[S1] 沒有直接跑', (await cdp.eval(termCount)) === 0)
    await cdp.eval(`document.getElementById('wsEditorRunBtn').click()`)
    ok('[S2] 按「執行」開了終端機', await waitInPage(cdp, `${termCount} === 1`))

    await cdp.eval(clickTreeRow('pic.png'))
    ok('[S1] 圖片分頁不顯示「執行」', await waitInPage(cdp, `document.getElementById('wsEditorRunBtn').offsetHeight === 0`))
  } finally {
    cdp?.close()
    main?.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    for (const dir of [USER_DATA_DIR, PROJECT_DIR]) {
      for (let i = 0; i < 5; i++) {
        try { removeTree(dir); break } catch { await sleep(600) }
      }
    }
  }
  const failed = results.filter((pass) => !pass).length
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
