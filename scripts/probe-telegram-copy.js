/**
 * npx electron scripts/probe-telegram-copy.js — 真實 Web A：訊息能不能反白、右鍵出什麼選單、複製得到什麼。
 * 用 App 的 Partitions/telegram 副本（共用登入），只開「儲存的訊息」（自己的聊天室，不會把別人的訊息標已讀）。
 * 視窗放在螢幕外、不搶焦點；剪貼簿測完還原。
 */
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, clipboard } = require('electron')
const { tempDir } = require('./lib/test-temp')

const SRC = ['axondeck', 'voiceink'].map((n) => path.join(process.env.APPDATA, n, 'Partitions', 'telegram')).find((p) => fs.existsSync(p))
const SKIP = new Set(['LOCK', 'lockfile', 'Service Worker'])
const userData = tempDir('telegram-copy-')
app.setPath('userData', userData)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const timer = setTimeout(() => { console.error('FAIL 逾時'); app.exit(1) }, 120000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const a = path.join(from, entry.name)
    const b = path.join(to, entry.name)
    try {
      if (entry.isDirectory()) copyTree(a, b)
      else fs.writeFileSync(b, fs.readFileSync(a))
    } catch { /* 開著的 App 鎖住的檔 */ }
  }
}

async function waitFor(win, expr, ms = 40000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(expr).catch(() => false)) return true
    await sleep(500)
  }
  return false
}

async function run() {
  if (!SRC) throw new Error('找不到 Partitions/telegram')
  copyTree(SRC, path.join(userData, 'Partitions', 'telegram'))
  const host = new BrowserWindow({ show: false, width: 560, height: 900, webPreferences: { webviewTag: true } })
  host.setPosition(-3000, -3000)
  host.showInactive()
  // 跟 App 一樣放在 <webview> 裡（WEBVIEW=0 改成直接開視窗比對）
  const useView = process.env.WEBVIEW !== '0'
  let win = host
  if (useView) {
    const attached = new Promise((resolve) => app.once('web-contents-created', (_e, wc) => resolve(wc)))
    await host.loadURL(`data:text/html,<body style="margin:0"><webview partition="persist:telegram" src="about:blank" style="width:100vw;height:100vh"></webview>`)
    const guest = await attached
    win = { webContents: guest, loadURL: (u) => guest.loadURL(u) }
  } else {
    win = new BrowserWindow({ show: false, width: 560, height: 900, webPreferences: { partition: 'persist:telegram', sandbox: true } })
    win.setPosition(-3000, -3000)
    win.showInactive()
  }
  await win.loadURL('https://web.telegram.org/a/')
  if (!await waitFor(win, `!!document.querySelector('.chat-list .ListItem')`)) throw new Error('沒登入或列表沒出來')
  const myId = await win.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('user_auth') || '{}').id`)
  await win.loadURL('about:blank')
  await win.loadURL(`https://web.telegram.org/a/#${myId}`)
  if (!await waitFor(win, `!!document.querySelector('.Message .text-content')`)) throw new Error('儲存的訊息沒有文字訊息')
  await sleep(1500)
  const info = await win.webContents.executeJavaScript(`(() => {
    const els = [...document.querySelectorAll('.Message .text-content')]
    const el = els[els.length - 1]
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const chain = []
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const us = getComputedStyle(n).userSelect
      if (us !== 'auto') chain.push((n.className || n.tagName).toString().slice(0, 40) + ':' + us)
    }
    return { x: r.left + 4, y: r.top + r.height / 2, w: r.width, textLength: el.textContent.length, chain: chain.slice(0, 3),
      coarse: matchMedia('(pointer: coarse)').matches, width: innerWidth }
  })()`)
  console.log('訊息', info)
  const wc = win.webContents
  const send = (e) => wc.sendInputEvent(e)
  // 按住拖過去反白
  send({ type: 'mouseDown', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 10; i++) { send({ type: 'mouseMove', x: info.x + (info.w - 8) * i / 10, y: info.y, button: 'left' }); await sleep(30) }
  send({ type: 'mouseUp', x: info.x + info.w - 8, y: info.y, button: 'left', clickCount: 1 })
  await sleep(500)
  console.log('拖曳後反白字數:', (await wc.executeJavaScript('getSelection().toString()')).length)
  // 程式直接反白，再看右鍵
  await wc.executeJavaScript(`(() => { const els = [...document.querySelectorAll('.Message .text-content')]; getSelection().selectAllChildren(els[els.length - 1]) })()`)
  let nativeMenu = null
  wc.once('context-menu', (_e, p) => { nativeMenu = { selectionText: p.selectionText, editable: p.isEditable } })
  send({ type: 'mouseDown', x: info.x, y: info.y, button: 'right', clickCount: 1 })
  send({ type: 'mouseUp', x: info.x, y: info.y, button: 'right', clickCount: 1 })
  await sleep(1200)
  const webMenu = await wc.executeJavaScript(`[...document.querySelectorAll('.MessageContextMenu .MenuItem, .ContextMenu .MenuItem')].map((n) => n.textContent.trim())`)
  console.log('原生 context-menu 事件:', nativeMenu, '\nWeb A 選單:', webMenu)
  console.log('右鍵後反白字數:', (await wc.executeJavaScript('getSelection().toString()')).length)
  // 訊息以外（聊天室標題）：Web A 不接右鍵，要靠 App 的原生選單（context-menu 事件有沒有到 main）
  send({ type: 'keyDown', keyCode: 'Escape' }); send({ type: 'keyUp', keyCode: 'Escape' })
  await sleep(300)
  const title = await wc.executeJavaScript(`(() => { const el = document.querySelector('.MiddleHeader .fullName, .MiddleHeader h3'); if (!el) return null
    getSelection().selectAllChildren(el); const r = el.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 } })()`)
  let titleMenu = null
  wc.once('context-menu', (_e, p) => { titleMenu = { selectionLength: p.selectionText.length } })
  if (title) {
    send({ type: 'mouseDown', x: title.x, y: title.y, button: 'right', clickCount: 1 })
    send({ type: 'mouseUp', x: title.x, y: title.y, button: 'right', clickCount: 1 })
    await sleep(800)
  }
  console.log('標題反白後右鍵 context-menu 事件:', titleMenu)
  // Ctrl+C
  const saved = clipboard.readText()
  clipboard.writeText('__before__')
  await wc.executeJavaScript(`(() => { const els = [...document.querySelectorAll('.Message .text-content')]; getSelection().selectAllChildren(els[els.length - 1]) })()`)
  send({ type: 'keyDown', keyCode: 'Escape' }); send({ type: 'keyUp', keyCode: 'Escape' })
  await wc.executeJavaScript(`(() => { const els = [...document.querySelectorAll('.Message .text-content')]; getSelection().selectAllChildren(els[els.length - 1]) })()`)
  send({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] }); send({ type: 'char', keyCode: 'c', modifiers: ['control'] }); send({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] })
  await sleep(500)
  const copied = clipboard.readText()
  console.log('Ctrl+C 有複製到:', copied !== '__before__' && copied.length > 0)
  clipboard.writeText(saved)
  await win.loadURL('about:blank')
}

app.whenReady().then(run).then(() => { clearTimeout(timer); app.exit(0) }, (e) => { console.error('FAIL', e.message); app.exit(1) })
