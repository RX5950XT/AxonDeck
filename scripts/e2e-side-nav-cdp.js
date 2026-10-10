/**
 * 打包版 CDP：滑鼠側鍵（上一頁／下一頁）
 * 主視窗 DOM 上按 → App 換頁；webview 裡按 → 網頁自己退，退到底再換 App 頁。
 * 用法：npm run electron:pack 後 node scripts/e2e-side-nav-cdp.js
 */
const { spawn } = require('child_process')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const http = require('http')

const PORT = 9237
// 暫存 user-data-dir：使用者正在用（常駐）的 App 佔著 single-instance lock，
// 沒有自己的資料夾會被它擋掉（second-instance 轉交後退出，CDP 連不上）
const USER_DATA_DIR = tempDir('axondeck-sidenav-')
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 AXONDECK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function stopChildTree(child) {
  if (!child?.pid) return
  try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 0
    this.pending = new Map()
  }
  async connect() {
    const WebSocket = globalThis.WebSocket
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res)
      this.ws.addEventListener('error', rej)
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      // description 才有真正的錯誤與堆疊；text 多半只是 'Uncaught'
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch {}
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}


async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore' })
  let failed = 0
  const ok = (name, pass, detail = '') => {
    if (!pass) failed += 1
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  // CDP 的 back／forward 鍵走的是真的滑鼠事件管線（main 的 before-mouse-event 也收得到）
  const side = async (cdp, button, x = 400, y = 300) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 })
    }
    await sleep(800)
  }
  const page = (cdp) => cdp.eval(`document.querySelector('.nav-tab.active')?.dataset.page`)
  const go = (cdp, name) => cdp.eval(`document.querySelector('.nav-tab[data-page="${name}"]').click()`).then(() => sleep(600))

  try {
    await sleep(2500)
    const mainPage = (await waitTargets()).find((p) => /index\.html/i.test(p.url))
    const cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1500)

    // 1) 主視窗 DOM：settings → sysmon → 側鍵退回 settings、再退回 chat、再前進
    await go(cdp, 'settings')
    await go(cdp, 'sysmon')
    // 點在 header 上（各頁都有、不是 webview）
    await side(cdp, 'back', 600, 20)
    ok('back → settings', (await page(cdp)) === 'settings', await page(cdp))
    await side(cdp, 'back', 600, 20)
    ok('back → chat', (await page(cdp)) === 'chat', await page(cdp))
    await side(cdp, 'forward', 600, 20)
    ok('forward → settings', (await page(cdp)) === 'settings', await page(cdp))

    // 2) AI 頁兩則對話之間來回
    await cdp.eval(`window.electronAPI.chat.create('')`)
    await go(cdp, 'chat')
    await sleep(800)
    const ids = await cdp.eval(`[...document.querySelectorAll('.chat-list-item')].map((el) => el.dataset.id)`)
    ok('兩則對話', ids.length >= 2, String(ids.length))
    const activeId = () => cdp.eval(`document.querySelector('.chat-list-item.active')?.dataset.id`)
    for (const id of ids.slice(0, 2)) {
      await cdp.eval(`document.querySelector('.chat-list-item[data-id="${id}"] .chat-list-open').click()`)
      await sleep(600)
    }
    await side(cdp, 'back', 600, 20)
    ok('對話 back → 上一則', (await activeId()) === ids[0], `${await activeId()} vs ${ids[0]}`)
    await side(cdp, 'forward', 600, 20)
    ok('對話 forward → 下一則', (await activeId()) === ids[1], `${await activeId()} vs ${ids[1]}`)

    // 3) webview：Telegram 那格先走一步，側鍵先讓網頁自己退，退到底才換 App 頁
    await go(cdp, 'telegram')
    let guestTarget
    for (let i = 0; i < 40 && !guestTarget; i++) {
      guestTarget = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'webview')
      if (!guestTarget) await sleep(500)
    }
    ok('telegram webview target', !!guestTarget, guestTarget?.url)
    const guest = new Cdp(guestTarget.webSocketDebuggerUrl)
    await guest.connect()
    await guest.send('Runtime.enable')
    await sleep(3000)
    const firstUrl = await guest.eval('location.href')
    await guest.eval(`history.pushState({}, '', '#side-nav-test')`)
    await sleep(300)
    await side(guest, 'back', 200, 200)
    const backUrl = await guest.eval('location.href')
    ok('webview back → 網頁自己退', backUrl === firstUrl && (await page(cdp)) === 'telegram', `${backUrl} / ${await page(cdp)}`)
    await side(guest, 'back', 200, 200)
    ok('webview 退到底 → App 換回 chat', (await page(cdp)) === 'chat' && (await activeId()) === ids[1], `${await page(cdp)} ${await activeId()}`)
    guest.close()
    cdp.close()
  } catch (err) {
    failed += 1
    console.log('FAIL  exception —', err.message)
  } finally {
    stopChildTree(child)
    await sleep(1500)
    removeTree(USER_DATA_DIR)
  }
  process.exit(failed ? 1 : 0)
}

main()
