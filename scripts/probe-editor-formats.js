/**
 * 原始碼＋vite 實測：獨立編輯視窗的各種格式預覽與主流編輯器功能（真 Electron、真 Monaco、真 vi-media）。
 *
 *   [A] `.gitignore` 這種點開頭的檔名照關聯打得開
 *   [B] Markdown 分割模式：編輯器捲到某個標題，預覽跟到同一個標題
 *   [C] CSV：預設表格預覽、引號裡的逗號不拆欄、分隔符號判斷
 *   [D] HTML（從「開啟方式」指名）：即時預覽載得到旁邊的 CSS、腳本讀不到旁邊的檔案、改字後預覽跟著變
 *   [E] Mermaid（.mmd）畫成圖
 *   [F] Big5 唯讀 → 「轉成 UTF-8 並儲存」後磁碟是 UTF-8、可以編輯；GBK 檔用狀態列「以其他編碼重新開啟」
 *   [G] 狀態列：CRLF 切換後存檔、縮排改 Tab、語言模式搜尋切換、跳行
 *   [H] 比較未儲存的變更（diff）開關不弄壞原本的 model
 *   [I] 另存新檔：視窗改成新檔案、語言與預覽跟著新副檔名
 *
 * 視窗搬到螢幕外、showInactive，不搶焦點；關遮蔽偵測（否則沒 rAF）。全程暫存 user-data-dir，收尾只殺自己 spawn 的程序樹。
 * 帶 AXONDECK_SHOT_DIR=<資料夾> 會存深淺兩色截圖。
 *
 * 用法：node scripts/probe-editor-formats.js
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const PORT = 9271
const INSPECT = PORT + 1
const VITE_PORT = 5207
const USER_DATA = tempDir('editor-formats-')
const DOCS = path.join(USER_DATA, 'docs')
const EDITOR_JS = JSON.stringify(path.join(ROOT, 'src/main/editor-window.js'))
const SHOT_DIR = process.env.AXONDECK_SHOT_DIR || ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const file = (name) => path.join(DOCS, name)

fs.mkdirSync(DOCS, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false, uffsAuto: false, hfAutoStart: false }))
fs.writeFileSync(file('.gitignore'), 'node_modules/\ndist/\n')
fs.writeFileSync(file('guide.md'), Array.from({ length: 30 }, (_, i) => `## 第 ${i} 節\n\n${'一段說明文字。'.repeat(30)}\n\n${'- 項目\n'.repeat(8)}`).join('\n'))
fs.writeFileSync(file('people.csv'), 'name,city,score\n"Lin, Mei",Taipei,98.5\nChen,"Kao\nhsiung",77\nWang,Tainan,"1,234"\n')
fs.writeFileSync(file('style.css'), 'body { color: rgb(1, 2, 3) }')
fs.writeFileSync(file('secret.json'), '{"token":"do-not-leak"}')
// 1×1 紅點 PNG：頁面畫得出來，但腳本用 canvas 讀不到像素
fs.writeFileSync(file('dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'))
fs.writeFileSync(file('page.html'), `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p id="m">MARK-1</p>
<img id="dot" src="dot.png">
<script>
async function pixels(cors) {
  try {
    const img = new Image(); if (cors) img.crossOrigin = 'anonymous'; img.src = 'dot.png'; await img.decode()
    const c = document.createElement('canvas'); c.width = 1; c.height = 1; c.getContext('2d').drawImage(img, 0, 0)
    return c.getContext('2d').getImageData(0, 0, 1, 1).data.join(',')
  } catch { return 'blocked' }
}
function xhr() { try { const x = new XMLHttpRequest(); x.open('GET', 'secret.json', false); x.send(); return x.responseText } catch { return 'blocked' } }
addEventListener('load', async () => {
  let leak = 'blocked'
  try { leak = await (await fetch('secret.json')).text() } catch {}
  parent.postMessage({ probe: true, color: getComputedStyle(document.body).color, mark: document.getElementById('m').textContent, leak,
    xhr: xhr(), img: document.getElementById('dot').naturalWidth, pixels: await pixels(false), corsPixels: await pixels(true) }, '*')
})</script></body></html>`)
fs.writeFileSync(file('flow.mmd'), 'graph TD\n  A[開始] --> B{判斷}\n  B --> C[結束]\n')
fs.writeFileSync(file('old.txt'), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x0d, 0x0a])) // Big5「中文」
fs.writeFileSync(file('gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) // GBK「中文」（會被自動判成 Big5 亂碼）
fs.writeFileSync(file('script.txt'), 'def main():\n    return 1\n')

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

async function waitFor(action, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await action().catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`等待逾時：${label}`)
}

async function target(port, match, title) {
  let found
  await waitFor(async () => {
    const rows = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
    found = match ? rows.find((row) => row.type === 'page' && match.test(row.url) && (!title || row.title.includes(title))) : rows[0]
    return found
  }, `CDP target ${match || ''} ${title || ''}`)
  const cdp = new Cdp(found.webSocketDebuggerUrl)
  await cdp.connect()
  if (match) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return cdp
}

function killTree(child) {
  if (!child?.pid) return
  spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

/** 開檔並等 Monaco 掛好；回傳那扇窗的 CDP */
async function openEditor(inspector, name, opts = {}) {
  await inspector.eval(`process.mainModule.require(${EDITOR_JS}).open(${JSON.stringify(file(name))}, ${JSON.stringify(opts)}).then(String)`)
  const page = await target(PORT, /pages\/editor\.html/, name)
  await waitFor(() => page.eval(`!!window.monaco?.editor.getEditors()[0]?.getModel() && !!document.getElementById('edLang').textContent`), `${name} Monaco 掛好`)
  return page
}

const ED = 'monaco.editor.getEditors().find((e) => !e.getContainerDomNode().closest(".ed-diff"))'
const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`
/** 點選單裡某個字的那一項（子選單要先滑過父項） */
const menuPick = (parent, label) => `(() => {
  const items = () => [...document.querySelectorAll('.ws-menu-item')]
  ${parent ? `items().find((b) => b.textContent.includes(${JSON.stringify(parent)})).dispatchEvent(new PointerEvent('pointerenter'))` : ''}
  const hit = items().find((b) => b.querySelector('.ws-menu-label').textContent === ${JSON.stringify(label)})
  if (!hit) throw new Error('選單沒有 ' + ${JSON.stringify(label)} + '：' + items().map((b) => b.textContent).join('|'))
  hit.click(); return true })()`

async function shot(page, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  for (const theme of ['dark', 'light']) {
    await page.eval(`document.documentElement.dataset.theme = '${theme}'`)
    await sleep(400)
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOT_DIR, `${name}-${theme}.png`), Buffer.from(data, 'base64'))
  }
  await page.eval(`document.documentElement.dataset.theme = 'dark'`)
}

async function checkMarkdownSync(inspector) {
  const md = await openEditor(inspector, 'guide.md')
  await md.eval(click('#edModes [data-mode="split"]'))
  await waitFor(() => md.eval(`document.querySelectorAll('#edPreview h2.md-h').length === 30`), 'Markdown 預覽畫好')
  const sync = await md.eval(`(async () => {
    const ed = ${ED}; const line = ed.getModel().findMatches('## 第 20 節', false, false, true, null, false)[0].range.startLineNumber
    ed.setScrollTop(ed.getTopForLineNumber(line))
    await new Promise((r) => setTimeout(r, 300))
    const box = document.getElementById('edPreview'); const h = [...box.querySelectorAll('h2.md-h')][20]
    return Math.abs(Math.round(h.getBoundingClientRect().top - box.getBoundingClientRect().top)) })()`)
  assert(sync < 40, `預覽要捲到第 20 節（差 ${sync}px）`)
  console.log(`[B] Markdown 分割：編輯器捲到第 20 節，預覽那個標題離頂端 ${sync}px`)
  await shot(md, 'markdown-split')
  md.close()
}

async function checkCsv(inspector) {
  const csv = await openEditor(inspector, 'people.csv', { openWith: true })
  await waitFor(() => csv.eval(`!!document.querySelector('.ed-csv-table')`), 'CSV 表格')
  const table = await csv.eval(`({ mode: document.getElementById('edMain').dataset.mode, info: document.querySelector('.ed-csv-info').textContent,
    rows: [...document.querySelectorAll('.ed-csv-table tbody tr')].map((tr) => [...tr.children].slice(1).map((td) => td.textContent)) })`)
  assert.equal(table.mode, 'preview')
  assert.deepEqual(table.rows[0], ['Lin, Mei', 'Taipei', '98.5'])
  assert.deepEqual(table.rows[1], ['Chen', 'Kao\nhsiung', '77'])
  console.log(`[C] CSV 預設表格：${table.info}；引號內逗號與換行都在同一格`)
  await shot(csv, 'csv')
  csv.close()
}

async function checkHtml(inspector) {
  const html = await openEditor(inspector, 'page.html', { openWith: true })
  // 先等 iframe 出現、掛好收訊息，再重載一次：第一次載入可能在掛上之前就回報完了
  await waitFor(() => html.eval(`!!document.querySelector('iframe.ed-html')?.src`), 'HTML 預覽 iframe')
  await html.eval(`window.__probe = []; addEventListener('message', (e) => { if (e.data?.probe) window.__probe.push(e.data) })
    const f = document.querySelector('iframe.ed-html'); f.src = f.src; true`)
  await waitFor(() => html.eval(`window.__probe.length > 0`), 'HTML 預覽回報', 20000)
  const first = await html.eval(`({ mode: document.getElementById('edMain').dataset.mode, msg: window.__probe[0], src: document.querySelector('iframe.ed-html').src })`)
  assert.equal(first.mode, 'split')
  assert.equal(first.msg.color, 'rgb(1, 2, 3)', '要載得到旁邊的 style.css')
  assert.equal(first.msg.img, 1, '圖片要畫得出來')
  for (const key of ['leak', 'xhr', 'pixels', 'corsPixels']) assert.equal(first.msg[key], 'blocked', `腳本不可讀到旁邊的檔案（${key}：${first.msg[key]}）`)
  assert.match(first.src, /^vi-preview:\/\//)
  await html.eval(`(() => { const ed = ${ED}; const m = ed.getModel(); const r = m.findMatches('MARK-1', false, false, true, null, false)[0].range
    m.pushEditOperations([], [{ range: r, text: 'MARK-2' }], () => null); return true })()`)
  await waitFor(() => html.eval(`window.__probe.some((m) => m.mark === 'MARK-2')`), 'HTML 改字後預覽跟著變', 10000)
  console.log(`[D] HTML 即時預覽：分割模式、載到同資料夾 CSS 與圖片；fetch／XHR／canvas 都讀不到旁邊的檔案；未存的修改即時出現`)
  html.close()
}

async function checkMermaid(inspector) {
  const mmd = await openEditor(inspector, 'flow.mmd')
  await waitFor(() => mmd.eval(`!!document.querySelector('#edPreview img.md-mermaid, #edPreview svg')`), 'Mermaid 畫成圖', 30000)
  console.log('[E] Mermaid .mmd 分割模式畫成圖')
  mmd.close()
}

async function checkEncodings(inspector) {
  const big5 = await openEditor(inspector, 'old.txt')
  const before = await big5.eval(`({ ro: ${ED}.getOption(monaco.editor.EditorOption.readOnly), enc: document.getElementById('edEncoding').textContent, notice: !document.getElementById('edNotice').hidden })`)
  assert.deepEqual(before, { ro: true, enc: 'Big5（唯讀）', notice: true })
  await big5.eval(click('#edNoticeAction'))
  await waitFor(async () => fs.readFileSync(file('old.txt')).equals(Buffer.from('中文\r\n', 'utf8')), 'Big5 轉 UTF-8 寫回')
  const after = await big5.eval(`({ ro: ${ED}.getOption(monaco.editor.EditorOption.readOnly), enc: document.getElementById('edEncoding').textContent })`)
  assert.deepEqual(after, { ro: false, enc: 'UTF-8' })
  big5.close()
  const gbk = await openEditor(inspector, 'gbk.txt')
  await gbk.eval(click('#edEncoding'))
  await gbk.eval(menuPick('以其他編碼重新開啟', 'GBK'))
  await waitFor(() => gbk.eval(`${ED}.getModel().getValue() === '中文'`), 'GBK 重新開啟')
  console.log('[F] Big5 一鍵轉 UTF-8 存回、變成可編輯；GBK 檔用「以其他編碼重新開啟」解對')
  gbk.close()
}

async function checkStatusBar(inspector) {
  const page = await openEditor(inspector, 'script.txt')
  await page.eval(click('#edEol'))
  await page.eval(menuPick('', 'CRLF（Windows）'))
  await page.eval(click('#edIndent'))
  await page.eval(menuPick('', '使用 Tab 縮排'))
  await page.eval(click('#edLang'))
  await page.eval(`(() => { const input = document.querySelector('.ed-picker-input'); input.value = 'pyth'; input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  const status = await page.eval(`({ eol: document.getElementById('edEol').textContent, indent: document.getElementById('edIndent').textContent,
    lang: ${ED}.getModel().getLanguageId(), label: document.getElementById('edLang').textContent, dirty: !document.getElementById('edDirty').hidden })`)
  assert.deepEqual(status, { eol: 'CRLF', indent: 'Tab：4', lang: 'python', label: 'Python', dirty: true })
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 })
  await waitFor(async () => fs.readFileSync(file('script.txt'), 'utf8') === 'def main():\r\n    return 1\r\n', 'CRLF 存回')
  await page.eval(click('#edCursor'))
  const goto = await page.eval(`[...document.querySelectorAll('.quick-input-widget')].some((w) => w.style.display !== 'none')`)
  assert(goto, '點行欄要開跳行')
  console.log(`[G] 狀態列：LF→CRLF 存回、縮排 ${status.indent}、語言搜尋切成 ${status.label}、點行欄開跳行`)
  await checkDiffAndSaveAs(inspector, page)
}

async function checkDiffAndSaveAs(inspector, page) {
  await page.eval(`(() => { const m = ${ED}.getModel(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: '# 新標題\\n\\n內容' }], () => null); return true })()`)
  await page.eval(click('#edMore'))
  await page.eval(menuPick('', '比較未儲存的變更'))
  await waitFor(() => page.eval(`monaco.editor.getDiffEditors().length === 1 && !document.getElementById('edDiff').hidden`), '比較畫面')
  await page.eval(click('#edDiffClose'))
  const closed = await page.eval(`({ diffs: monaco.editor.getDiffEditors().length, models: monaco.editor.getModels().length, value: ${ED}.getModel().getValue(monaco.editor.EndOfLinePreference.LF) })`)
  assert.deepEqual(closed, { diffs: 0, models: 1, value: '# 新標題\n\n內容' })
  const target = file('renamed.md')
  await inspector.eval(`(() => { const { dialog } = process.mainModule.require('electron'); dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(target)} }); return true })()`)
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'S', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 10 })
  await waitFor(() => page.eval(`document.getElementById('edName').textContent === 'renamed.md'`), '另存新檔')
  const saved = await page.eval(`({ lang: ${ED}.getModel().getLanguageId(), modes: !document.getElementById('edModes').hidden, dirty: !document.getElementById('edDirty').hidden, title: document.title })`)
  assert.deepEqual(saved, { lang: 'markdown', modes: true, dirty: false, title: 'renamed.md — AxonDeck' })
  assert.equal(fs.readFileSync(target, 'utf8'), '# 新標題\r\n\r\n內容')
  console.log('[H] 比較未儲存的變更開關後 model 完好；[I] 另存成 .md：檔名、語言、預覽切換都跟著換')
  page.close()
}

async function main() {
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--strictPort', '--port', String(VITE_PORT)], { cwd: ROOT, windowsHide: true, stdio: 'ignore' })
  await waitFor(() => fetch(`http://localhost:${VITE_PORT}/`).then(() => true), 'vite 啟動', 60000)
  const child = spawn(require('electron'), [ROOT, '--hidden', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { detached: true, windowsHide: true, stdio: 'ignore' })
  let inspector
  try {
    inspector = await target(INSPECT)
    await waitFor(() => inspector.eval(`!!process.mainModule.require('electron').app.isReady()`), 'app ready', 60000)
    await sleep(1500)
    await inspector.eval(`(() => { const { app } = process.mainModule.require('electron')
      app.on('browser-window-created', (_e, w) => { w.setPosition(-3000, -3000); w.show = () => w.showInactive(); w.focus = () => {}
        w.webContents.session.webRequest.onBeforeRequest({ urls: ['http://localhost:5173/*'] }, (d, cb) => cb({ redirectURL: d.url.replace(':5173', ':${VITE_PORT}') })) }); return true })()`)
    const ignore = await openEditor(inspector, '.gitignore')
    console.log(`[A] .gitignore 打得開，語言 ${await ignore.eval(`document.getElementById('edLang').textContent`)}`)
    ignore.close()
    await checkMarkdownSync(inspector)
    await checkCsv(inspector)
    await checkHtml(inspector)
    await checkMermaid(inspector)
    await checkEncodings(inspector)
    await checkStatusBar(inspector)
    console.log('PASS')
  } finally {
    inspector?.close()
    killTree(child)
    killTree(vite)
  }
}

main().catch((error) => { console.error('FAIL', error.message); process.exitCode = 1 })
