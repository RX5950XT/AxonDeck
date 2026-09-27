#!/usr/bin/env node
/**
 * 探針：在檔案列上按右鍵 →「內容」，跳出來的 Windows 內容視窗要是「那個檔案」的，
 * 不是目前資料夾的（滑鼠、選單鍵／Shift+F10、圖示檢視、本機首頁的磁碟卡片都要）。
 * 用真的滑鼠／鍵盤事件（Input.dispatch*），驗完把視窗關掉。
 * 順便看右側詳細資訊有沒有依類型補上影片（ffmpeg）、程式（屬性系統）、文字那幾段。
 *
 * 會跳出幾個 Windows「內容」視窗又自己關掉。
 *
 *   node scripts/probe-explorer-menu-target-cdp.js
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { tempDir, removeTree } = require('./lib/test-temp')

const PORT = 9291
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-probe-menu-')
const SEED_DIR = path.join(USER_DATA_DIR, 'seed-folder')
fs.mkdirSync(path.join(SEED_DIR, 'sub'), { recursive: true })
fs.writeFileSync(path.join(SEED_DIR, 'target-file.txt'), 'hello\r\nworld\r\n')
fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe'), path.join(SEED_DIR, 'tool.exe'))
execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(SEED_DIR, 'clip.mp4')])
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.writeFileSync(path.join(USER_DATA_DIR, 'explorer.json'), JSON.stringify({ uffsAuto: false, lastPath: SEED_DIR, view: 'list' }))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MENU_LABELS = `(() => {
  const el = document.querySelector('.ws-menu')
  return el && el.offsetHeight > 0 ? [...el.querySelectorAll('.ws-menu-item')].map((n) => n.textContent) : null
})()`

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

/** 列出所有標題含「內容」／Properties 的可見頂層視窗（標題＋hwnd）。 */
function propertyWindows() {
  const ps = `
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W {
  delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public static List<string> All() { var o = new List<string>(); EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var s = new StringBuilder(512); GetWindowText(h, s, 512); var t = s.ToString(); if (t.Contains("內容") || t.Contains("Properties")) o.Add(h.ToInt64() + "|" + t); return true; }, IntPtr.Zero); return o; }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[W]::All()`
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  return out.split(/\r?\n/).filter(Boolean).map((l) => ({ hwnd: l.split('|')[0], title: l.slice(l.indexOf('|') + 1) }))
}

function closeWindow(hwnd) {
  const ps = `Add-Type -Name U -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [N.U]::PostMessage([IntPtr]${hwnd}, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`
  execFileSync('powershell', ['-NoProfile', '-Command', ps])
}

async function rightClickAt(cdp, box) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'right', clickCount: 1 })
  }
  return waitFor(() => cdp.evaluate(MENU_LABELS), 15000, '右鍵選單')
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

async function keyboardMenu(cdp, id) {
  await rowBox(cdp, id)
  await cdp.evaluate(`document.querySelector('#exList [data-id=${JSON.stringify(id)}]').click(); document.getElementById('exList').focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 })
  return waitFor(() => cdp.evaluate(MENU_LABELS), 15000, '鍵盤選單')
}

/** 點選單的「內容」，等新的內容視窗，比標題後關掉。 */
async function checkProperties(cdp, before, name, expect) {
  await cdp.evaluate(`[...document.querySelectorAll('.ws-menu .ws-menu-item')].find((n) => /^內容/.test(n.textContent))?.click()`)
  const win = await waitFor(async () => propertyWindows().find((w) => !before.has(w.hwnd)), 10000, '內容視窗').catch(() => null)
  const ok = Boolean(win && expect(win.title))
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}] 內容視窗標題＝${win ? win.title : '（沒出來）'}`)
  if (win) {
    closeWindow(win.hwnd)
    await sleep(600)
  }
  return ok
}

async function main() {
  if (!fs.existsSync(EXE)) { console.log(`SKIP 找不到 ${EXE}`); return }
  const before = new Set(propertyWindows().map((w) => w.hwnd))
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: 'ignore' })
  let failed = false
  try {
    const target = await waitFor(async () => (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && /index\.html/.test(t.url)), 40000, '主視窗')
    const cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
    await waitFor(() => cdp.evaluate(`typeof window.electronAPI?.explorer?.listDir === 'function'`), 20000, 'preload')

    const cases = [
      { name: '清單右鍵檔案', id: 'target-file.txt' },
      { name: '清單右鍵資料夾', id: 'sub' },
      { name: '選取後按 Shift+F10', id: 'target-file.txt', keyboard: true },
      { name: '圖示檢視右鍵檔案', id: 'target-file.txt', grid: true }
    ]
    for (const c of cases) {
      if (c.grid) await cdp.evaluate(`document.getElementById('exViewGridBtn').click()`)
      await sleep(400)
      const labels = c.keyboard ? await keyboardMenu(cdp, c.id) : await rightClickAt(cdp, await rowBox(cdp, c.id))
      const selected = await cdp.evaluate(`[...document.querySelectorAll('#exList .ex-row.is-selected')].map((r) => r.dataset.id)`)
      console.log(`[${c.name}] 選取＝${JSON.stringify(selected)}；選單前幾項＝${labels.slice(0, 6).join(' / ')}`)
      if (!await checkProperties(cdp, before, c.name, (t) => t.startsWith(c.id))) failed = true
    }

    // 本機首頁的磁碟卡片：以前按右鍵完全沒反應
    await cdp.evaluate(`document.getElementById('exViewListBtn').click()`)
    await cdp.evaluate(`[...document.querySelectorAll('#exPlaces .ex-side-item')].find((b) => b.dataset.path === 'thispc')?.click()`)
    const card = await waitFor(() => cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('#exHome .ex-home-card')].find((c) => /^[A-Z]:\\\\$/.test(c.dataset.path))
      if (!el || !el.offsetHeight) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + 30, y: r.top + r.height / 2, path: el.dataset.path }
    })()`), 15000, '首頁磁碟卡片').catch(() => null)
    if (!card) {
      console.log('FAIL [首頁磁碟] 找不到卡片')
      failed = true
    } else {
      const labels = await rightClickAt(cdp, card).catch(() => [])
      console.log(`[首頁磁碟 ${card.path}] 選單＝${labels.join(' / ')}`)
      const menuOk = labels.includes('開啟') && !labels.some((l) => /^(刪除|剪下|重新命名)$/.test(l))
      console.log(`${menuOk ? 'PASS' : 'FAIL'} [首頁磁碟] 有開啟、沒有刪除／剪下／改名`)
      if (!menuOk) failed = true
      if (!await checkProperties(cdp, before, '首頁磁碟', (t) => t.includes(card.path.slice(0, 2)))) failed = true
    }

    // 詳細資訊依類型補段落
    await cdp.evaluate(`document.getElementById('exBackBtn').click()`)
    const wants = [['clip.mp4', ['視訊', '幀率', '取樣率']], ['tool.exe', ['程式', '檔案版本']], ['target-file.txt', ['文字', '行數']]]
    for (const [id, want] of wants) {
      const got = await waitFor(() => cdp.evaluate(`(() => {
        const row = document.querySelector('#exList [data-id=${JSON.stringify(id)}]')
        if (!row) return null
        if (!row.classList.contains('is-selected')) row.click()
        const text = document.getElementById('exDetail').innerText
        return ${JSON.stringify(want)}.every((w) => text.includes(w)) ? text : null
      })()`), 15000, `詳細資訊 ${id}`).catch(() => null)
      console.log(`${got ? 'PASS' : 'FAIL'} [詳細資訊 ${id}] ${got ? got.replace(/\n+/g, ' | ').slice(0, 500) : ''}`)
      if (!got) failed = true
    }

    // 影片縮圖畫出來之後檔案不能被抓著（vi-media 串流沒放掉就改不了名、刪不掉）
    await cdp.evaluate(`document.querySelector('#exList [data-id="clip.mp4"]').click()`)
    const thumb = await waitFor(() => cdp.evaluate(`!!document.querySelector('#exDetail canvas.ex-detail-preview')`), 10000, '影片縮圖').catch(() => false)
    console.log(`${thumb ? 'PASS' : 'FAIL'} [影片縮圖] 右側畫出第一格`)
    if (!thumb) failed = true
    await sleep(1500)
    const clip = path.join(SEED_DIR, 'clip.mp4')
    const renamed = await cdp.evaluate(`window.electronAPI.explorer.renameEntry(${JSON.stringify(clip)}, 'clip2.mp4')`)
    console.log(`${renamed && renamed.ok ? 'PASS' : 'FAIL'} [影片縮圖] 看過縮圖後還改得了名 ${renamed && renamed.ok ? '' : JSON.stringify(renamed)}`)
    if (!renamed || !renamed.ok) failed = true
    cdp.ws.close()
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    await sleep(800)
    try { removeTree(USER_DATA_DIR) } catch { /* 暫存 */ }
  }
  if (failed) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
