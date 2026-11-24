/**
 * 打包版 CDP：語音轉文字頁的緊湊版面、字幕紀錄閱讀視窗、字幕視窗選取、半透明反白。
 * 用法：node scripts/e2e-stt-compact-cdp.js；設 AXONDECK_SHOT_DIR 會存截圖。
 *
 * 暫存 user-data-dir，視窗放到螢幕外（不擋使用者、不搶焦點）。沒有呼叫任何模型。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { tempDir } = require('./lib/test-temp')

const PORT = 9267
const MAIN_PORT = PORT + 1
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')
const USER_DATA_DIR = tempDir('axondeck-stt-compact-')
const SHOT_DIR = process.env.AXONDECK_SHOT_DIR || ''
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (!msg.id || !this.pending.has(msg.id)) return
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    })
    await this.send('Runtime.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  async shot(name) {
    if (!SHOT_DIR) return
    const r = await Promise.race([this.send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => null)])
    if (!r) return console.log(`      截圖逾時 ${name}`)
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'))
    console.log(`      截圖 ${name}`)
  }
  async drag(from, to) {
    const mouse = (type, point, extra = {}) => this.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra })
    await mouse('mouseMoved', from)
    await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 })
    await mouse('mouseMoved', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, { button: 'left', buttons: 1 })
    await mouse('mouseMoved', to, { button: 'left', buttons: 1 })
    await mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 })
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}
require('./lib/page-cdp').followMainPage(Cdp)

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await action()
    if (value) return value
    await sleep(200)
  }
  throw new Error(`等待逾時：${label}`)
}

const ALPHA = /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*(0?\.\d+)\s*\)/
const selectionAlpha = (css) => Number(ALPHA.exec(css || '')?.[1] ?? NaN)
const isTranslucent = (css) => {
  const alpha = selectionAlpha(css)
  return alpha > 0.1 && alpha < 0.6
}

async function checkLayout(cdp, ok) {
  for (const width of [1400, 1000]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(200)
    const size = await cdp.eval(`(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } }
      const trigger = (id) => document.getElementById(id).closest('.custom-select').querySelector('.custom-select-trigger')
      return {
        drop: box(document.getElementById('dropZone')),
        heroes: ['.stt-drop', '.stt-rec-hero', '.stt-live-card'].map((s) => box(document.querySelector(s))),
        rec: box(document.getElementById('recStartBtn')), live: box(document.getElementById('startLiveBtn')),
        recStatus: box(document.getElementById('recStatus')), recSource: box(trigger('recAudioSource')),
        liveStatus: box(document.getElementById('liveStatus')), liveSource: box(trigger('liveAudioSource')),
        lists: ['txHistoryList', 'recList', 'liveHistoryList'].map((id) => box(document.getElementById(id))),
        overflow: document.querySelector('.content').scrollWidth > document.querySelector('.content').clientWidth + 1
      }
    })()`)
    const line = JSON.stringify(size)
    ok(`${width}px 頂部三張卡都很矮（≤72px），省下的給紀錄`, size.heroes.every((h) => h.h <= (width >= 1400 ? 72 : 112)), line)
    ok(`${width}px 三張卡頂部對齊、沒有橫向溢出`, size.heroes.every((h) => Math.abs(h.y - size.heroes[0].y) < 1) && !size.overflow, line)
    ok(`${width}px 按鈕變小（≤36px 高）`, size.rec.h <= 36 && size.live.h <= 36, line)
    if (width >= 1400) {
      const inOneRow = (a, b) => a.y < b.bottom && b.y < a.bottom
      ok(`${width}px 錄音：按鈕、狀態、音源同一條`, inOneRow(size.rec, size.recStatus) && inOneRow(size.rec, size.recSource) && size.recStatus.x >= size.rec.right && size.recSource.x >= size.recStatus.right - 1, line)
      ok(`${width}px 字幕：按鈕、狀態、音源同一條`, inOneRow(size.live, size.liveStatus) && inOneRow(size.live, size.liveSource) && size.liveStatus.x >= size.live.right && size.liveSource.x >= size.liveStatus.right - 1, line)
    }
    ok(`${width}px 紀錄清單吃滿第一屏（≥500px）`, size.lists.every((l) => l.h >= 500), line)
    await cdp.shot(`stt-${width}.png`)
  }
  for (const width of [760, 560]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
    await sleep(200)
    const wide = await cdp.eval(`(() => {
      const content = document.querySelector('.content')
      const limit = content.getBoundingClientRect().right + 1
      return {
        overflow: content.scrollWidth > content.clientWidth + 1,
        scrollWidth: content.scrollWidth, clientWidth: content.clientWidth,
        offenders: [...document.querySelectorAll('#page-stt *')]
          .filter((el) => el.offsetParent && el.getBoundingClientRect().right > limit)
          .slice(0, 8).map((el) => el.tagName + '#' + el.id + '.' + el.className + ':' + Math.round(el.getBoundingClientRect().right))
      }
    })()`)
    ok(`${width}px 窄視窗沒有橫向溢出`, !wide.overflow, JSON.stringify(wide))
    await cdp.shot(`stt-${width}.png`)
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.eval(`document.getElementById('dropZone').classList.add('dragover'), 'ok'`)
  const drop = await cdp.eval(`(() => { const s = getComputedStyle(document.getElementById('dropZone')); return { border: s.borderTopColor, bg: s.backgroundColor } })()`)
  await cdp.eval(`document.getElementById('dropZone').classList.remove('dragover'), 'ok'`)
  const idle = await cdp.eval(`getComputedStyle(document.getElementById('dropZone')).backgroundColor`)
  ok('拖放回饋還在（dragover 底色跟平常不同）', drop.bg !== idle, JSON.stringify({ drop, idle }))
  ok('狀態列沒有卡片套卡片（底色透明）', await cdp.eval(`getComputedStyle(document.getElementById('recStatus')).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.getElementById('recStatus')).borderTopWidth === '0px'`))
}

async function checkSelection(cdp, ok) {
  for (const theme of ['dark', 'light']) {
    await cdp.eval(`document.documentElement.setAttribute('data-theme', '${theme}'), 'ok'`)
    const css = await cdp.eval(`getComputedStyle(document.querySelector('.stt-board h3'), '::selection').backgroundColor`)
    ok(`主視窗 ${theme} 反白半透明`, isTranslucent(css), css)
    const speech = await cdp.eval(`getComputedStyle(document.body, '::selection').backgroundColor`)
    ok(`${theme} 全域規則套到 body`, isTranslucent(speech), speech)
    if (theme === 'light') await cdp.shot('stt-light.png')
  }
  await cdp.eval(`document.documentElement.setAttribute('data-theme', 'dark'), 'ok'`)
}

async function checkReader(cdp, ok) {
  const started = Date.now() - 754000
  const id = `live-${started}`
  await cdp.eval(`(async () => {
    const api = window.electronAPI.sttArchive
    const rows = [
      ['今天我們要討論 Kubernetes 的排程機制', ''],
      ['In today\\'s meeting we will review the launch schedule for next month.', '在今天的會議中，我們將檢視下個月的上市時程。'],
      ['本日の会議では広告予算の配分について話し合います。', '今天的會議會討論廣告預算的分配。'],
      ['and discuss how the marketing budget should be allocated, including a very long sentence that has to wrap across several lines in the reader without overflowing the dialog at all.', '並討論行銷預算應如何分配，這句話特別長，要確認在閱讀視窗裡會正常換行，不會超出視窗範圍，也不會把時間欄擠歪。']
    ]
    for (const [i, [source, translation]] of rows.entries()) {
      await api.appendTranscript('${id}', { key: 'b-' + i, source, translation })
    }
  })()`)
  await cdp.eval(`import('./scripts/live-history.js').then((m) => m.refreshLiveHistory())`)
  await waitFor(() => cdp.eval(`document.querySelectorAll('#liveHistoryList .rec-item').length === 1`), 8000, '字幕紀錄一筆')
  await cdp.shot('stt-history-list.png')
  await cdp.eval(`document.querySelector('#liveHistoryList [data-act="view"]').click(), 'ok'`)
  await waitFor(() => cdp.eval(`document.getElementById('sttReader').open`), 5000, '閱讀視窗打開')
  await sleep(250)
  const view = await cdp.eval(`(() => {
    const dialog = document.getElementById('sttReader')
    const rows = [...dialog.querySelectorAll('.stt-reader-row')]
    return {
      rows: rows.length,
      title: document.getElementById('sttReaderTitle').textContent,
      meta: document.getElementById('sttReaderMeta').textContent,
      first: rows[0].textContent,
      second: { source: rows[1].querySelector('.stt-reader-source').textContent, main: rows[1].querySelector('.stt-reader-main').textContent },
      times: rows.map((r) => r.querySelector('.stt-reader-time').textContent),
      firstHasSource: !!rows[0].querySelector('.stt-reader-source'),
      overflowX: dialog.querySelector('.stt-reader-body').scrollWidth > dialog.querySelector('.stt-reader-body').clientWidth + 1,
      width: dialog.getBoundingClientRect().width,
      centered: Math.abs((dialog.getBoundingClientRect().left + dialog.getBoundingClientRect().right) / 2 - innerWidth / 2) < 2,
      mainSize: parseFloat(getComputedStyle(rows[1].querySelector('.stt-reader-main')).fontSize),
      sourceSize: parseFloat(getComputedStyle(rows[1].querySelector('.stt-reader-source')).fontSize),
      selection: getComputedStyle(rows[1].querySelector('.stt-reader-main'), '::selection').backgroundColor
    }
  })()`)
  const line = JSON.stringify(view)
  ok('閱讀視窗：一句一列、有標題與長度', view.rows === 4 && view.title && /4 句/.test(view.meta) && /分鐘/.test(view.meta), line)
  ok('閱讀視窗：沒譯文只顯示原文一行，有譯文原文在上小字', !view.firstHasSource && view.second.main.includes('會議') && view.second.source.startsWith('In today') && view.mainSize > view.sourceSize, line)
  ok('閱讀視窗：每句都有時間', view.times.every((t) => /^\d\d:\d\d$/.test(t)), line)
  ok('閱讀視窗：置中、長句不溢出', view.centered && !view.overflowX && view.width >= 600, line)
  ok('閱讀視窗：反白半透明', isTranslucent(view.selection), view.selection)
  await cdp.shot('stt-reader.png')
  await cdp.eval(`document.documentElement.setAttribute('data-theme', 'light'), 'ok'`)
  await sleep(150)
  await cdp.shot('stt-reader-light.png')
  await cdp.eval(`document.documentElement.setAttribute('data-theme', 'dark'), 'ok'`)

  const box = await cdp.eval(`(() => { const r = document.querySelector('.stt-reader-main').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  await cdp.drag({ x: box.x + 2, y: box.y + box.h / 2 }, { x: box.x + 200, y: box.y + box.h / 2 })
  const picked = await cdp.eval(`String(window.getSelection())`)
  ok('閱讀視窗：真滑鼠選得到字', picked.length > 0, picked)
  await cdp.shot('stt-reader-select.png')

  await cdp.eval(`document.getElementById('sttReaderClose').click(), 'ok'`)
  ok('閱讀視窗：關閉鈕有效', await cdp.eval(`!document.getElementById('sttReader').open`))
  ok('關閉後視窗真的不佔版面', await cdp.eval(`document.getElementById('sttReader').offsetHeight === 0`))
  await cdp.eval(`document.querySelector('#liveHistoryList [data-act="delete"]').click(), 'ok'`)
  await waitFor(() => cdp.eval(`!!document.querySelector('#liveHistoryList .dict-empty')`), 5000, '刪掉後變空')
}

async function checkSubtitleWindow(cdp, mainCdp, ok) {
  const send = (payload) => cdp.eval(`window.electronAPI.subtitle.update(${JSON.stringify(payload)})`)
  await cdp.eval(`window.electronAPI.subtitle.show()`)
  const page = await waitFor(async () => {
    const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
    return pages.find((p) => /subtitle\.html/.test(p.url))
  }, 10000, '字幕視窗')
  await waitFor(() => mainCdp.eval(`(() => {
    const { BrowserWindow } = process.mainModule.require('electron')
    const win = BrowserWindow.getAllWindows().find((w) => /subtitle\\.html/.test(w.webContents.getURL()))
    if (!win) return false
    win.setPosition(-3000, -3000)
    win.setSize(760, 420)
    return true
  })()`), 5000, '字幕視窗移到螢幕外')
  const sub = new Cdp(page.webSocketDebuggerUrl)
  await sub.connect()
  await sub.send('Page.enable')
  await sub.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await waitFor(() => sub.eval(`document.readyState === 'complete'`), 5000, '字幕頁')
  ok('字幕區可選取（user-select: text）', await sub.eval(`getComputedStyle(document.getElementById('subtitleHistory')).userSelect === 'text'`))

  await send({ id: 'l1', source: '第一句的原文內容', translation: '第一句譯文內容', action: 'upsert', interim: false })
  await send({ id: 'l2', source: '第二句還在聽的內容', translation: '', action: 'upsert', interim: true })
  await sleep(200)
  ok('還在聽的那句有標記', await sub.eval(`document.querySelector('[data-id="l2"]').classList.contains('interim') && !document.querySelector('[data-id="l1"]').classList.contains('interim')`))
  await sub.shot('subtitle-window.png')

  const nodeBefore = await sub.eval(`(window.__l2 = document.querySelector('[data-id="l2"]'), 'ok')`)
  await send({ id: 'l2', source: '第二句還在聽的內容變長了', translation: '', action: 'upsert', interim: true })
  await sleep(150)
  ok('字幕更新是就地改字（節點沒被換掉）', nodeBefore === 'ok' && await sub.eval(`window.__l2 === document.querySelector('[data-id="l2"]') && window.__l2.textContent.includes('變長了')`))

  const box = await sub.eval(`(() => { const r = document.querySelector('[data-id="l1"] .subtitle-translation').getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height } })()`)
  await sub.drag({ x: box.x + 1, y: box.y + box.h / 2 }, { x: box.x + 90, y: box.y + box.h / 2 })
  const picked = await sub.eval(`String(window.getSelection())`)
  ok('真滑鼠選得到字幕', picked.length > 0, picked)
  const color = await sub.eval(`getComputedStyle(document.querySelector('.subtitle-translation'), '::selection').backgroundColor`)
  ok('字幕視窗反白半透明', /color\(srgb/.test(color) || isTranslucent(color), color)
  await sub.shot('subtitle-select.png')

  await send({ id: 'l2', source: '第二句又變了一次', translation: '', action: 'upsert', interim: true })
  await send({ id: 'l1', source: '第一句被修正', translation: '第一句譯文被修正', action: 'upsert', interim: false })
  await send({ id: 'l3', source: '新來的第三句', translation: '', action: 'upsert', interim: true })
  await sleep(200)
  const during = await sub.eval(`({
    picked: String(window.getSelection()),
    l1: document.querySelector('[data-id="l1"]').textContent,
    l2: document.querySelector('[data-id="l2"]').textContent,
    l3: !!document.querySelector('[data-id="l3"]')
  })`)
  ok('選取中字幕繼續進來：選取不被打斷、被選的那行先不改、其他行照常', during.picked === picked && !during.l1.includes('修正') && during.l2.includes('又變了') && during.l3, JSON.stringify(during))

  const copied = await sub.eval(`new Promise((resolve) => {
    document.addEventListener('copy', (e) => { e.preventDefault(); resolve(String(window.getSelection())) }, { once: true })
    setTimeout(() => resolve('timeout'), 1500)
    window.__copyArmed = true
  })`.replace('new Promise', 'window.__copied = new Promise') + ', "armed"')
  await sub.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2, commands: ['copy'] })
  await sub.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  const copiedText = await sub.eval(`window.__copied`)
  ok('Ctrl+C 複製得到選的字（沒動到剪貼簿）', copied === 'armed' && copiedText === picked, copiedText)

  await sub.eval(`window.getSelection().removeAllRanges(), 'ok'`)
  await sleep(200)
  ok('取消選取後補上被擋的更新', await sub.eval(`document.querySelector('[data-id="l1"]').textContent.includes('修正')`))

  await cdp.eval(`(async () => {
    for (let i = 0; i < 55; i++) {
      await window.electronAPI.subtitle.update({
        id: 'qa-' + i,
        source: i === 54 ? '<img src=x onerror=alert(1)> 字幕' : '測試字幕 ' + i,
        translation: 'translation ' + i,
        action: 'upsert'
      })
    }
  })()`)
  await sleep(500)
  const dom = await sub.eval(`(() => {
    const history = document.getElementById('subtitleHistory')
    const atBottom = history.scrollHeight - history.clientHeight - history.scrollTop <= 24
    history.scrollTop = 0
    return {
      rows: history.querySelectorAll('.subtitle-line').length,
      images: history.querySelectorAll('img').length,
      raw: history.textContent.includes('<img src=x'),
      atBottom
    }
  })()`)
  ok('字幕：50 行上限、純文字不注入、沒選取時跟著捲到底', dom.rows === 50 && dom.images === 0 && dom.raw && dom.atBottom, JSON.stringify(dom))
  await cdp.eval(`window.electronAPI.subtitle.update({ id: 'qa-54', source: '最後一行更新', translation: 'updated', action: 'upsert' })`)
  await sleep(200)
  ok('字幕：使用者往上捲時更新不搶位置', await sub.eval(`document.getElementById('subtitleHistory').scrollTop`) === 0)
  ok('字幕視窗沒有例外', sub.exceptions.length === 0, sub.exceptions.join('; '))
  sub.close()
  await cdp.eval(`window.electronAPI.subtitle.close()`)
}

async function main() {
  if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`, `--inspect=${MAIN_PORT}`, `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-backgrounding-occluded-windows'
  ], { detached: true, stdio: 'ignore' })
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) } else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
  }
  let cdp = null
  let mainCdp = null
  try {
    const target = await waitFor(async () => {
      const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
      return pages.filter((p) => p.type === 'page').find((p) => /index\.html/.test(p.url))
    }, 30000, '主視窗')
    mainCdp = new Cdp((await getJson(`http://127.0.0.1:${MAIN_PORT}/json/list`))[0].webSocketDebuggerUrl)
    await mainCdp.connect()
    await mainCdp.eval(`(() => {
      const { BrowserWindow } = process.mainModule.require('electron')
      for (const win of BrowserWindow.getAllWindows()) { win.setPosition(-3000, -3000); win.showInactive() }
    })()`)
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!window.electronAPI?.sttArchive`), 15000, 'preload')
    await cdp.eval(`document.querySelector('[data-page="stt"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.getElementById('fileAsrModel')?.options.length`), 15000, '語音轉文字頁')
    await waitFor(() => cdp.eval(`!!document.querySelector('#recList .dict-empty')`), 10000, '錄音清單')
    await sleep(400)

    await checkLayout(cdp, ok)
    await checkSelection(cdp, ok)
    await checkReader(cdp, ok)
    await checkSubtitleWindow(cdp, mainCdp, ok)
    ok('主視窗沒有例外', cdp.exceptions.length === 0, cdp.exceptions.join('; '))
  } finally {
    cdp?.close()
    mainCdp?.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    child.kill()
  }
  console.log(`\n${failed ? 'FAILED' : 'ALL PASS'}  ${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
