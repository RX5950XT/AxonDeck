'use strict'

/**
 * 檔案頁剪貼簿 ↔ 專案檔案樹（packaged）：
 *   1. 檔案頁「複製」的東西，在檔案樹右鍵「貼上 N 個項目」貼進專案根目錄
 *   2. 焦點在資料夾列按 Ctrl+V，貼進那個資料夾
 *   3. 檔案樹 Ctrl+X 剪下，檔案頁貼上＝搬走，回報帶 mode／sources（檔案頁復原要靠它）
 *   4. 剪貼簿空的時候「貼上」是灰的
 *   5. Windows 檔案總管複製（多個檔）／剪下的檔案貼得進檔案樹；之後在 App 裡複製就換回 App 那份
 *
 * 會暫時寫系統剪貼簿（模擬檔案總管的 FileDrop＋Preferred DropEffect），結束後還原原本的文字。
 *
 *   npm run electron:pack && node scripts/probe-workspace-clipboard-cdp.js
 *
 * 暫存 user-data-dir＋暫存資料夾，收尾只關自己開的那個 pid。
 */

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { tempDir, removeTree } = require('./lib/test-temp')

const PORT = 9284
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')
const USER_DATA_DIR = tempDir('axondeck-clip-ud-')
const PROJECT_DIR = tempDir('axondeck-clip-proj-')
const OUTSIDE_DIR = tempDir('axondeck-clip-out-')
const PROJECT_ID = 'w_clip_probe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PS = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** 跟 Windows 檔案總管一樣放 FileDrop＋Preferred DropEffect（5＝複製、2＝剪下） */
function setSystemFiles(list, effect) {
  const quoted = list.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
  execFileSync(PS, ['-NoProfile', '-STA', '-Command', [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.DataObject',
    '$c = New-Object System.Collections.Specialized.StringCollection',
    `$c.AddRange([string[]]@(${quoted}))`,
    '$d.SetFileDropList($c)',
    `$d.SetData('Preferred DropEffect', (New-Object IO.MemoryStream(,[byte[]](${effect},0,0,0))))`,
    '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)'
  ].join('; ')], { stdio: 'ignore' })
}

const readText = () => {
  try { return execFileSync(PS, ['-NoProfile', '-STA', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }) } catch { return '' }
}
const writeText = (text) => {
  try {
    execFileSync(PS, ['-NoProfile', '-STA', '-Command', text ? '$input | Set-Clipboard' : 'Set-Clipboard -Value $null'], { input: text || '' })
  } catch { /* 還原不了就算了 */ }
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej) })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const wait = msg.id && this.pending.get(msg.id)
      if (!wait) return
      this.pending.delete(msg.id)
      if (msg.error) wait.reject(new Error(msg.error.message))
      else wait.resolve(msg.result)
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}
require('./lib/page-cdp').followMainPage(Cdp)

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await check()) return true } catch { /* 還沒好 */ }
    await sleep(250)
  }
  return false
}

async function mainTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url))
      if (page) return page
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('等不到 CDP')
}

function seed() {
  fs.mkdirSync(path.join(PROJECT_DIR, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, 'a.txt'), 'a')
  fs.writeFileSync(path.join(OUTSIDE_DIR, 'out.txt'), 'out')
  for (const name of ['sys1.txt', 'sys2.txt', 'sys3.txt']) fs.writeFileSync(path.join(OUTSIDE_DIR, name), name)
  fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
  fs.writeFileSync(path.join(USER_DATA_DIR, 'workspaces.json'), JSON.stringify({
    projects: [{ id: PROJECT_ID, name: '剪貼簿探針', path: PROJECT_DIR, createdAt: Date.now() }]
  }))
}

/** 在樹上某處（rel 空＝空白處）開右鍵，回傳選單項目文字與是否可按 */
const openMenu = (cdp, rel) => cdp.eval(`(async () => {
  const tree = document.getElementById('wsTree')
  const row = ${JSON.stringify(rel)} ? [...tree.querySelectorAll('.ws-tree-row')].find(r => r.dataset.rel === ${JSON.stringify(rel)}) : null
  const target = row || tree
  const r = target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: row ? r.top + 5 : r.bottom - 5 }))
  await new Promise(res => setTimeout(res, 400))
  return [...document.querySelectorAll('.ws-menu-item')].map(b => ({ text: b.textContent.trim(), disabled: b.disabled }))
})()`)

const clickMenu = (cdp, prefix) => cdp.eval(`(() => {
  const btn = [...document.querySelectorAll('.ws-menu-item')].find(b => b.textContent.trim().startsWith(${JSON.stringify(prefix)}))
  if (btn) btn.click()
  return Boolean(btn)
})()`)

async function pressCtrl(cdp, key, rel) {
  await cdp.eval(`[...document.querySelectorAll('#wsTree .ws-tree-row')].find(r => r.dataset.rel === ${JSON.stringify(rel)}).focus()`)
  const code = `Key${key.toUpperCase()}`
  const vk = key.toUpperCase().charCodeAt(0)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers: 2 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: 2 })
}

async function run(cdp, ok) {
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await sleep(1500)
  await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
  await waitFor(() => cdp.eval(`Boolean(document.querySelector('#projList [data-id="${PROJECT_ID}"]'))`))
  await cdp.eval(`document.querySelector('#projList [data-id="${PROJECT_ID}"] .chat-list-open').click()`)
  ok('檔案樹載入', await waitFor(() => cdp.eval(`document.querySelectorAll('#wsTree .ws-tree-row').length >= 2`)))

  let menu = await openMenu(cdp, '')
  const empty = menu.find((m) => m.text.startsWith('貼上'))
  ok('剪貼簿空的時候「貼上」是灰的', empty && empty.disabled, JSON.stringify(empty))
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(200)

  // 檔案頁「複製」走的就是這支 IPC
  await cdp.eval(`window.electronAPI.explorer.setClipboard([${JSON.stringify(path.join(OUTSIDE_DIR, 'out.txt'))}], 'copy')`)
  menu = await openMenu(cdp, '')
  ok('空白處右鍵顯示「貼上 1 個項目」', menu.some((m) => m.text.startsWith('貼上 1 個項目') && !m.disabled), JSON.stringify(menu.map((m) => m.text)))
  await clickMenu(cdp, '貼上')
  ok('貼進專案根目錄', await waitFor(() => fs.existsSync(path.join(PROJECT_DIR, 'out.txt'))))
  ok('複製不動原檔', fs.existsSync(path.join(OUTSIDE_DIR, 'out.txt')))
  ok('樹上看得到貼進來的檔案', await waitFor(() => cdp.eval(`[...document.querySelectorAll('#wsTree .ws-tree-row')].some(r => r.dataset.rel === 'out.txt')`)))

  await pressCtrl(cdp, 'v', 'sub')
  ok('資料夾列 Ctrl+V 貼進那個資料夾', await waitFor(() => fs.existsSync(path.join(PROJECT_DIR, 'sub', 'out.txt'))))

  menu = await openMenu(cdp, 'a.txt')
  ok('檔案列右鍵有剪下／複製／貼上',
    ['剪下', '複製（', '貼上'].every((p) => menu.some((m) => m.text.startsWith(p))), JSON.stringify(menu.map((m) => m.text)))
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(200)

  await cdp.eval(`[...document.querySelectorAll('#wsTree .ws-tree-row')].find(r => r.dataset.rel === 'a.txt').click()`)
  await sleep(300)
  await pressCtrl(cdp, 'x', 'a.txt')
  const state = await waitFor(async () => {
    const res = await cdp.eval(`window.electronAPI.explorer.clipboardState()`)
    return res && res.ok && res.data.mode === 'cut' && res.data.count === 1
  })
  ok('檔案樹 Ctrl+X 放進檔案頁剪貼簿（剪下 1 項）', state)

  // 檔案頁 Ctrl+V 叫的就是 explorer.paste
  const done = await cdp.eval(`window.electronAPI.explorer.paste(${JSON.stringify(OUTSIDE_DIR)})`)
  ok('檔案頁貼上＝搬走', fs.existsSync(path.join(OUTSIDE_DIR, 'a.txt')) && !fs.existsSync(path.join(PROJECT_DIR, 'a.txt')))
  ok('貼上回報帶 mode 與 sources（復原用）',
    done && done.ok && done.data.mode === 'cut' && done.data.sources.length === 1
      && path.basename(done.data.sources[0]) === 'a.txt', JSON.stringify(done && done.data && { mode: done.data.mode, sources: done.data.sources }))

  // ===== Windows 檔案總管的剪貼簿 =====
  setSystemFiles([path.join(OUTSIDE_DIR, 'sys1.txt'), path.join(OUTSIDE_DIR, 'sys2.txt')], 5)
  menu = await openMenu(cdp, '')
  ok('系統複製比較新：選單顯示「貼上 Windows 複製的檔案」',
    menu.some((m) => m.text.startsWith('貼上 Windows 複製的檔案') && !m.disabled), JSON.stringify(menu.map((m) => m.text)))
  await clickMenu(cdp, '貼上')
  ok('Windows 複製的兩個檔都貼進專案根目錄',
    await waitFor(() => ['sys1.txt', 'sys2.txt'].every((n) => fs.existsSync(path.join(PROJECT_DIR, n)))))
  ok('系統複製不動原檔', fs.existsSync(path.join(OUTSIDE_DIR, 'sys1.txt')))

  setSystemFiles([path.join(OUTSIDE_DIR, 'sys3.txt')], 2)
  await pressCtrl(cdp, 'v', 'sub')
  ok('Windows 剪下的檔，在資料夾列 Ctrl+V＝搬進那個資料夾',
    await waitFor(() => fs.existsSync(path.join(PROJECT_DIR, 'sub', 'sys3.txt')) && !fs.existsSync(path.join(OUTSIDE_DIR, 'sys3.txt'))))

  setSystemFiles([path.join(OUTSIDE_DIR, 'sys1.txt')], 5)
  await cdp.eval(`window.electronAPI.explorer.setClipboard([${JSON.stringify(path.join(OUTSIDE_DIR, 'out.txt'))}], 'copy')`)
  const after = await cdp.eval(`window.electronAPI.explorer.clipboardState()`)
  ok('之後在 App 裡複製＝改用 App 那份', after && after.ok && after.data.source === 'app' && after.data.count === 1, JSON.stringify(after))
}

async function main() {
  seed()
  const savedText = readText()
  const child = spawn(EXE, [
    '--hidden', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push(Boolean(pass))
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ' — ' + detail : ''}`)
  }
  let cdp = null
  try {
    cdp = new Cdp((await mainTarget()).webSocketDebuggerUrl)
    await cdp.connect()
    await run(cdp, ok)
  } catch (error) {
    ok('探針跑完', false, error.message)
  } finally {
    cdp?.close()
    writeText(savedText)
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    await sleep(1500)
    for (const dir of [USER_DATA_DIR, PROJECT_DIR, OUTSIDE_DIR]) {
      try { removeTree(dir) } catch { /* 留給 test-temp 清 */ }
    }
  }
  const failed = results.filter((p) => !p).length
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}

main()
