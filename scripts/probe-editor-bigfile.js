/**
 * 原始碼＋vite 實測：獨立編輯視窗（Windows 關聯開檔那扇）開超大 JSON 順不順。
 *
 *   [A] 約 200MB／170 萬行（含中文）的 JSON 從叫開到 Monaco 掛好幾毫秒
 *   [B] 隨機跳 60 個位置，每次捲動到畫完一幀的耗時（中位數／最慢）
 *   [C] 檔中段打字，每個字到下一幀的耗時
 *   [D] Ctrl+S 存回去，檔案大小對得上
 *   [F] 超過 512K 字的 Markdown 預設開編輯（不記成偏好），切預覽只畫開頭並註明
 *   [E] 超過 256MB（約 330MB／300 萬行）改用唯讀分段檢視：建索引、捲動、跳行、搜尋到檔尾
 *
 * 視窗搬到螢幕外、showInactive，不搶焦點。全程暫存 user-data-dir，收尾只殺自己 spawn 的程序樹。
 *
 * 用法：node scripts/probe-editor-bigfile.js
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const PORT = 9263
const INSPECT = PORT + 1
const VITE_PORT = 5199
const USER_DATA = tempDir('editor-bigfile-')
const FILE = path.join(USER_DATA, 'huge.json')
const LINES = 1700000
const OVER = path.join(USER_DATA, 'over.json')
const OVER_LINES = 3000000
const MD = path.join(USER_DATA, 'long.md')
fs.writeFileSync(MD, Array.from({ length: 40000 }, (_, i) => `## 第 ${i} 節\n\n一段說明文字 **粗體** 與 \`code\`。\n`).join('\n'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false, uffsAuto: false, hfAutoStart: false }))
{
  const out = fs.openSync(FILE, 'w')
  fs.writeSync(out, '[\n')
  const batch = []
  for (let i = 0; i < LINES; i++) {
    batch.push(`  {"id": ${i}, "name": "item-${i}", "tags": ["alpha", "beta"], "note": "第 ${i} 筆中文測試資料"}${i < LINES - 1 ? ',' : ''}`)
    if (batch.length === 50000) { fs.writeSync(out, batch.join('\n') + '\n'); batch.length = 0 }
  }
  if (batch.length) fs.writeSync(out, batch.join('\n') + '\n')
  fs.writeSync(out, ']\n')
  fs.closeSync(out)
}
const SIZE = fs.statSync(FILE).size
{
  const out = fs.openSync(OVER, 'w')
  for (let i = 0; i < OVER_LINES; i += 50000) {
    fs.writeSync(out, Array.from({ length: 50000 }, (_, k) => `  {"id": ${i + k}, "name": "item-${i + k}", "tags": ["alpha", "beta"], "note": "第 ${i + k} 筆中文測試資料"},`).join('\n') + '\n')
  }
  fs.closeSync(out)
}
console.log(`fixture ${(SIZE / 1048576).toFixed(1)}MB, ${LINES + 2} 行`)

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve); this.ws.addEventListener('error', reject) })
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { this.ws?.close() }
}

async function waitFor(action, label, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await action().catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`等待逾時：${label}`)
}

async function target(port, match, title) {
  let found
  let seen = []
  await waitFor(async () => {
    const rows = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
    seen = rows.map((row) => `${row.type}:${row.title}`)
    found = match ? rows.find((row) => row.type === 'page' && match.test(row.url) && (!title || row.title.includes(title))) : rows[0]
    return found
  }, `CDP target ${match || ''} ${title || ''}`).catch((error) => { throw new Error(`${error.message}（看到：${seen.join('、')}）`) })
  const cdp = new Cdp(found.webSocketDebuggerUrl)
  await cdp.connect()
  return cdp
}

function killTree(child) {
  if (!child?.pid) return
  spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

const stats = (list) => {
  const sorted = [...list].sort((a, b) => a - b)
  return { median: Math.round(sorted[sorted.length >> 1]), max: Math.round(sorted[sorted.length - 1]) }
}

async function main() {
  // 5173 可能被別的專案佔著：自己開一顆 vite 在別的 port，再把編輯視窗的請求轉過來
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--strictPort', '--port', String(VITE_PORT)], { cwd: ROOT, windowsHide: true, stdio: 'ignore' })
  await waitFor(() => fetch(`http://localhost:${VITE_PORT}/`).then(() => true), 'vite 啟動')
  const child = spawn(require('electron'), [ROOT, '--hidden', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`],
    { detached: true, windowsHide: true, stdio: 'ignore' })
  let inspector, cdp
  try {
    inspector = await target(INSPECT)
    await waitFor(() => inspector.eval(`!!process.mainModule.require('electron').app.isReady()`), 'app ready')
    await sleep(1500)
    // 新視窗一律搬到螢幕外、不搶焦點
    await inspector.eval(`(() => { const { app } = process.mainModule.require('electron')
      app.on('browser-window-created', (_e, w) => { w.setPosition(-3000, -3000); w.show = () => w.showInactive(); w.focus = () => {}
        w.webContents.session.webRequest.onBeforeRequest({ urls: ['http://localhost:5173/*'] }, (d, cb) => cb({ redirectURL: d.url.replace(':5173', ':${VITE_PORT}') })) }); return true })()`)
    const started = Date.now()
    await inspector.eval(`process.mainModule.require(${JSON.stringify(path.join(ROOT, 'src/main/editor-window.js'))}).open(${JSON.stringify(FILE)}).then(() => true)`)
    cdp = await target(PORT, /pages\/editor\.html/)
    await waitFor(() => cdp.eval(`location.port === '${VITE_PORT}'`), '轉到自己的 vite')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(() => cdp.eval(`window.monaco?.editor.getEditors()[0]?.getModel()?.getLineCount() > ${LINES}`), 'Monaco 掛好')
    await cdp.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    const openMs = Date.now() - started
    const fatal = await cdp.eval(`document.getElementById('edFatal').hidden`)
    assert(fatal, '不該出現錯誤畫面')
    console.log(`[A] 開檔到畫好 ${openMs}ms`)

    const scroll = await cdp.eval(`(async () => {
      const ed = monaco.editor.getEditors()[0]; const times = []
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
      for (let i = 0; i < 60; i++) {
        const line = 1 + Math.floor(Math.random() * ${LINES}); const t = performance.now()
        ed.revealLineInCenter(line); await frame(); times.push(performance.now() - t)
      }
      for (let i = 0; i < 60; i++) { const t = performance.now(); ed.setScrollTop(ed.getScrollTop() + 400); await frame(); times.push(performance.now() - t) }
      return times })()`)
    const s = stats(scroll)
    console.log(`[B] 捲動每幀 中位數 ${s.median}ms、最慢 ${s.max}ms`)

    await cdp.eval(`(() => { const ed = monaco.editor.getEditors()[0]; ed.setPosition({ lineNumber: ${LINES >> 1}, column: 3 }); ed.revealLineInCenter(${LINES >> 1}); ed.focus(); return true })()`)
    const typing = []
    for (const ch of 'hello') {
      const t = Date.now()
      await cdp.send('Input.insertText', { text: ch })
      await cdp.eval(`new Promise((r) => requestAnimationFrame(() => r()))`)
      typing.push(Date.now() - t)
    }
    const ty = stats(typing)
    console.log(`[C] 打字每字 中位數 ${ty.median}ms、最慢 ${ty.max}ms`)

    const saveStart = Date.now()
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 })
    await waitFor(async () => fs.statSync(FILE).size === SIZE + 5, '存檔寫回', 60000)
    console.log(`[D] 存檔 ${Date.now() - saveStart}ms，大小 +5 bytes 正確`)
    const heap = await cdp.eval(`Math.round(performance.memory.usedJSHeapSize / 1048576)`)
    console.log(`renderer JS heap ${heap}MB`)

    await inspector.eval(`process.mainModule.require(${JSON.stringify(path.join(ROOT, 'src/main/editor-window.js'))}).open(${JSON.stringify(MD)}).then(() => true)`)
    const md = await target(PORT, /pages\/editor\.html/, 'long.md')
    await waitFor(() => md.eval(`window.monaco?.editor.getEditors()[0]?.getModel()?.getLineCount() > 100000`), 'Markdown 載好')
    const mdState = await md.eval(`(async () => {
      const mode = document.getElementById('edMain').dataset.mode
      const saved = localStorage.getItem('axondeck.editor.markdownMode')
      const t = performance.now()
      document.querySelector('#edModes [data-mode="preview"]').click()
      return { mode, saved, ms: Math.round(performance.now() - t), cut: !!document.querySelector('#edPreview .ed-preview-cut'), blocks: document.getElementById('edPreview').childElementCount }
    })()`)
    assert.equal(mdState.mode, 'edit')
    assert.notEqual(mdState.saved, 'edit')
    assert(mdState.cut, '預覽要註明只畫了開頭')
    console.log(`[F] 2MB Markdown 預設編輯；切預覽畫開頭 ${mdState.ms}ms（${mdState.blocks} 個區塊）`)
    md.close()

    const overStart = Date.now()
    await inspector.eval(`process.mainModule.require(${JSON.stringify(path.join(ROOT, 'src/main/editor-window.js'))}).open(${JSON.stringify(OVER)}).then(() => true)`)
    const over = await target(PORT, /pages\/editor\.html/, 'over.json')
    await waitFor(() => over.eval(`document.querySelectorAll('.bt-row:not([hidden]) .bt-tx').length > 10 && document.querySelector('.bt-row .bt-tx').textContent.length > 0`), '分段檢視畫好', 180000)
    const overInfo = await over.eval(`document.querySelector('.bt-info').textContent`)
    console.log(`[E] ${(fs.statSync(OVER).size / 1048576).toFixed(0)}MB 分段檢視開好 ${Date.now() - overStart}ms — ${overInfo}`)
    // 一律用同步事件量（視窗在螢幕外，rAF 不可靠）：送滾輪→等那一段資料回來畫上去
    const wheel = await over.eval(`(async () => {
      const body = document.querySelector('.bt-body'); const times = []
      const firstLine = () => document.querySelector('.bt-row:not([hidden]) .bt-ln').textContent
      for (let i = 0; i < 30; i += 1) {
        const before = firstLine(); const t = performance.now()
        body.dispatchEvent(new WheelEvent('wheel', { deltaY: 2000, bubbles: true, cancelable: true }))
        while (firstLine() === before || !document.querySelector('.bt-row:not([hidden]) .bt-tx').textContent) await new Promise((r) => setTimeout(r, 2))
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      return { median: Math.round(times[15]), max: Math.round(times[29]) }
    })()`)
    console.log(`[E] 滾輪每次到畫好 中位數 ${wheel.median}ms、最慢 ${wheel.max}ms`)
    const jump = await over.eval(`(async () => {
      const input = document.querySelector('.bt-input[type=number]'); input.value = '2999990'
      const t = performance.now()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      while (!document.querySelector('.bt-row.is-current .bt-ln') || document.querySelector('.bt-row.is-current .bt-tx').textContent === '') await new Promise((r) => setTimeout(r, 5))
      return { ms: Math.round(performance.now() - t), line: document.querySelector('.bt-row.is-current .bt-ln').textContent }
    })()`)
    assert.equal(jump.line, '2999990')
    console.log(`[E] 跳到第 2999990 行 ${jump.ms}ms`)
    const found = await over.eval(`(async () => {
      // 先回檔頭，搜尋才是從頭掃到尾
      document.querySelector('.bt-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true }))
      if (document.querySelector('.bt-row:not([hidden]) .bt-ln').textContent !== '1') throw new Error('Ctrl+Home 沒回到檔頭')
      const input = document.querySelector('.bt-find'); input.value = '"id": 2999998,'
      const t = performance.now()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      while (!document.querySelector('.bt-row.is-current .bt-hit')) await new Promise((r) => setTimeout(r, 5))
      return { ms: Math.round(performance.now() - t), line: document.querySelector('.bt-row.is-current .bt-ln').textContent }
    })()`)
    assert.equal(found.line, '2999999')
    console.log(`[E] 從檔頭附近搜尋到檔尾那一筆 ${found.ms}ms`)
    // 停在檔尾，外面再寫 10 行（像還在寫的 log）：要自己長出來、畫面跟到新的檔尾
    await over.eval(`document.querySelector('.bt-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true }))`)
    fs.appendFileSync(OVER, Array.from({ length: 10 }, (_, k) => `tail ${k + 1}`).join('\n') + '\n')
    const grewStart = Date.now()
    await waitFor(() => over.eval(`/3,000,010 行/.test(document.querySelector('.bt-info').textContent)
      && [...document.querySelectorAll('.bt-row:not([hidden]) .bt-tx')].some((n) => n.textContent === 'tail 10')`), '外面寫入後自己更新', 20000)
    assert.equal(await over.eval(`document.getElementById('edCursor').textContent`), '3,000,010 行')
    console.log(`[E] 外面寫入 10 行，${Date.now() - grewStart}ms 後自己更新並跟到檔尾`)
    if (process.env.AXONDECK_SHOT) {
      const shot = await over.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(process.env.AXONDECK_SHOT, Buffer.from(shot.data, 'base64'))
    }
    over.close()

    const wide = path.join(USER_DATA, 'wide.log')
    {
      const out = fs.openSync(wide, 'w')
      fs.writeSync(out, Buffer.from([0xfe, 0xff]))
      for (let i = 0; i < 2600000; i += 100000) {
        fs.writeSync(out, Buffer.from(Array.from({ length: 100000 }, (_, k) => `Wide ${i + k} 寬字元測試資料 ${'x'.repeat(40)}`).join('\n') + '\n', 'utf16le').swap16())
      }
      fs.closeSync(out)
    }
    await inspector.eval(`process.mainModule.require(${JSON.stringify(path.join(ROOT, 'src/main/editor-window.js'))}).open(${JSON.stringify(wide)}).then(() => true)`)
    const w = await target(PORT, /pages\/editor\.html/, 'wide.log')
    await waitFor(() => w.eval(`document.querySelector('.bt-row .bt-tx')?.textContent?.startsWith('Wide 0 寬字元測試資料')`), 'UTF-16 BE 分段檢視', 180000)
    assert.equal(await w.eval(`document.getElementById('edEncoding').textContent`), 'UTF-16 BE')
    console.log(`[E2] ${(fs.statSync(wide).size / 1048576).toFixed(0)}MB UTF-16 BE 用分段檢視打開、中文正常、編碼標成 UTF-16 BE`)
    w.close()
  } catch (error) {
    if (cdp) console.error('頁面狀態', await cdp.eval(`JSON.stringify({ url: location.href, fatal: document.getElementById('edFatal')?.textContent, monaco: !!window.monaco, editors: window.monaco?.editor.getEditors().length, lines: window.monaco?.editor.getEditors()[0]?.getModel()?.getLineCount() })`).catch((e) => e.message))
    throw error
  } finally {
    cdp?.close()
    inspector?.close()
    killTree(child)
    killTree(vite)
  }
}

main().catch((error) => { console.error('FAIL', error.message); process.exitCode = 1 })
