'use strict'

/**
 * Browser 模式的分頁「彈出獨立視窗」：一個分頁一扇窗。上面是 HTML 工具列（pages/browser-window.html），
 * 下面的網頁是 main 自己建的 WebContentsView（`persist:wsbrowser`，登入狀態與擴充功能跟 App 內共用）。
 *
 * 為什麼不用 <webview>：<webview> 的網頁沒辦法搬到別的視窗（拆掉就關了），只能在新視窗重開；
 * 而 <webview> 一定要先載入某個網址才接得上，載過東西就不能再 `navigationHistory.restore`。
 * 自己建的 view 可以在第一次載入前 restore 原分頁的整串歷史（含 Chromium 存的捲動位置、表單內容），
 * 上一頁照樣能按；Chromium 大約一秒才存一次狀態，所以另外帶「彈出那一刻」量到的捲動、欄位、影音進度補上去。
 *
 * 視窗標題跟著網頁標題走，工作列顯示的就是分頁名稱。
 */

const path = require('path')
const { BrowserWindow, WebContentsView } = require('electron')

/** 工具列高度（DIP），跟 browser-window.html 的 .bw-bar 一致 */
const BAR_HEIGHT = 44

/** 在原分頁裡跑：量「現在」的捲動、表單欄位、影音進度（密碼與檔案欄位不帶） */
const COLLECT_SCRIPT = `(() => {
  const fields = [...document.querySelectorAll('input, textarea, select')].map((el) => {
    if (el.type === 'password' || el.type === 'file' || el.type === 'hidden') return null
    return { value: el.value, checked: el.checked === true }
  })
  const media = [...document.querySelectorAll('video, audio')].map((el) => ({ time: el.currentTime, paused: el.paused }))
  return { x: scrollX, y: scrollY, fields, media }
})()`

/** 在新視窗裡跑：把量到的狀態套回去（欄位數量對不上就不套，避免填錯格） */
const APPLY_SCRIPT = (live) => `(() => {
  const live = ${JSON.stringify(live)}
  const els = [...document.querySelectorAll('input, textarea, select')]
  if (els.length === live.fields.length) {
    els.forEach((el, i) => {
      const f = live.fields[i]
      if (!f) return
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.checked
      else if (el.value !== f.value) el.value = f.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const media = [...document.querySelectorAll('video, audio')]
  if (media.length === live.media.length) media.forEach((el, i) => {
    el.currentTime = live.media[i].time
    if (!live.media[i].paused) el.play().catch(() => {})
  })
  window.scrollTo(live.x, live.y)
})()`

let options = {
  isDev: false,
  icon: '',
  preload: '',
  secure: (_win) => {},
  theme: () => 'dark',
  /** App 正在結束：關視窗不要收回 */
  isQuitting: () => false,
  /** 最小化或關閉時把網頁收回 Browser 模式 @type {(info: { slot: number, url: string, title: string }) => void} */
  onDock: (_info) => {},
  /** 掛右鍵選單、擴充功能 @type {(contents: Electron.WebContents, win: BrowserWindow) => void} */
  attach: (_contents, _win) => {}
}

/** @type {Map<number, { win: BrowserWindow, view: WebContentsView }>} 以工具列 webContents id 為鍵 */
const entries = new Map()

function configure(next) { options = { ...options, ...next } }

const isWebUrl = (url) => /^https?:\/\//i.test(String(url || ''))

/**
 * 原分頁（Browser 模式的 webview）目前的狀態：整串歷史＋這一刻的捲動、欄位、影音。拿不到就只回網址。
 * @param {Electron.WebContents | null} guest
 */
async function snapshot(guest) {
  if (!guest || guest.isDestroyed()) return null
  try {
    const entriesNow = guest.navigationHistory.getAllEntries()
    const index = guest.navigationHistory.getActiveIndex()
    // 只帶 http(s) 的歷史（data:、about: 之類的不帶過去）；當下那頁不是 http(s) 就整串不帶
    if (!isWebUrl(entriesNow[index]?.url)) return null
    const kept = entriesNow.map((entry, i) => ({ entry, i })).filter(({ entry }) => isWebUrl(entry.url))
    const live = await guest.executeJavaScript(COLLECT_SCRIPT, true).catch(() => null)
    return {
      entries: kept.map(({ entry }) => entry),
      index: kept.findIndex(({ i }) => i === index),
      live
    }
  } catch {
    return null
  }
}

/**
 * @param {string} url 已確認是 http(s)
 * @param {string} [title]
 * @param {Electron.WebContents | null} [guest] 原分頁的 webview：有給就把歷史與狀態一起搬過去
 * @param {number} [slot] 原分頁在 Browser 模式的位置代號：收回時 renderer 靠它放回原處
 */
async function open(url, title = '', guest = null, slot = 0, compatible = false) {
  const state = await snapshot(guest)
  const light = options.theme() === 'light'
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 480,
    minHeight: 320,
    title: title || url,
    icon: options.icon || undefined,
    backgroundColor: light ? '#e9eeec' : '#111417',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, preload: options.preload }
  })
  win.setMenu(null)
  options.secure(win)
  const view = new WebContentsView({
    webPreferences: { partition: compatible ? 'persist:wsbrowser-clean' : 'persist:wsbrowser', sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.contentView.addChildView(view)
  const layout = () => {
    const [width, height] = win.getContentSize()
    view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) })
  }
  layout()
  win.on('resize', layout)
  const page = view.webContents
  const bar = win.webContents
  const barId = bar.id
  entries.set(barId, { win, view })
  options.attach(page, win)

  const push = () => {
    if (bar.isDestroyed() || page.isDestroyed()) return
    const nav = page.navigationHistory
    bar.send('browserWindow:state', {
      url: page.getURL(),
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward(),
      loading: page.isLoading(), compatible
    })
  }
  for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) page.on(event, push)
  page.on('page-title-updated', (_event, pageTitle) => {
    if (!win.isDestroyed() && pageTitle) win.setTitle(pageTitle)
  })
  // 滑鼠側鍵上／下一頁
  page.on('before-mouse-event', (_event, input) => {
    if (input.type !== 'mouseUp' || (input.button !== 'back' && input.button !== 'forward')) return
    const nav = page.navigationHistory
    if (input.button === 'back' && nav.canGoBack()) nav.goBack()
    else if (input.button === 'forward' && nav.canGoForward()) nav.goForward()
  })
  bar.on('did-finish-load', push)
  // 工具列頁自己的 <title> 不可以蓋掉視窗標題（工作列要顯示網頁名稱）
  bar.on('page-title-updated', (event) => event.preventDefault())
  // 最小化或關閉＝收回原本的分頁位置（最小化是把視窗關掉，不留一扇縮在工作列的窗）
  let docked = false
  win.on('minimize', () => win.close())
  win.on('close', () => {
    if (docked || options.isQuitting() || !slot || page.isDestroyed()) return
    docked = true
    const current = page.getURL()
    options.onDock({ slot, url: isWebUrl(current) ? current : url, title: win.getTitle() })
  })
  win.on('closed', () => {
    entries.delete(barId)
    if (!page.isDestroyed()) page.close()
  })
  win.once('ready-to-show', () => win.show())

  const query = { url, theme: light ? 'light' : 'dark' }
  if (options.isDev) win.loadURL(`http://localhost:5173/pages/browser-window.html?${new URLSearchParams(query)}`)
  else win.loadFile(path.join(__dirname, '../renderer/pages/browser-window.html'), { query })

  // 不等網頁載完：呼叫端拿到回覆就會關掉原分頁（狀態已經在 snapshot 量好了）
  void load(page, url, state)
  return win
}

/**
 * @param {Electron.WebContents} page
 * @param {string} url
 * @param {Awaited<ReturnType<typeof snapshot>>} state
 */
async function load(page, url, state) {
  if (state?.entries.length && state.index >= 0) {
    try {
      await page.navigationHistory.restore({ entries: state.entries, index: state.index })
      if (state.live && !page.isDestroyed()) await page.executeJavaScript(APPLY_SCRIPT(state.live), true).catch(() => {})
      return
    } catch {
      // restore 碰到子框架載入失敗也會 reject；主頁已經在了就別重載（會把還原的狀態洗掉）
      if (page.isDestroyed() || isWebUrl(page.getURL())) return
      // 真的沒還原起來：退回只開網址
    }
  }
  if (!page.isDestroyed()) page.loadURL(url).catch(() => {})
}

/** @param {Electron.WebContents} sender 工具列 → 那扇窗的網頁 */
function pageOf(sender) {
  const entry = entries.get(sender.id)
  return entry && !entry.view.webContents.isDestroyed() ? entry.view.webContents : null
}

/** @param {Electron.WebContents} sender */
function windowOf(sender) {
  return entries.get(sender.id)?.win || null
}

/**
 * 工具列的按鈕
 * @param {Electron.WebContents} sender
 * @param {unknown} action
 * @param {unknown} url
 */
function navigate(sender, action, url) {
  const page = pageOf(sender)
  if (!page) return false
  const nav = page.navigationHistory
  if (action === 'back' && nav.canGoBack()) nav.goBack()
  else if (action === 'forward' && nav.canGoForward()) nav.goForward()
  else if (action === 'reload') {
    if (page.isLoading()) page.stop()
    else page.reload()
  } else if (action === 'go' && isWebUrl(url)) page.loadURL(String(url)).catch(() => {})
  else return false
  return true
}

function broadcast(channel) {
  for (const { win } of entries.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel)
  }
}

module.exports = { configure, open, pageOf, windowOf, navigate, broadcast, BAR_HEIGHT }
