'use strict'
/**
 * 量切頁順暢度：點導覽 → 目標頁畫出第一個畫面要多久、之後 2 秒內 renderer／main 有多少長任務。
 * 用 dev-sandbox 的資料（%APPDATA%/axondeck-dev，先跑 `node scripts/dev-sandbox.js --no-launch --with-chats`），
 * 視窗移到螢幕外再 showInactive，不擋使用者。
 *   node scripts/probe-page-switch.js            # dist/win-unpacked
 *   AXONDECK_EXE=<exe> node scripts/probe-page-switch.js
 */
const path = require('node:path')
const { spawn } = require('node:child_process')
const { NAV_PAGES } = require('./lib/nav-pages')

const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
const USER_DATA = path.join(process.env.APPDATA, 'axondeck-dev')
const PORT = 9281, MAIN_PORT = 9282
const ROUNDS = Number(process.env.ROUNDS || 3)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class Cdp {
  constructor(url, awaitPromise = true) { this.url = url; this.awaitPromise = awaitPromise; this.seq = 0; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      pending(message)
    }
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise(resolve => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const id = ++this.seq
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout')) }, 60000)
      this.pending.set(id, value => { clearTimeout(timer); resolve(value) })
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: this.awaitPromise, returnByValue: true } }))
    })
    const response = message.result || {}
    if (message.error || response.exceptionDetails) throw new Error(message.error?.message || response.exceptionDetails.exception?.description)
    return response.result?.value
  }
  close() { this.ws?.close() }
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
}

// main 的 inspector 對非 Promise 也開 awaitPromise 會回「Promise was collected」
async function connectWhen(port, matches, ms = 60000, awaitPromise = true) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const target = (await targets(port)).find(matches)
      if (target) { const client = new Cdp(target.webSocketDebuggerUrl, awaitPromise); await client.connect(); return client }
    } catch { /* 啟動中 */ }
    await sleep(200)
  }
  throw new Error(`No CDP target on ${port}`)
}

const RECORDER = `(() => {
  if (window.__sw) return 'ok'
  const sw = window.__sw = { shown: 0, paint: 0, tasks: [] }
  new PerformanceObserver(list => { for (const e of list.getEntries()) sw.tasks.push([performance.timeOrigin + e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: false })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    sw.shown = Date.now(); sw.paint = 0
    requestAnimationFrame(() => requestAnimationFrame(() => { sw.paint = Date.now() }))
  })
  return 'ok'
})()`

const MAIN_LAG = `(() => { globalThis.__swLag = []; let last = Date.now(); clearInterval(globalThis.__swT)
  globalThis.__swT = setInterval(() => { const n = Date.now(), d = n - last - 16; if (d > 50) globalThis.__swLag.push([n, d]); last = n }, 16); return 'ok' })()`

async function pageClient(page) {
  const target = (await targets(PORT)).find(item => { try { return new URL(item.url).searchParams.get('page') === page } catch { return false } })
  if (!target) return null
  const client = new Cdp(target.webSocketDebuggerUrl); await client.connect()
  await client.eval(RECORDER)
  return client
}

async function main() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key]
  const child = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`, `--inspect=127.0.0.1:${MAIN_PORT}`, '--hidden', '--disable-backgrounding-occluded-windows'], { env, stdio: 'ignore' })
  const clients = new Map()
  let mainCdp, host
  try {
    mainCdp = await connectWhen(MAIN_PORT, () => true, 60000, false)
    // 要真的畫才量得到 paint：移到螢幕外再 showInactive
    for (let i = 0; i < 100; i++) {
      const ok = await mainCdp.eval(`(() => { const w = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]; if (!w) return false; w.setBounds({ x: -3000, y: -3000, width: 1400, height: 900 }); w.showInactive(); return true })()`)
      if (ok) break
      await sleep(200)
    }
    host = await connectWhen(PORT, item => /[?&]host=1/.test(item.url))
    await host.eval(`new Promise(r => { const t = setInterval(() => { if (document.querySelector('.nav-tab[data-page]') && document.body.dataset.mainPage) { clearInterval(t); r() } }, 100) })`)
    await sleep(Number(process.env.PREWAIT || 3000))
    await mainCdp.eval(MAIN_LAG)
    if (process.env.PROFILE) {
      await mainCdp.send('Profiler.enable'); await mainCdp.send('Profiler.setSamplingInterval', { interval: 500 }); await mainCdp.send('Profiler.start')
    }
    const rows = []
    for (let round = 0; round < ROUNDS; round++) {
      for (const page of NAV_PAGES) {
        const t0 = await host.eval(`(() => { const t = Date.now(); document.querySelector('.nav-tab[data-page="${page}"]').click(); return t })()`)
        // 等目標頁出現、變可見並畫完兩個 frame
        let client = clients.get(page), paint = 0
        const deadline = Date.now() + 30000
        while (!client && Date.now() < deadline) {
          client = await pageClient(page)
          if (client) clients.set(page, client)
          else await sleep(20)
        }
        if (client) {
          paint = await client.eval(`new Promise(r => { const check = () => document.visibilityState === 'visible' && document.body.dataset.pageVisible !== 'false'
            ? requestAnimationFrame(() => requestAnimationFrame(() => r(Date.now()))) : setTimeout(check, 5); check() })`).catch(() => 0)
        }
        const result = paint ? { paint } : null
        await sleep(2000)
        const tasks = client ? await client.eval(`window.__sw.tasks.filter(t => t[0] >= ${t0}).map(t => Math.round(t[1]))`) : []
        const lag = await mainCdp.eval(`globalThis.__swLag.filter(t => t[0] >= ${t0}).map(t => t[1])`)
        rows.push({ round, page, paintMs: result ? result.paint - t0 : -1, longTasks: tasks.length, worstTask: Math.max(0, ...tasks), sumTasks: tasks.reduce((a, b) => a + b, 0), mainWorst: Math.max(0, ...lag) })
        console.log(JSON.stringify(rows.at(-1)))
      }
    }
    if (process.env.PROFILE) require('node:fs').writeFileSync(process.env.PROFILE, JSON.stringify((await mainCdp.send('Profiler.stop')).result.profile))
    const mem = await mainCdp.eval(`Math.round(process.mainModule.require('electron').app.getAppMetrics().reduce((a, m) => a + m.memory.workingSetSize, 0) / 1024)`)
    console.log(`MEMORY total working set ${mem} MB`)
    const cold = rows.filter(row => row.round === 0)
    console.log(`SUMMARY cold: paint avg ${Math.round(cold.reduce((a, r) => a + r.paintMs, 0) / cold.length)}ms max ${Math.max(...cold.map(r => r.paintMs))}ms`)
    const warm = rows.filter(row => row.round > 0)
    const avg = key => Math.round(warm.reduce((a, row) => a + row[key], 0) / warm.length)
    console.log(`SUMMARY warm: paint avg ${avg('paintMs')}ms max ${Math.max(...warm.map(r => r.paintMs))}ms; renderer long task sum avg ${avg('sumTasks')}ms; main worst ${Math.max(...warm.map(r => r.mainWorst))}ms`)
  } finally {
    for (const client of clients.values()) client.close()
    host?.close()
    try { await mainCdp?.eval(`process.mainModule.require('electron').app.exit(0)`) } catch { /* 已關 */ }
    mainCdp?.close()
    await sleep(1500)
    if (child.exitCode === null) child.kill()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
