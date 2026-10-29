#!/usr/bin/env node
/**
 * AxonDeck — 檔案頁：資料夾裡有檔案一直在長大（WinRAR 壓縮中）時，畫面不准跳回最上面（打包版 CDP）
 *
 * [1] 一般清單（150 檔）：捲到中間，邊寫邊看 4 秒，scrollTop 不變、大小有跟著更新
 * [2] 虛擬清單（1200 檔，超過一頁 500）：捲到第 800 列附近，同樣邊寫邊看，位置不變、列不會變空白
 *
 * 暫存資料夾與 userData 測完刪掉；收尾只 taskkill 自己的 pid。
 * 用法：node scripts/probe-explorer-watch-scroll-cdp.js（先 npm run electron:pack）
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { tempDir, removeTree } = require('./lib/test-temp')

const PORT = 9293
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')
const USER_DATA_DIR = tempDir('axondeck-e2e-ws-')
const DIR_SMALL = path.join(USER_DATA_DIR, 'small')
const DIR_BIG = path.join(USER_DATA_DIR, 'big')

function fill(dir, count) {
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x')
}
fill(DIR_SMALL, 150)
fill(DIR_BIG, 1200)
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.writeFileSync(path.join(USER_DATA_DIR, 'explorer.json'), JSON.stringify({
  uffsAuto: false, lastPath: DIR_SMALL, view: 'list', tile: 96, sort: 'name', sortDesc: false
}))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 連不上')))
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 逾時：${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    for (const item of this.pending.values()) clearTimeout(item.timer)
    try { this.ws.close() } catch { /* 已關 */ }
  }
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(200)
  }
  throw new Error(`逾時：${label}`)
}

let failed = 0
function check(cond, name, detail) {
  if (cond) console.log(`  PASS ${name}`)
  else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function launch() {
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`],
    { stdio: 'ignore' })
  await waitFor(async () => {
    try { return await getJson(`http://127.0.0.1:${PORT}/json/version`) } catch { return null }
  }, 40_000, 'CDP 起來')
  const target = await waitFor(async () => {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    return list.find((t) => t.type === 'page' && /index\.html/.test(t.url) && /host=1/.test(t.url))
  }, 20_000, '主視窗')
  const host = new Cdp(target.webSocketDebuggerUrl)
  await host.connect()
  await waitFor(() => host.eval('document.readyState === \'complete\' && !!document.querySelector(\'[data-page="explorer"]\')'),
    20_000, 'nav')
  await host.eval('document.querySelector(\'[data-page="explorer"]\').click()')
  // 每個功能頁是獨立 renderer：檔案頁要另外連它自己那份
  const page = await waitFor(async () => {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    return list.find((t) => t.url.includes('page=explorer'))
  }, 20_000, '檔案頁 renderer')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  host.close()
  return { child, cdp }
}

function stop(app) {
  app?.cdp?.close()
  if (app?.child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
  }
}

async function go(cdp, dir) {
  await cdp.eval(`(() => {
    const input = document.getElementById('exPathInput')
    input.value = ${JSON.stringify(dir)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })()`)
  await waitFor(async () => {
    const paths = await cdp.eval(`[...document.querySelectorAll('#exList .ex-row')].map((row) => row.dataset.path)`)
    return paths.length && paths.every((p) => p.toLowerCase().startsWith(dir.toLowerCase() + '\\'))
  }, 15_000, `進到 ${dir}`)
  await sleep(500)
}

const listState = (cdp) => cdp.eval(`(() => {
  const list = document.getElementById('exList')
  if (!list) return { top: 0, height: 0, mid: '' }
  const rect = list.getBoundingClientRect()
  const mid = document.elementFromPoint(rect.left + 60, rect.top + rect.height / 2)?.closest('.ex-row')
  return { top: list.scrollTop, height: list.scrollHeight, mid: mid?.dataset.name || '' }
})()`)

/** 模擬壓縮中：每 150ms 往檔案尾巴加一段，持續 ms 毫秒；期間一直取樣 scrollTop */
async function growWhileWatching(cdp, file, ms) {
  const samples = []
  const end = Date.now() + ms
  let n = 0
  while (Date.now() < end) {
    fs.appendFileSync(file, 'y'.repeat(4096 * ++n))
    samples.push(await listState(cdp))
    await sleep(150)
  }
  await sleep(1500) // 等最後一批監看事件落地
  samples.push(await listState(cdp))
  return samples
}

async function scenario(cdp, label, dir, targetTop, growName) {
  console.log(`\n${label}`)
  await go(cdp, dir)
  await cdp.eval(`(() => { const l = document.getElementById('exList'); l.scrollTop = ${targetTop}; l.dispatchEvent(new Event('scroll')) })()`)
  await sleep(1200)
  const before = await listState(cdp)
  check(before.top > 0, '捲得下去', JSON.stringify(before))
  const samples = await growWhileWatching(cdp, path.join(dir, growName), 4000)
  const jumped = samples.filter((s) => Math.abs(s.top - before.top) > 2)
  check(!jumped.length, '寫檔期間 scrollTop 沒跳', jumped.length ? `${jumped.length}/${samples.length} 次跳，例：${JSON.stringify(jumped[0])}，原本 ${before.top}` : '')
  const last = samples.at(-1)
  check(last.mid === before.mid, '中間那列還是同一個檔', `前 ${before.mid} 後 ${last.mid}`)
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log(`SKIP 找不到 ${EXE}（先 npm run electron:pack）`)
    return
  }
  let app = null
  try {
    app = await launch()
    const { cdp } = app
    await waitFor(() => cdp.eval(`!!document.getElementById('exPathInput')`), 20_000, '檔案頁載好')
    await go(cdp, DIR_SMALL)
    console.log('  版面', JSON.stringify(await cdp.eval(`(() => { const l = document.getElementById('exList'); return { client: l.clientHeight, scroll: l.scrollHeight, rows: l.querySelectorAll('.ex-row').length } })()`)))
    await scenario(cdp, '[1] 一般清單 150 檔', DIR_SMALL, 2000, 'f0010.txt')
    // 監看真的有把新大小畫上去（不是靠「不重畫」矇混過關）
    const sizeText = await cdp.eval(`document.querySelector('#exList .ex-row[data-name="f0010.txt"]')?.textContent || ''`)
    check(!/^\s*$/.test(sizeText) && !/\b1 B\b/.test(sizeText), '長大的檔案大小有更新', sizeText.replace(/\s+/g, ' ').slice(0, 80))
    await scenario(cdp, '[2] 虛擬清單 1200 檔', DIR_BIG, 34 * 800, 'f0790.txt')
  } finally {
    stop(app)
    await sleep(800)
    removeTree(USER_DATA_DIR)
  }
  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過')
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
