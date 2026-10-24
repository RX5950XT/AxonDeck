/**
 * 打包版 CDP 實測：大檔案「開起來要多久」「關掉後放不放手」。
 *
 * `probe-workspace-perf.js` 量的是「有沒有重做」，這一支量的是**時間與記憶體**：
 *   [A] 1.4MB／4 萬行的檔案，從點下去到 Monaco 掛好幾毫秒
 *   [B] 改過的大檔點開直接是「檢視變更」（並排 diff），而且算得出來
 *   [C] 兩個分頁都關掉、強制 GC 之後，堆積有沒有掉回接近開檔前
 *   [D] 關掉 HTML 預覽分頁之後，那個 `<iframe>`（會一直跑腳本）有沒有被收掉
 *   [E] 關掉影片預覽分頁之後，`<video>`（會一直緩衝）有沒有被收掉
 *   [F] 3MB 與 12MB／30 萬行 JSON 用編輯器打開、可以編輯
 *   [F2] 12MB 檔上每打一個字的耗時、停下來後背景同步的卡頓、存檔寫得回去
 *   [F3] 約 120MB／100 萬行 JSON（超過舊的 50MB 上限）開得起來、捲得順、存得回去
 *   [F4] 超過 256MB（約 330MB／300 萬行）改用唯讀分段檢視：畫得出來、跳行、搜尋（分不分大小寫）、
 *        外面接著寫入時自己更新並跟到檔尾（只掃新的那段）、關得掉
 *   [F5] 超過 512K 字的 Markdown 預設開編輯，切預覽只畫開頭並註明
 *   [F6] 超過 256MB 的 UTF-16 LE 檔也用分段檢視打開、中文正常、搜得到
 *   [F7] 提交過又改過的 330MB 檔：樹上點開走「檢視變更」不會撐爆（diff 只收前一段），等的時候有提示、看得到改的那一行
 *   [G] 大圖片／影片（拖進度條）／音訊／PDF 走 `vi-media://` 串流；協定擋錯 token、越界、非媒體檔
 *
 * 全程用自己的暫存 user-data-dir，收尾只殺自己 spawn 的那個 pid。
 *
 * 用法：node scripts/probe-workspace-bigfile.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const http = require('http')
const fs = require('fs')

const PORT = 9253
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')
const USER_DATA_DIR = tempDir('axondeck-bigfile-')
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))

const PROJECT = path.join(USER_DATA_DIR, 'proj')
fs.mkdirSync(PROJECT)

/** 約 1.4MB、四萬行——可編輯、會拿來做 diff 的那一類大檔 */
const BIG_LINES = 40000
const bigOriginal = Array.from({ length: BIG_LINES }, (_, i) => `const line${i} = ${i} // 一行程式碼佔位`).join('\n')
const bigModified = bigOriginal.replace(/const line100 = 100/, 'const line100 = 999')
fs.writeFileSync(path.join(PROJECT, 'big.js'), bigOriginal)
fs.writeFileSync(path.join(PROJECT, 'page.html'), '<h1>預覽</h1><script>setInterval(() => {}, 50)</script>')
/** [F] 約 12MB 與約 3MB 的 JSON（舊版超過 2MB 就不給開），兩個都要能編輯 */
const HUGE_LINES = 300000
const MID_LINES = 75000
const jsonLines = (n) => `[\n${Array.from({ length: n - 2 }, (_, i) => `  {"id": ${i}, "name": "item-${i}"}`).join(',\n')}\n]`
fs.writeFileSync(path.join(PROJECT, 'huge.json'), jsonLines(HUGE_LINES))
fs.writeFileSync(path.join(PROJECT, 'mid.json'), jsonLines(MID_LINES))

const git = (...args) => execFileSync('git', args, { cwd: PROJECT, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
git('init', '-q')
git('config', 'user.email', 'probe@example.invalid')
git('config', 'user.name', 'probe')
git('add', '-A')
git('commit', '-qm', 'seed')
fs.writeFileSync(path.join(PROJECT, 'big.js'), bigModified)
/** [F3] 約 120MB、含中文（兩位元組字串）。commit 之後才寫，不拖慢 git */
const GIANT_LINES = 1000000
const giantRow = (i) => `  {"id": ${i}, "name": "item-${i}", "tags": ["alpha", "beta"], "note": "第 ${i} 筆中文測試資料"},`
{
  const out = fs.openSync(path.join(PROJECT, 'giant.json'), 'w')
  for (let i = 0; i < GIANT_LINES; i += 50000) {
    fs.writeSync(out, Array.from({ length: 50000 }, (_, k) => giantRow(i + k)).join('\n') + '\n')
  }
  fs.closeSync(out)
}
const GIANT_SIZE = fs.statSync(path.join(PROJECT, 'giant.json')).size
/** [F4] 超過 Monaco 上限 */
const OVER_LINES = 3000000
{
  const out = fs.openSync(path.join(PROJECT, 'over.json'), 'w')
  for (let i = 0; i < OVER_LINES; i += 50000) {
    fs.writeSync(out, Array.from({ length: 50000 }, (_, k) => giantRow(i + k)).join('\n') + '\n')
  }
  fs.closeSync(out)
}
/** [F6] 超過上限的 UTF-16 LE（有 BOM） */
const WIDE_LINES = 2600000
{
  const out = fs.openSync(path.join(PROJECT, 'wide.log'), 'w')
  fs.writeSync(out, Buffer.from([0xff, 0xfe]))
  const pad = 'x'.repeat(30)
  for (let i = 0; i < WIDE_LINES; i += 100000) {
    fs.writeSync(out, Buffer.from(Array.from({ length: 100000 }, (_, k) => `Wide ${i + k} 寬字元測試資料 ${pad}`).join('\r\n') + '\r\n', 'utf16le'))
  }
  fs.closeSync(out)
}
/** [F5] 約 2MB 的 Markdown */
fs.writeFileSync(path.join(PROJECT, 'long.md'), Array.from({ length: 40000 }, (_, i) => `## 第 ${i} 節\n\n一段說明文字 **粗體** 與 \`code\`。\n`).join('\n'))

// ===== [G] 大媒體（舊版整份 base64 過 IPC，上限 2MB）。放在 commit 之後，不必進 git =====
const IMG_SIDE = 3000
const PDF_PAGES = 400
const AUDIO_SECONDS = 180
const VIDEO_SECONDS = 20

/** 3000×3000 雜訊 PNG（壓不小，約 27MB） */
function writeNoisePng(file, side) {
  const zlib = require('zlib')
  const raw = require('crypto').randomBytes((side * 3 + 1) * side)
  for (let y = 0; y < side; y += 1) raw[y * (side * 3 + 1)] = 0
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))
  ]))
}

/** 400 頁、每頁一大串小方塊的 PDF（純 ASCII，xref 位移直接數位元組） */
function writeBigPdf(file, pages) {
  const objs = []
  const kids = []
  const boxes = Array.from({ length: 1500 }, (_, i) => `${(i * 37) % 560 + 20} ${(i * 53) % 760 + 20} 6 6 re f`).join('\n')
  for (let p = 0; p < pages; p += 1) {
    const pageId = 3 + p * 2
    const content = `BT /F1 24 Tf 72 720 Td (Page ${p + 1}) Tj ET\n${boxes}\n`
    kids.push(`${pageId} 0 R`)
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`
    objs[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}endstream`
  }
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`
  objs[3 + pages * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  fs.writeFileSync(file, out)
}

/** 3 分鐘 44.1kHz 立體聲 16-bit 靜音 WAV（約 30MB） */
function writeSilentWav(file, seconds) {
  const dataLen = seconds * 44100 * 4
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + dataLen, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22)
  head.writeUInt32LE(44100, 24); head.writeUInt32LE(44100 * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(dataLen, 40)
  fs.writeFileSync(file, Buffer.concat([head, Buffer.alloc(dataLen)]))
}

writeNoisePng(path.join(PROJECT, 'noise.png'), IMG_SIDE)
writeBigPdf(path.join(PROJECT, 'big.pdf'), PDF_PAGES)
writeSilentWav(path.join(PROJECT, 'long.wav'), AUDIO_SECONDS)
execFileSync(require('ffmpeg-static'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30`,
  '-t', String(VIDEO_SECONDS), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p',
  path.join(PROJECT, 'big.mp4')])
const mediaSizes = Object.fromEntries(['noise.png', 'big.pdf', 'long.wav', 'big.mp4']
  .map((name) => [name, fs.statSync(path.join(PROJECT, name)).size]))

fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
  projects: [{ id: 'w_big', name: '大檔', path: PROJECT, createdAt: Date.now() }]
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
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
    this.ws = new globalThis.WebSocket(this.wsUrl)
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
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 連線已關閉'))
      this.pending.clear()
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}
// 功能頁是各自的 WebContentsView：跟著主視窗目前那頁走（抓外殼頁會看不到側欄）
require('./lib/page-cdp').followMainPage(Cdp)

async function waitTargets(timeoutMs = 40000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

async function waitInPage(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(150)
  }
  return false
}

/** 強制 GC 兩輪再量：一輪常常還留著上一輪剛斷開的東西 */
async function heapMb(cdp) {
  for (let i = 0; i < 3; i += 1) {
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(300)
  }
  const usage = await cdp.send('Runtime.getHeapUsage')
  return Math.round((usage.usedSize / 1024 / 1024) * 10) / 10
}

/**
 * 整個 App（主行程＋所有 renderer／GPU 子行程）現在佔多少實體記憶體。
 * 使用者在工作管理員看到的是這個數字，不是 V8 的堆積。
 * @param {number} rootPid
 * @returns {number} MB
 */
function workingSetMb(rootPid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `
      $ids = @(${rootPid})
      $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize
      for ($i = 0; $i -lt 5; $i++) {
        $ids += ($all | Where-Object { $ids -contains $_.ParentProcessId }).ProcessId
        $ids = $ids | Select-Object -Unique
      }
      [math]::Round((($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 1)
    `], { encoding: 'utf8' })
    return Number(String(out).trim()) || 0
  } catch {
    return 0
  }
}

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  const note = (text) => console.log(`      · ${text}`)

  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--hidden',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  let cdp = null

  try {
    const pages = await waitTargets()
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1500)
    await cdp.eval('window.electronAPI.window.minimize()')

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('工作區載得起來', await waitInPage(cdp, `!!document.getElementById('wsTabStrip')`))

    await cdp.eval(`document.getElementById('sidebarModeProjects').click()`)
    ok('側欄列得出這個專案', await waitInPage(cdp, `!!document.querySelector('#projList [data-id="w_big"] .chat-list-open')`))
    await cdp.eval(`document.querySelector('#projList [data-id="w_big"] .chat-list-open').click()`)
    await waitInPage(cdp, `document.querySelectorAll('#wsTree .ws-tree-row').length >= 1`)
    await sleep(800)

    // Monaco 是 16MB 的 AMD 包，載進來本身就要好幾 MB 堆積，而且**不會再放掉**。
    // 基準線要在它載完之後量，不然「關掉之後多留幾 MB」量到的是 Monaco 自己。
    const warmed = await waitInPage(cdp, `!!window.monaco`, 20000)
    ok('選了專案就趁閒置先把 Monaco 載起來', warmed)
    const baseHeap = await heapMb(cdp)
    note(`開檔前（Monaco 已載入、沒開任何檔）的堆積 ${baseHeap} MB`)

    // ===== [A] 開大檔 =====
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="big.js"]').click()`)
    const opened = await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() > 39000)`)
    const openMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    ok('[A] 1.4MB／4 萬行開得起來', opened, `${openMs}ms（含首次載 Monaco）`)

    // 關掉再開一次：這才是使用者平常的成本（Monaco 已經在了）
    await cdp.eval(`(async () => {
      document.querySelector('#wsTabStrip .ws-tab .ws-tab-close').click()
      await new Promise((r) => setTimeout(r, 600))
    })()`)
    await sleep(400)
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="big.js"]').click()`)
    await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() > 39000)`)
    const reopenMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    note(`[A] Monaco 已在時再開一次：${reopenMs}ms`)
    const openHeap = await heapMb(cdp)
    note(`[A] 開著大檔的堆積 ${openHeap} MB（+${Math.round((openHeap - baseHeap) * 10) / 10}）`)

    // ===== [B] 預覽變更 =====
    // 改過（還沒提交）的檔案在樹上點開，預設就是「檢視變更」（`workspace-page.js` 的樹點擊），不必再按按鈕
    const diffShown = await waitInPage(cdp, `!document.getElementById('wsDiffMonaco')?.hidden`)
    // 並排 diff 是非同步算的：等到它真的標出那一塊變更為止
    const diffReady = await waitInPage(cdp, `
      document.querySelectorAll('#wsDiffMonaco .line-insert, #wsDiffMonaco .char-insert, #wsDiffMonaco .line-delete').length > 0
    `, 40000)
    ok('[B] 改過的大檔點開直接是並排變更，而且算得出來', diffShown && diffReady)
    const diffHeap = await heapMb(cdp)
    note(`[B] 開著大檔＋diff 的堆積 ${diffHeap} MB`)

    // ===== [C] 全關掉之後放不放手 =====
    const closed = await cdp.eval(`(async () => {
      let guard = 0
      while (document.querySelectorAll('#wsTabStrip .ws-tab').length && guard < 20) {
        guard += 1
        const btn = document.querySelector('#wsTabStrip .ws-tab .ws-tab-close')
        if (!btn) break
        btn.click()
        await new Promise((r) => setTimeout(r, 350))
      }
      return document.querySelectorAll('#wsTabStrip .ws-tab').length
    })()`)
    ok('分頁全關掉了', closed === 0, `剩 ${closed} 個`)
    await sleep(600)
    const afterHeap = await heapMb(cdp)
    note(`[C] 開檔前 ${baseHeap} → 開著大檔＋diff ${diffHeap} → 全關掉 ${afterHeap} MB`)
    const liveModels = await cdp.eval('window.monaco ? window.monaco.editor.getModels().length : -1')
    ok('[C] Monaco 沒有留下任何 model', liveModels === 0, `還留著 ${liveModels} 顆`)
    // 不拿「開檔前」當標準：第一次真的用到編輯器與並排 diff 時，Monaco 會再載一批
    // 程式碼與快取進來，那是一次性的、放不掉的。要看的是「開著」跟「關掉」差多少。
    ok('[C] 關掉之後堆積掉了一大截（大檔的內容真的放掉了）',
      diffHeap - afterHeap >= 15,
      `${diffHeap} → ${afterHeap} MB，掉了 ${Math.round((diffHeap - afterHeap) * 10) / 10} MB`)
    const memAfterFirst = await workingSetMb(child.pid)

    // ===== 再開一輪：關掉之後有沒有「愈積愈多」才是漏不漏的判準 =====
    // 第一輪多出來的那幾 MB 是 Monaco 用到編輯器與並排 diff 才載進來的程式碼與快取，
    // 那是一次性的；真正的漏會讓第二輪再往上疊一份。
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="big.js"]').click()`)
    await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() > 39000)`)
    await waitInPage(cdp, `!document.getElementById('wsEditorDiffBtn')?.hidden`)
    await cdp.eval(`document.getElementById('wsEditorDiffBtn').click()`)
    await waitInPage(cdp, `!document.getElementById('wsDiffMonaco')?.hidden`)
    await waitInPage(cdp, `
      document.querySelectorAll('#wsDiffMonaco .line-insert, #wsDiffMonaco .char-insert, #wsDiffMonaco .line-delete').length > 0
    `, 40000)
    await cdp.eval(`(async () => {
      let guard = 0
      while (document.querySelectorAll('#wsTabStrip .ws-tab').length && guard < 20) {
        guard += 1
        const btn = document.querySelector('#wsTabStrip .ws-tab .ws-tab-close')
        if (!btn) break
        btn.click()
        await new Promise((r) => setTimeout(r, 350))
      }
    })()`)
    await sleep(600)
    const secondHeap = await heapMb(cdp)
    const growth = Math.round((secondHeap - afterHeap) * 10) / 10
    ok('[C] 第二輪開關之後不再往上疊（沒有每開一次就漏一份）', growth <= 2,
      `第一輪關掉後 ${afterHeap} → 第二輪關掉後 ${secondHeap} MB（多 ${growth}）`)
    const memAfterSecond = await workingSetMb(child.pid)
    note(`[C] 整個 App 的工作集：第一輪關掉後 ${memAfterFirst} MB → 第二輪關掉後 ${memAfterSecond} MB`)

    // ===== [D] HTML 預覽的 iframe =====
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="page.html"]').click()`)
    await waitInPage(cdp, `!document.getElementById('wsEditor')?.hidden`)
    await sleep(500)
    const framed = await waitInPage(cdp, `!!document.querySelector('#wsEditorPreview iframe')`)
    ok('HTML 預覽畫得出來', framed)
    await cdp.eval(`(async () => {
      document.querySelector('#wsTabStrip .ws-tab .ws-tab-close').click()
      await new Promise((r) => setTimeout(r, 500))
    })()`)
    await sleep(500)
    const leftovers = await cdp.eval(`document.querySelectorAll('#wsEditorPreview iframe, #wsEditorPreview video, #wsEditorPreview audio').length`)
    ok('[D] 關掉預覽分頁後 iframe 被收掉（不會繼續跑腳本）', framed && leftovers === 0, `還留著 ${leftovers} 個`)

    // ===== [F] 超過舊的 2MB 上限：幾十萬行的 JSON 要像 VS Code 一樣開得起來 =====
    for (const spec of [
      { rel: 'mid.json', lines: MID_LINES },
      { rel: 'huge.json', lines: HUGE_LINES }
    ]) {
      await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="${spec.rel}"]').click()`)
      const shown = await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getModels().some((m) => m.getLineCount() >= ${spec.lines})`, 60000)
      const ms = await cdp.eval('Math.round(performance.now() - window.__t0)')
      const state = await cdp.eval(`({
        unsupported: !document.getElementById('wsEditorUnsupported').hidden,
        monaco: !document.getElementById('wsMonacoHost').hidden,
        note: document.getElementById('wsEditorNote')?.hidden ? '' : document.getElementById('wsEditorNote')?.textContent,
        saveHidden: document.getElementById('wsEditorSaveBtn').hidden
      })`)
      ok(`[F] ${spec.rel}（${spec.lines} 行）用編輯器打開，不是「無法預覽」`, shown && !state.unsupported && state.monaco, `${ms}ms`)
      ok(`[F] ${spec.rel} 可以編輯存檔`, !state.saveHidden && !state.note, JSON.stringify(state))
    }

    // ===== [F2] 12MB 的檔上打字與存檔（huge.json 還開著） =====
    // 同步連打 40 個字，量每一下花多少（Monaco 自己的編輯＋我們的 onChange）；
    // 之後停 2 秒讓防抖的影子同步與草稿存檔跑完，量這段期間最長的卡頓（long task）
    const typing = await cdp.eval(`(() => {
      window.__long = []
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)) })
        .observe({ type: 'longtask', buffered: false })
      const ed = window.monaco.editor.getEditors()[0]
      ed.focus()
      ed.setPosition({ lineNumber: 150000, column: 1 })
      const times = []
      for (let i = 0; i < 40; i += 1) {
        const t = performance.now()
        ed.trigger('keyboard', 'type', { text: 'x' })
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      return { avg: Math.round(times.reduce((s, v) => s + v, 0) / times.length * 10) / 10, p95: Math.round(times[37] * 10) / 10 }
    })()`)
    ok('[F2] 分頁當場標成未存', await cdp.eval(`!!document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-dirty')`))
    await sleep(2500)
    const longTasks = await cdp.eval('window.__long.slice()')
    const worst = longTasks.length ? Math.max(...longTasks) : 0
    ok('[F2] 12MB 檔每打一個字 < 16ms（一幀內）', typing.avg < 16 && typing.p95 < 32, `平均 ${typing.avg}ms、p95 ${typing.p95}ms`)
    ok('[F2] 打完停下來，背景同步沒有卡超過 200ms', worst < 200, `long tasks: ${JSON.stringify(longTasks)}`)
    // 大檔的內容是停手 300ms 才交出去：再打幾個字馬上切去別的分頁，不可以記到那一頁上
    const tabOf = (rel) => `[...document.querySelectorAll('#wsTabStrip .ws-tab')].find((t) => t.textContent.includes('${rel}'))`
    await cdp.eval(`(() => {
      const ed = window.monaco.editor.getEditors()[0]
      const midTab = ${tabOf('mid.json')}
      for (let i = 0; i < 5; i += 1) ed.trigger('keyboard', 'type', { text: 'y' })
      midTab.querySelector('.ws-tab-open').click()
    })()`)
    await sleep(1000)
    const midState = await cdp.eval(`({
      dirty: !!${tabOf('mid.json')}.querySelector('.ws-tab-dirty'),
      lines: window.monaco.editor.getEditors()[0].getModel().getLineCount()
    })`)
    ok('[F2] 打完立刻切走，另一個分頁沒被寫進大檔的內容', !midState.dirty && midState.lines === MID_LINES, JSON.stringify(midState))
    await cdp.eval(`${tabOf('huge.json')}.querySelector('.ws-tab-open').click()`)
    ok('[F2] 切回來大檔仍是未存、打的字還在', await waitInPage(cdp, `(() => {
      const m = window.monaco.editor.getEditors()[0].getModel()
      return m.getLineCount() === ${HUGE_LINES} && m.getLineContent(150000).startsWith('x'.repeat(40) + 'y'.repeat(5))
        && !!document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-dirty')
    })()`, 10000))
    await cdp.eval(`window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.querySelector('.toast')?.textContent.trim())).observe(document.querySelector('.toast'), { childList: true, subtree: true, characterData: true, attributes: true }); window.__t0 = performance.now(); document.getElementById('wsEditorSaveBtn').click()`)
    const savedOk = await waitInPage(cdp, `!document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-dirty')`, 20000)
    const saveMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    const onDisk = fs.readFileSync(path.join(PROJECT, 'huge.json'), 'utf8')
    ok('[F2] 12MB 檔存得回去（45 個字真的寫進磁碟）', savedOk && onDisk.length === jsonLines(HUGE_LINES).length + 45, `${saveMs}ms` + (savedOk ? '' : ' ' + await cdp.eval(`(async () => { const wm = await import(new URL('scripts/ws-monaco.js', location.href).href); let cv; try { cv = typeof wm.currentValue() } catch (e) { cv = 'throw ' + e.message } return JSON.stringify({ cv, toasts: window.__toasts, saveBtn: [document.getElementById('wsEditorSaveBtn').hidden, document.getElementById('wsEditorSaveBtn').disabled],
      dialog: document.querySelector('dialog[open]')?.innerText.slice(0, 200) || '',
      banner: document.getElementById('wsEditorExtBanner')?.hidden ? '' : document.getElementById('wsEditorExtBanner')?.innerText,
      held: document.getElementById('wsEditorText').dataset.held, live: window.monaco.editor.getEditors()[0]?.getModel()?.getLineCount(),
      disk: ${onDisk.length - jsonLines(HUGE_LINES).length}
    }) })()`)))
    await cdp.eval(`(async () => {
      for (const btn of document.querySelectorAll('#wsTabStrip .ws-tab .ws-tab-close')) {
        btn.click()
        await new Promise((r) => setTimeout(r, 400))
      }
    })()`)
    ok('[F2] 兩個分頁都關掉了', await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 0`, 5000))

    // ===== [F3] 超過舊的 50MB 上限 =====
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="giant.json"]').click()`)
    const giantShown = await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getEditors()[0]?.getModel()?.getLineCount() > ${GIANT_LINES}`, 90000)
    // 視窗最小化時不發 rAF：一律用 render(true) 同步強制畫一次
    await cdp.eval('window.monaco.editor.getEditors()[0].render(true)')
    const giantMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    const giantState = await cdp.eval(`({
      unsupported: !document.getElementById('wsEditorUnsupported').hidden,
      monaco: !document.getElementById('wsMonacoHost').hidden,
      saveHidden: document.getElementById('wsEditorSaveBtn').hidden,
      shadow: document.getElementById('wsEditorText')?.value.length || 0
    })`)
    ok(`[F3] ${(GIANT_SIZE / 1048576).toFixed(0)}MB／${GIANT_LINES} 行用編輯器打開、可以存`, giantShown && !giantState.unsupported && giantState.monaco && !giantState.saveHidden, `${giantMs}ms ${JSON.stringify(giantState)}`)
    ok('[F3] 大檔沒倒進影子 textarea', giantState.shadow === 0)
    const giantScroll = await cdp.eval(`(() => {
      const ed = window.monaco.editor.getEditors()[0]; const times = []
      for (let i = 0; i < 60; i += 1) {
        const t = performance.now()
        if (i % 2) ed.setScrollTop(ed.getScrollTop() + 400); else ed.revealLineInCenter(1 + Math.floor(Math.random() * ${GIANT_LINES}))
        ed.render(true)
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      return { median: Math.round(times[30]), p95: Math.round(times[56]) }
    })()`)
    ok('[F3] 捲動／跳行後重畫中位數 < 16ms', giantScroll.median < 16, JSON.stringify(giantScroll))
    await cdp.eval(`(() => { const ed = window.monaco.editor.getEditors()[0]; ed.setPosition({ lineNumber: 500000, column: 1 }); ed.trigger('keyboard', 'type', { text: 'zz' }) })()`)
    await sleep(800)
    await cdp.eval(`window.__t0 = performance.now(); document.getElementById('wsEditorSaveBtn').click()`)
    const giantSaved = await waitInPage(cdp, `!document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-dirty')`, 60000)
    const giantSaveMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    ok('[F3] 存得回去（多 2 bytes）', giantSaved && fs.statSync(path.join(PROJECT, 'giant.json')).size === GIANT_SIZE + 2, `${giantSaveMs}ms`)
    await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-close').click()`)
    ok('[F3] 分頁關得掉', await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 0`, 5000))

    // ===== [F4] 超過 256MB：唯讀分段檢視 =====
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="over.json"]').click()`)
    const overShown = await waitInPage(cdp, `!document.getElementById('wsBigText').hidden && document.querySelectorAll('#wsBigText .bt-row:not([hidden]) .bt-tx').length > 5
      && document.querySelector('#wsBigText .bt-row .bt-tx').textContent.length > 0`, 120000)
    const overMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    const overState = await cdp.eval(`({
      info: document.querySelector('#wsBigText .bt-info')?.textContent,
      monaco: !document.querySelector('.ws-ide-container').hidden,
      save: !document.getElementById('wsEditorSaveBtn').hidden,
      note: document.getElementById('wsEditorNote').textContent
    })`)
    ok('[F4] 330MB 用分段檢視打開（不是「無法預覽」，Monaco／儲存都收起來）', overShown && !overState.monaco && !overState.save, `${overMs}ms ${JSON.stringify(overState)}`)
    const overNav = await cdp.eval(`(async () => {
      const wait = async (fn) => { const end = performance.now() + 30000; while (!fn()) { if (performance.now() > end) return false; await new Promise((r) => setTimeout(r, 5)) } return true }
      const current = () => document.querySelector('#wsBigText .bt-row.is-current')
      const line = document.querySelector('#wsBigText .bt-input[type=number]'); line.value = '2999990'
      let t = performance.now()
      line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const jumped = await wait(() => current()?.querySelector('.bt-ln').textContent === '2999990' && current().querySelector('.bt-tx').textContent)
      const jumpMs = Math.round(performance.now() - t)
      document.querySelector('#wsBigText .bt-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true }))
      const find = document.querySelector('#wsBigText .bt-find'); find.value = '"id": 2999998,'
      t = performance.now()
      find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const found = await wait(() => current()?.querySelector('.bt-hit') && current().querySelector('.bt-ln').textContent === '2999999')
      return { jumped, jumpMs, found, findMs: Math.round(performance.now() - t) }
    })()`)
    ok('[F4] 跳到倒數第 10 行、從頭搜尋到檔尾那一筆', overNav.jumped && overNav.found, JSON.stringify(overNav))
    const caseNav = await cdp.eval(`(async () => {
      const wait = async (fn) => { const end = performance.now() + 30000; while (!fn()) { if (performance.now() > end) return false; await new Promise((r) => setTimeout(r, 5)) } return true }
      const current = () => document.querySelector('#wsBigText .bt-row.is-current')
      const status = document.querySelector('#wsBigText .bt-status')
      document.querySelector('#wsBigText .bt-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true }))
      const find = document.querySelector('#wsBigText .bt-find'); find.value = '"ID": 2999997,'
      find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const loose = await wait(() => current()?.querySelector('.bt-ln').textContent === '2999998' && current().querySelector('.bt-hit')?.textContent === '"id": 2999997,')
      document.querySelector('#wsBigText .bt-case').click()
      find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const strict = await wait(() => status.textContent === '找不到')
      document.querySelector('#wsBigText .bt-case').click()
      return { loose, strict }
    })()`)
    ok('[F4] 預設不分大小寫；按 Aa 之後要一模一樣', caseNav.loose && caseNav.strict, JSON.stringify(caseNav))
    // 停在檔尾，外面再寫 10 行：2 秒內要自己長出來，而且畫面跟到新的檔尾。
    // 探針視窗是縮小的（document.hidden），檢視那時本來就不問磁碟：這一段假裝看得見
    await cdp.eval(`Object.defineProperty(document, 'hidden', { get: () => false, configurable: true })`)
    await cdp.eval(`document.querySelector('#wsBigText .bt-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true }))`)
    fs.appendFileSync(path.join(PROJECT, 'over.json'), Array.from({ length: 10 }, (_, k) => giantRow(OVER_LINES + k)).join('\n') + '\n')
    const t0 = Date.now()
    const grew = await waitInPage(cdp, `/3,000,010 行/.test(document.querySelector('#wsBigText .bt-info').textContent)
      && [...document.querySelectorAll('#wsBigText .bt-row:not([hidden]) .bt-ln')].some((n) => n.textContent === '3000010')`, 20000)
    ok('[F4] 外面接著寫入：自己更新行數、停在檔尾的跟到新的檔尾', grew, `${Date.now() - t0}ms`)
    // 只是往後長：重建索引要接著掃，不是整份 330MB 重掃（整份約 1 秒）
    await cdp.eval(`delete document.hidden`)
    fs.appendFileSync(path.join(PROJECT, 'over.json'), Array.from({ length: 10 }, (_, k) => giantRow(OVER_LINES + 10 + k)).join('\n') + '\n')
    const reindex = await cdp.eval(`(async () => {
      const api = window.electronAPI.workspace
      const list = (await api.listProjects()).data || []
      const proj = list.find((p) => p.path === ${JSON.stringify(PROJECT)}) || list[0]
      const t = performance.now()
      const res = await api.bigOpen(proj.id, 'over.json')
      return { ms: Math.round(performance.now() - t), lines: res.data?.lines }
    })()`)
    ok('[F4] 檔案變長只掃新的那段（< 300ms）', reindex.lines === OVER_LINES + 20 && reindex.ms < 300, JSON.stringify(reindex))
    await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-close').click()`)
    ok('[F4] 分頁關得掉、檢視收乾淨', await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 0 && !document.querySelector('#wsBigText .bt')`, 5000))

    // ===== [F5] 大 Markdown：預設編輯、預覽只畫開頭 =====
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="long.md"]').click()`)
    const mdEdit = await waitInPage(cdp, `!!window.monaco && window.monaco.editor.getEditors()[0]?.getModel()?.getLineCount() > 80000 && document.getElementById('wsEditorPreview').hidden`, 30000)
    ok('[F5] 2MB Markdown 預設開編輯，不是一打開就整份預覽', mdEdit)
    await cdp.eval(`window.__t0 = performance.now(); document.getElementById('wsEditorPreviewBtn').click()`)
    const mdCut = await waitInPage(cdp, `!document.getElementById('wsEditorPreview').hidden && /預覽只畫開頭/.test(document.getElementById('wsEditorPreview').lastElementChild?.textContent || '')`, 30000)
    const mdMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    ok('[F5] 切預覽只畫開頭並註明', mdCut, `${mdMs}ms`)
    await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-close').click()`)
    ok('[F5] 分頁關得掉', await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 0`, 5000))

    // ===== [F6] 超過 256MB 的 UTF-16 =====
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="wide.log"]').click()`)
    const wideShown = await waitInPage(cdp, `document.querySelector('#wsBigText .bt-row .bt-tx')?.textContent?.startsWith('Wide 0 寬字元測試資料')`, 120000)
    const wideMs = await cdp.eval('Math.round(performance.now() - window.__t0)')
    const wideInfo = await cdp.eval(`document.querySelector('#wsBigText .bt-info')?.textContent || ''`)
    ok('[F6] UTF-16 LE 超大檔用分段檢視打開、中文正常', wideShown && wideInfo.includes(`${WIDE_LINES.toLocaleString('en-US')} 行`), `${wideMs}ms ${wideInfo}`)
    const wideFind = await cdp.eval(`(async () => {
      const wait = async (fn) => { const end = performance.now() + 30000; while (!fn()) { if (performance.now() > end) return false; await new Promise((r) => setTimeout(r, 5)) } return true }
      const current = () => document.querySelector('#wsBigText .bt-row.is-current')
      const find = document.querySelector('#wsBigText .bt-find'); find.value = 'wide ${WIDE_LINES - 1} 寬'
      const t = performance.now()
      find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const found = await wait(() => current()?.querySelector('.bt-ln').textContent === '${WIDE_LINES}')
      return { found, ms: Math.round(performance.now() - t) }
    })()`)
    ok('[F6] UTF-16 檔搜得到最後一行', wideFind.found, JSON.stringify(wideFind))
    await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-close').click()`)
    ok('[F6] 分頁關得掉', await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 0 && !document.querySelector('#wsBigText .bt')`, 5000))

    // ===== [F7] 提交過又改過的 330MB 檔：樹上點開走「檢視變更」那條 =====
    let t7 = Date.now()
    git('add', 'over.json')
    git('commit', '-qm', 'over')
    note(`[F7] git 提交 330MB 花 ${Date.now() - t7}ms（測試準備，不算 app）`)
    fs.appendFileSync(path.join(PROJECT, 'over.json'), giantRow(OVER_LINES + 20) + '\n')
    const marked = await waitInPage(cdp, `!!document.querySelector('#wsTree .ws-tree-row[data-rel="over.json"] .ws-tree-status.is-changed')`, 30000)
    ok('[F7] 樹上標成「改過」', marked)
    const heap7 = await heapMb(cdp)
    await cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="over.json"]').click()`)
    // git 比對兩份 330MB 要好幾秒：等的時候要有提示，出來之後提示要收掉
    ok('[F7] 等比對時掛著「讀取變更中…」', await waitInPage(cdp, `!document.querySelector('.toast').classList.contains('hidden') && document.querySelector('.toast').textContent.includes('讀取變更中')`, 5000))
    const diff7 = await waitInPage(cdp, `(() => {
      const box = document.getElementById('wsDiffContent')
      return box && !box.hidden && box.textContent.length > 0
    })()`, 60000)
    const diff7Ms = await cdp.eval('Math.round(performance.now() - window.__t0)')
    const diff7State = await cdp.eval(`({
      text: document.getElementById('wsDiffContent').textContent.slice(-120),
      rows: document.querySelectorAll('#wsDiffContent .ws-diff-line-add, #wsDiffContent .ws-diff-line-del').length,
      stats: document.getElementById('wsDiffStats')?.textContent || ''
    })`)
    ok('[F7] 改過的 330MB 檔點開出得來（逐行檢視，看得到加的那一行）', diff7 && diff7State.rows > 0 && diff7State.text.includes(String(OVER_LINES + 20)), `${diff7Ms}ms ${JSON.stringify(diff7State)}`)
    ok('[F7] 變更出來後提示收掉', await waitInPage(cdp, `document.querySelector('.toast').classList.contains('hidden') || !document.querySelector('.toast').textContent.includes('讀取變更中')`, 3000))
    note(`[F7] 開著 330MB diff 的堆積 ${await heapMb(cdp)} MB（點之前 ${heap7}）`)
    await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-close').click()`)
    ok('[F7] 分頁關得掉', await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 0`, 5000))

    // ===== [G] 大媒體走 vi-media:// 串流 =====
    note(`[G] 檔案大小：${Object.entries(mediaSizes).map(([k, v]) => `${k} ${(v / 1048576).toFixed(1)}MB`).join('、')}`)
    const openRow = (rel) => cdp.eval(`window.__t0 = performance.now(); document.querySelector('#wsTree .ws-tree-row[data-rel="${rel}"]').click()`)
    const elapsed = () => cdp.eval('Math.round(performance.now() - window.__t0)')
    // 關不掉要當場紅（舊版關影音分頁會丟例外，之後點什麼都沒反應）
    const closeActive = async (label) => {
      await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab.is-active .ws-tab-close').click()`)
      ok(`[G] ${label} 分頁關得掉`, await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 0`, 5000))
    }
    const heapBeforeMedia = await heapMb(cdp)

    await openRow('noise.png')
    const imgOk = await waitInPage(cdp, `(() => { const i = document.querySelector('#wsEditorPreview img.ws-editor-img'); return i && i.complete && i.naturalWidth === ${IMG_SIDE} })()`, 30000)
    ok(`[G] ${(mediaSizes['noise.png'] / 1048576).toFixed(0)}MB 圖片畫得出來`, imgOk, `${await elapsed()}ms`)
    const imgSrc = await cdp.eval(`document.querySelector('#wsEditorPreview img.ws-editor-img')?.src || ''`)
    ok('[G] 圖片走 vi-media:// 不是 data: URI', imgSrc.startsWith('vi-media://'), imgSrc.slice(0, 40))
    const heapWithImg = await heapMb(cdp)
    ok('[G] 開著大圖片 JS 堆積沒有多一份檔案大小', heapWithImg - heapBeforeMedia < 10, `${heapBeforeMedia} → ${heapWithImg} MB`)

    // 協定本身：Range、錯 token、越界、非媒體檔
    const proto = await cdp.eval(`(async () => {
      const src = ${JSON.stringify(imgSrc)}
      const blocked = async (url) => { try { return !(await fetch(url)).ok } catch { return true } }
      const full = await fetch(src)
      const part = await fetch(src, { headers: { Range: 'bytes=0-9' } })
      const partLen = (await part.arrayBuffer()).byteLength
      await full.body.cancel()
      const u = new URL(src)
      return {
        fullStatus: full.status, fullLen: Number(full.headers.get('content-length')),
        partStatus: part.status, partLen, partRange: part.headers.get('content-range'),
        wrongToken: await blocked(src.replace(u.host, '0'.repeat(32))),
        traversal: await blocked(u.origin + '/w_big/..%2F..%2Fconfig.json'),
        notMedia: await blocked(u.origin + '/w_big/huge.json'),
        wrongProject: await blocked(u.origin + '/w_nope/noise.png')
      }
    })()`)
    ok('[G] 整份 200、長度對', proto.fullStatus === 200 && proto.fullLen === mediaSizes['noise.png'], JSON.stringify(proto))
    ok('[G] Range 回 206 與 10 個位元組', proto.partStatus === 206 && proto.partLen === 10 && proto.partRange === `bytes 0-9/${mediaSizes['noise.png']}`)
    ok('[G] 錯的 token／越界路徑／非媒體檔／不存在的專案都拿不到', proto.wrongToken && proto.traversal && proto.notMedia && proto.wrongProject)
    await closeActive('圖片')

    await openRow('big.mp4')
    const videoReady = await waitInPage(cdp, `(() => { const v = document.querySelector('#wsEditorPreview video'); return v && v.readyState >= 1 && v.duration > ${VIDEO_SECONDS - 1} })()`, 30000)
    ok(`[G] ${(mediaSizes['big.mp4'] / 1048576).toFixed(0)}MB 影片載得起來`, videoReady, `${await elapsed()}ms`)
    const seek = await cdp.eval(`(async () => {
      const v = document.querySelector('#wsEditorPreview video')
      const t = performance.now()
      const done = new Promise((r) => { v.addEventListener('seeked', () => r(true), { once: true }); setTimeout(() => r(false), 15000) })
      v.currentTime = ${VIDEO_SECONDS - 5}
      const ok = await done
      return { ok, ms: Math.round(performance.now() - t), at: Math.round(v.currentTime), buffered: v.buffered.length }
    })()`)
    ok('[G] 影片拖到後段不用整份下載（Range 生效）', seek.ok && seek.at === VIDEO_SECONDS - 5, JSON.stringify(seek))
    await closeActive('影片')

    const previewState = () => cdp.eval(`(() => {
      const box = document.getElementById('wsEditorPreview')
      const m = box?.querySelector('audio, video')
      return JSON.stringify({ tabs: [...document.querySelectorAll('#wsTabStrip .ws-tab')].map((t) => t.textContent.trim() + (t.classList.contains('is-active') ? '*' : '')),
        boxHidden: box?.hidden, html: (box?.innerHTML || '').slice(0, 160), unsupported: !document.getElementById('wsEditorUnsupported').hidden,
        media: m ? { src: m.src.slice(0, 30), readyState: m.readyState, duration: m.duration, error: m.error?.code, net: m.networkState } : null })
    })()`)
    await openRow('long.wav')
    const audioOk = await waitInPage(cdp, `(() => { const a = document.querySelector('#wsEditorPreview audio'); return a && a.duration > ${AUDIO_SECONDS - 1} })()`, 30000)
    ok(`[G] ${(mediaSizes['long.wav'] / 1048576).toFixed(0)}MB 音訊載得起來`, audioOk, `${await elapsed()}ms ${audioOk ? '' : await previewState()}`)
    await closeActive('音訊')

    await openRow('big.pdf')
    const pdfOk = await waitInPage(cdp, `(() => {
      const c = document.querySelector('#wsEditorPreview .ws-pdf-canvas')
      return c && c.width > 0 && /第 1 \\/ ${PDF_PAGES} 頁/.test(document.querySelector('.ws-pdf-page')?.textContent || '')
    })()`, 60000)
    ok(`[G] ${(mediaSizes['big.pdf'] / 1048576).toFixed(1)}MB／${PDF_PAGES} 頁 PDF 畫得出第一頁`, pdfOk, `${await elapsed()}ms ${pdfOk ? '' : await previewState()}`)
    if (!pdfOk) throw new Error('PDF 沒畫出來，後面不用測了')
    await cdp.eval(`window.__t0 = performance.now(); [...document.querySelectorAll('.ws-pdf-bar button')].find((b) => b.textContent === '下一頁').click()`)
    ok('[G] PDF 翻頁', await waitInPage(cdp, `/第 2 \\/ /.test(document.querySelector('.ws-pdf-page')?.textContent || '')`, 15000), `${await elapsed()}ms`)
    await closeActive('PDF')
  } finally {
    if (cdp) cdp.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    await sleep(600)
    try { removeTree(USER_DATA_DIR) } catch { /* 檔案還被抓著 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通過`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
