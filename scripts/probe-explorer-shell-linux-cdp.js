#!/usr/bin/env node
/**
 * 探針（Linux）：打包好的 App 裡，檔案總管右鍵的壓縮／解壓縮、開啟方式、終端機、內容視窗（含 chmod）實際點一遍。
 * 用真的滑鼠事件（Input.dispatchMouseEvent），全部在 test-temp 底下；回收筒指到暫存的 XDG_DATA_HOME。
 * 會在目前的 DISPLAY 開一個終端機視窗又自己關掉。
 *
 *   npm run build && npx electron-builder --linux dir --publish never
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe-explorer-shell-linux-cdp.js
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { tempDir } = require('./lib/test-temp')

const PORT = 9293
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'linux-unpacked', 'axondeck')
const USER_DATA_DIR = tempDir('axondeck-probe-lxshell-')
const SEED = path.join(USER_DATA_DIR, 'seed')
const XDG_DATA = path.join(USER_DATA_DIR, 'xdg-data')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = false

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

function seed() {
  fs.mkdirSync(path.join(SEED, '專案', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(SEED, '專案', 'a.txt'), 'hello 世界\n')
  fs.writeFileSync(path.join(SEED, '專案', 'sub', 'b.bin'), Buffer.alloc(50_000, 1))
  fs.writeFileSync(path.join(SEED, 'note.txt'), 'note\n')
  fs.chmodSync(path.join(SEED, 'note.txt'), 0o644)
  const big = path.join(SEED, 'big')
  fs.mkdirSync(big)
  const chunk = require('crypto').randomBytes(4 * 1024 * 1024)
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(big, `r${i}.bin`), chunk.map((b, j) => (b ^ (i * 31 + j)) & 0xff))
  fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
  fs.writeFileSync(path.join(USER_DATA_DIR, 'explorer.json'), JSON.stringify({ uffsAuto: false, lastPath: SEED, view: 'list' }))
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    })
    req.setTimeout(2000, () => req.destroy(new Error('逾時')))
    req.on('error', reject)
  })
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(200)
  }
  throw new Error(`逾時：${label}`)
}

function connect(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const p = msg.id && pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({ ws, send, evaluate }))
    ws.addEventListener('error', () => reject(new Error('連不上 CDP')))
  })
}

const MENU = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  return el && el.offsetHeight > 0 ? [...el.querySelectorAll(':scope > .ws-menu-item')].map((n) => ({ label: n.textContent, disabled: n.disabled })) : null
})()`

async function mouse(cdp, box, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' })
  if (button === 'none') return
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button, clickCount: 1 })
}

async function rowBox(cdp, id) {
  return waitFor(() => cdp.evaluate(`(() => {
    const page = document.getElementById('page-explorer')
    if (!page.classList.contains('active')) document.querySelector('[data-page="explorer"]').click()
    const row = document.querySelector('#exList [data-id=${JSON.stringify(id)}]')
    if (!row || row.offsetHeight < 8) return null
    const r = row.getBoundingClientRect()
    return { x: r.left + 40, y: r.top + r.height / 2 }
  })()`), 20000, `列出 ${id}`)
}

async function menuOn(cdp, id) {
  await cdp.evaluate(`document.querySelector('.ws-menu') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(150)
  await mouse(cdp, await rowBox(cdp, id), 'right')
  return waitFor(() => cdp.evaluate(MENU('.ws-menu:not(.ws-menu-sub)')), 15000, `${id} 的右鍵選單`)
}

async function itemBox(cdp, label, sub = false) {
  return waitFor(() => cdp.evaluate(`(() => {
    const menu = document.querySelector(${JSON.stringify(sub ? '.ws-menu-sub' : '.ws-menu:not(.ws-menu-sub)')})
    const btn = menu && [...menu.querySelectorAll(':scope > .ws-menu-item')].find((n) => n.textContent.startsWith(${JSON.stringify(label)}))
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: r.left + 20, y: r.top + r.height / 2 }
  })()`), 8000, `選單項目 ${label}`)
}

async function pick(cdp, path_) {
  const [top, child] = path_
  const box = await itemBox(cdp, top)
  if (!child) { await mouse(cdp, box); return null }
  await mouse(cdp, box, 'none')
  const sub = await waitFor(() => cdp.evaluate(MENU('.ws-menu-sub')), 5000, `${top} 子選單`)
  const subBox = await itemBox(cdp, child, true)
  // 先水平移進子選單，避免斜切經過別的項目把子選單關掉
  await mouse(cdp, { x: subBox.x, y: box.y }, 'none')
  await mouse(cdp, subBox)
  return sub
}

const toastText = `(() => { const t = document.querySelector('.toast'); return t && !t.classList.contains('hidden') ? t.textContent.trim() : '' })()`

async function compressFlow(cdp) {
  const labels = (await menuOn(cdp, '專案')).map((i) => i.label)
  check('資料夾右鍵有「壓縮」「開啟方式」「在這裡開啟終端機」，「內容」只出現 App 自己那一個',
    labels.includes('壓縮') && labels.includes('開啟方式') && labels.includes('在這裡開啟終端機') && labels.filter((l) => /^內容/.test(l)).length === 1,
    labels.join(' / '))
  const sub = await pick(cdp, ['壓縮', '壓縮成 ZIP'])
  check('「壓縮」子選單列出 ZIP／7z／tar.gz', JSON.stringify(sub.map((s) => s.label)) === JSON.stringify(['壓縮成 ZIP', '壓縮成 7z', '壓縮成 tar.gz']), sub.map((s) => s.label).join(' / '))
  await waitFor(async () => fs.existsSync(path.join(SEED, '專案.zip')), 15000, '專案.zip')
  const toast = await waitFor(() => cdp.evaluate(toastText), 8000, '完成吐司').catch(() => '')
  await rowBox(cdp, '專案.zip')
  check('壓縮成 ZIP：產生 專案.zip、吐司、清單自動出現', toast === '壓縮完成', `吐司「${toast}」`)
  const list = execFileSync('unzip', ['-Z1', path.join(SEED, '專案.zip')], { encoding: 'utf8' }).trim().split('\n').sort()
  check('專案.zip 內容正確（unzip -Z1）', list.includes('專案/a.txt') && list.includes('專案/sub/b.bin'), list.join(', '))

  // 再壓一次 7z：不覆寫
  await menuOn(cdp, '專案')
  await pick(cdp, ['壓縮', '壓縮成 7z'])
  await waitFor(async () => fs.existsSync(path.join(SEED, '專案.7z')), 15000, '專案.7z')
  check('壓縮成 7z', true)
}

async function extractFlow(cdp) {
  const labels = (await menuOn(cdp, '專案.zip')).map((i) => i.label)
  check('壓縮檔右鍵有「解壓縮到這裡」「解壓縮到「專案/」」', labels.includes('解壓縮到這裡') && labels.includes('解壓縮到「專案/」'), labels.join(' / '))
  await pick(cdp, ['解壓縮到這裡'])
  const dialog = await waitFor(() => cdp.evaluate(`(() => { const d = document.querySelector('dialog.app-dialog[open]'); return d ? d.innerText : null })()`), 10000, '取代確認')
  check('解壓縮到這裡遇到同名：先跳確認（App 內對話框）', /取代 1 個同名項目/.test(dialog) && /專案/.test(dialog), dialog.replace(/\n+/g, ' | '))
  await cdp.evaluate(`[...document.querySelectorAll('dialog.app-dialog[open] .btn')].find((b) => b.textContent === '取消').click()`)
  await sleep(1200)
  check('按取消：什麼都沒動', !fs.existsSync(path.join(SEED, '專案 (2)')) && fs.readdirSync(path.join(SEED, '專案')).sort().join(',') === 'a.txt,sub')

  await menuOn(cdp, '專案.zip')
  await pick(cdp, ['解壓縮到「專案/」'])
  await waitFor(async () => fs.existsSync(path.join(SEED, '專案 (2)', 'sub', 'b.bin')), 15000, '專案 (2)')
  check('解壓縮到資料夾：同名變「專案 (2)」、單一同名頂層不多包一層', fs.existsSync(path.join(SEED, '專案 (2)', 'a.txt')))

  // 確認取代：舊的進（暫存的）垃圾桶
  fs.writeFileSync(path.join(SEED, '專案', 'a.txt'), 'OLD')
  await menuOn(cdp, '專案.zip')
  await pick(cdp, ['解壓縮到這裡'])
  await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.app-dialog[open]')`), 10000, '取代確認')
  await cdp.evaluate(`[...document.querySelectorAll('dialog.app-dialog[open] .btn')].find((b) => b.textContent === '取代').click()`)
  await waitFor(async () => fs.readFileSync(path.join(SEED, '專案', 'a.txt'), 'utf8') === 'hello 世界\n', 15000, '取代完成')
  const trashed = fs.existsSync(path.join(XDG_DATA, 'Trash', 'files', '專案', 'a.txt'))
  check('確認取代：新內容到位、舊的「專案」在垃圾桶（XDG_DATA_HOME 暫存）', trashed)
}

async function cancelFlow(cdp) {
  await menuOn(cdp, 'big')
  await pick(cdp, ['壓縮', '壓縮成 7z'])
  await waitFor(() => cdp.evaluate(`(() => { const t = document.querySelector('.ex-ops-toggle'); return t && /壓縮中/.test(t.textContent) ? t.textContent : null })()`), 10000, '狀態列顯示壓縮中')
  const chip = await cdp.evaluate(`document.querySelector('.ex-ops-toggle').textContent`)
  await cdp.evaluate(`document.querySelector('.ex-ops-toggle').click()`)
  await waitFor(() => cdp.evaluate(`!![...document.querySelectorAll('.ex-ops-card .btn')].find((b) => b.textContent === '取消')`), 5000, '取消鈕')
  await sleep(300)
  await cdp.evaluate(`[...document.querySelectorAll('.ex-ops-card .btn')].find((b) => b.textContent === '取消').click()`)
  const status = await waitFor(() => cdp.evaluate(`(() => { const s = document.querySelector('.ex-ops-card .ex-ops-status'); return s && /取消/.test(s.textContent) ? s.textContent : null })()`), 15000, '已取消').catch(() => '')
  await sleep(800)
  const leftovers = fs.readdirSync(SEED).filter((n) => n.startsWith('.axd-') || n === 'big.7z')
  check('壓縮進度在檔案操作面板、可取消，取消後不留半個檔案', Boolean(status) && leftovers.length === 0, `狀態列「${chip}」→「${status}」，殘留 ${JSON.stringify(leftovers)}`)
  await cdp.evaluate(`document.querySelector('.ex-ops-toggle').click()`)
}

async function propertiesFlow(cdp) {
  await menuOn(cdp, 'note.txt')
  await pick(cdp, ['內容'])
  const text = await waitFor(() => cdp.evaluate(`(() => { const d = document.querySelector('dialog.lx-props-dialog[open]'); return d ? d.innerText : null })()`), 10000, '內容視窗')
  const flat = text.replace(/\n+/g, ' | ')
  check('內容視窗：名稱／類型 MIME／位置／大小／三個時間／擁有者／群組／權限',
    ['note.txt', 'text/plain', SEED, '5 位元組', '建立時間', '修改時間', '存取時間', '擁有者', '群組', '權限'].every((w) => text.includes(w)), flat)
  const octal = await cdp.evaluate(`document.querySelector('.lx-perm-octal').value`)
  check('權限顯示 0644', octal === '0644', octal)
  // 勾掉「其他人讀取」「群組讀取」→ 0600 → 套用
  await cdp.evaluate(`(() => {
    for (const label of ['群組讀取', '其他人讀取']) {
      const box = document.querySelector('.lx-perm-grid input[aria-label="' + label + '"]')
      box.click()
    }
  })()`)
  const preview = await cdp.evaluate(`document.querySelector('.lx-perm-octal').value + ' ' + document.querySelector('.lx-perm-preview').textContent`)
  await cdp.evaluate(`[...document.querySelectorAll('.lx-props-dialog .btn')].find((b) => b.textContent === '套用權限').click()`)
  await waitFor(async () => (fs.statSync(path.join(SEED, 'note.txt')).mode & 0o777) === 0o600, 5000, 'chmod 0600').catch(() => null)
  const mode = (fs.statSync(path.join(SEED, 'note.txt')).mode & 0o777).toString(8)
  check('勾選框改權限 → 套用 → 檔案真的變 600', mode === '600', `預覽「${preview}」，實際 ${mode}`)
  await cdp.evaluate(`[...document.querySelectorAll('.lx-props-dialog .btn')].find((b) => b.textContent === '關閉').click()`)
  await sleep(300)

  await menuOn(cdp, '專案 (2)')
  await pick(cdp, ['內容'])
  const size = await waitFor(() => cdp.evaluate(`(() => { const d = document.querySelector('dialog.lx-props-dialog[open]'); const t = d && d.innerText; return t && /2 個檔案/.test(t) && !/計算中/.test(t) ? t : null })()`), 10000, '資料夾大小')
  check('資料夾內容：遞迴大小算完（2 個檔案、1 個資料夾）', /2 個檔案、1 個資料夾/.test(size), size.replace(/\n+/g, ' | ').slice(0, 300))
  await cdp.evaluate(`[...document.querySelectorAll('.lx-props-dialog .btn')].find((b) => b.textContent === '關閉').click()`)
  await sleep(300)
}

function terminalsUnder(dir) {
  const out = []
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { if (fs.readlinkSync(`/proc/${pid}/cwd`) === dir) out.push({ pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') }) } catch { /* 別人的 */ }
  }
  return out
}

async function openWithAndTerminal(cdp) {
  await menuOn(cdp, 'note.txt')
  const box = await itemBox(cdp, '開啟方式')
  await mouse(cdp, box, 'none')
  const apps = await waitFor(() => cdp.evaluate(MENU('.ws-menu-sub')), 5000, '開啟方式子選單').catch(() => [])
  check('「開啟方式」子選單列出這台機器上能開 text/plain 的應用程式', apps.length > 0, apps.map((a) => a.label).join(' / '))

  const dir = path.join(SEED, '專案')
  await menuOn(cdp, '專案')
  await pick(cdp, ['在這裡開啟終端機'])
  const shells = await waitFor(async () => {
    const list = terminalsUnder(dir).filter((p) => !/axondeck/.test(p.cmd))
    return list.length ? list : null
  }, 10000, '終端機').catch(() => [])
  check('在這裡開啟終端機：真的開了終端機，工作目錄是那個資料夾', shells.length > 0, shells.map((s) => `${s.pid} ${s.cmd}`).join('；'))
  for (const s of shells) { try { process.kill(s.pid, 'SIGTERM') } catch { /* 已結束 */ } }
}

async function main() {
  if (process.platform !== 'linux') { console.log('SKIP 不是 Linux'); return }
  if (!fs.existsSync(EXE)) { console.log(`SKIP 找不到 ${EXE}（先 electron-builder --linux dir）`); return }
  if (typeof WebSocket !== 'function') { console.log('SKIP 需要 Node 22+（用 ELECTRON_RUN_AS_NODE=1 electron 跑）'); return }
  seed()
  const env = { ...process.env, XDG_DATA_HOME: XDG_DATA }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, ['--hidden', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore', env, detached: true })
  try {
    const target = await waitFor(async () => (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && /index\.html/.test(t.url)), 40000, '主視窗')
    const cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
    await waitFor(() => cdp.evaluate(`typeof window.electronAPI?.explorer?.linuxProperties === 'function'`), 20000, 'preload')
    await compressFlow(cdp)
    await extractFlow(cdp)
    await cancelFlow(cdp)
    await propertiesFlow(cdp)
    await openWithAndTerminal(cdp)
    cdp.ws.close()
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已結束 */ }
    await sleep(1500)
  }
  if (failed) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
