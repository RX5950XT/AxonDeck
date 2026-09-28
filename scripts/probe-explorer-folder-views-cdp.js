#!/usr/bin/env node
/**
 * VoiceInk — 檔案頁「每個資料夾各自記住檢視／大小／排序」＋ Google Drive 綠勾（打包版 CDP）
 *
 * [1] A 資料夾 Ctrl+滾輪放大、改排序；B 沒調過還是預設；回 A 還是調過的樣子
 * [2] 關掉重開，A 的樣子還在（explorer.json 的 folderViews）
 * [3] 有 G:\我的雲端硬碟 才測：方格縮圖疊上同步標記（`.ex-row-overlay`），沒有就 SKIP
 *
 * 暫存資料夾與 userData 測完刪掉；收尾只 taskkill 自己的 pid。
 * 用法：node scripts/probe-explorer-folder-views-cdp.js（先 npm run electron:pack）
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { tempDir, removeTree } = require('./lib/test-temp')

const PORT = 9291
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const DRIVE_DIR = 'G:\\我的雲端硬碟'
const USER_DATA_DIR = tempDir('voiceink-e2e-fv-')
const DIR_A = path.join(USER_DATA_DIR, 'folder-a')
const DIR_B = path.join(USER_DATA_DIR, 'folder-b')
for (const dir of [DIR_A, DIR_B]) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'small.txt'), 'x')
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(5000))
}
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.writeFileSync(path.join(USER_DATA_DIR, 'explorer.json'), JSON.stringify({
  uffsAuto: false,
  lastPath: DIR_A,
  view: 'list',
  tile: 96,
  sort: 'name',
  sortDesc: false
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
    return list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
  }, 20_000, '主視窗')
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await waitFor(() => cdp.eval('document.readyState === \'complete\' && !!document.querySelector(\'[data-page="explorer"]\')'),
    20_000, 'preload')
  await cdp.eval('document.querySelector(\'[data-page="explorer"]\').click()')
  return { child, cdp }
}

function stop(app) {
  app?.cdp?.close()
  if (app?.child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
  }
}

/** 目前左欄的樣子：停在哪、方格或清單、圖示大小、排序 */
const look = (cdp) => cdp.eval(`(() => {
  const list = document.getElementById('exList')
  return {
    path: document.getElementById('exPathInput')?.value || '',
    rows: document.querySelectorAll('#exList .ex-row').length,
    grid: list.classList.contains('is-grid'),
    tile: Number(list.dataset.tile),
    sort: document.getElementById('exSort')?.value,
    first: document.querySelector('#exList .ex-row')?.dataset.name || ''
  }
})()`)

async function go(cdp, dir) {
  await cdp.eval(`(() => {
    const input = document.getElementById('exPathInput')
    input.value = ${JSON.stringify(dir)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })()`)
  await waitFor(async () => {
    const state = await cdp.eval(`[...document.querySelectorAll('#exList .ex-row')].map((row) => row.dataset.path)`)
    return state.length && state.every((p) => p.toLowerCase().startsWith(dir.toLowerCase() + '\\'))
  }, 15_000, `進到 ${dir}`)
  await sleep(300)
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
    await waitFor(async () => (await look(cdp)).rows >= 2, 20_000, 'A 列出來')

    console.log('\n[1] 每個資料夾各自記')
    // 清單 → 往上滾兩格 → 方格第二級（64）
    for (let i = 0; i < 2; i++) {
      await cdp.eval(`document.getElementById('exList').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }))`)
      await sleep(250)
    }
    await cdp.eval(`(() => { const s = document.getElementById('exSort'); s.value = 'size'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await waitFor(async () => (await look(cdp)).first === 'small.txt', 10_000, 'A 照大小排')
    const a1 = await look(cdp)
    check(a1.grid && a1.tile === 64 && a1.sort === 'size', 'A 調成方格 64、照大小排', JSON.stringify(a1))

    await go(cdp, DIR_B)
    const b1 = await look(cdp)
    check(!b1.grid && b1.sort === 'name' && b1.first === 'big.txt', 'B 沒調過還是清單、照名稱排', JSON.stringify(b1))

    await go(cdp, DIR_A)
    const a2 = await look(cdp)
    check(a2.grid && a2.tile === 64 && a2.sort === 'size' && a2.first === 'small.txt', '回到 A 還是方格 64、照大小排', JSON.stringify(a2))

    stop(app)
    app = null
    await sleep(1500)
    const saved = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, 'explorer.json'), 'utf8'))
    const keyA = DIR_A.replace(/\\+$/, '').toLowerCase()
    check(saved.folderViews?.[keyA]?.tile === 64 && saved.folderViews[keyA].sort === 'size', 'explorer.json 記下 A', JSON.stringify(saved.folderViews))
    check(saved.view === 'list' && saved.tile === 96 && saved.sort === 'name', '全域預設沒被 A 蓋掉', JSON.stringify({ view: saved.view, tile: saved.tile, sort: saved.sort }))

    console.log('\n[2] 重開後還在')
    app = await launch()
    await waitFor(async () => (await look(app.cdp)).rows >= 2, 20_000, '重開後 A 列出來')
    const a3 = await look(app.cdp)
    check(a3.grid && a3.tile === 64 && a3.sort === 'size', '重開後 A 還是方格 64、照大小排', JSON.stringify(a3))

    console.log('\n[3] Google Drive 綠勾')
    if (!fs.existsSync(DRIVE_DIR)) {
      console.log(`  SKIP 沒有 ${DRIVE_DIR}`)
    } else {
      await go(app.cdp, DRIVE_DIR)
      // 清單圖示本來就帶標記（SHGFI_ADDOVERLAYS）；要測的是方格縮圖
      await app.cdp.eval(`document.getElementById('exViewGridBtn').click()`)
      const count = await waitFor(() => app.cdp.eval(`document.querySelectorAll('#exList .ex-row-overlay').length`),
        20_000, '方格縮圖上的同步標記').catch(() => 0)
      check(count > 0, '方格縮圖疊上同步標記', `${count} 個`)
    }
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
