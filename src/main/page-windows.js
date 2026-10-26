'use strict'
const { isInternalBrowserUrl } = require('../shared/browser-url.mjs')

const { BrowserWindow, WebContentsView } = require('electron')
const fs = require('fs')
const path = require('path')

const indexFile = path.join(__dirname, '../renderer/index.html')
const navHtml = fs.readFileSync(indexFile, 'utf8')
const pageNames = [...navHtml.matchAll(/class="nav-tab[^"]*" data-page="(\w+)"/g)].map((m) => m[1])
/** 彈出視窗的標題（工作列看的就是它）：沿用導覽列那顆的 aria-label */
const pageLabels = new Map([...navHtml.matchAll(/class="nav-tab[^"]*" data-page="(\w+)"[^>]*aria-label="([^"]+)"/g)].map((m) => [m[1], m[2]]))

/** 每頁只有一份 renderer；收回只搬 view，不重載、不複製草稿或工作。 */
function createPageWindows({ main, isDev, icon, background, secure, hidden }) {
  const entries = new Map()
  let current = null
  let disposed = false
  let revision = 0
  let history = []
  let historyIndex = -1
  let pendingPage = ''

  function entryFor(sender) {
    return [...entries.values()].find((entry) => entry.view.webContents === sender)
  }

  function send(entry, channel, payload) {
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.send(channel, payload)
  }

  function resize(entry) {
    const host = entry.popup || main
    if (host.isDestroyed()) return
    const [width, height] = host.getContentSize()
    entry.view.setBounds({ x: 0, y: 0, width, height })
  }

  function publish() {
    const detached = [...entries.values()].filter((entry) => entry.popup).map((entry) => entry.page)
    for (const entry of entries.values()) send(entry, 'pages:state', { detached, floating: !!entry.popup })
    if (!main.isDestroyed()) main.webContents.send('pages:state', {
      detached, floating: false, current: current?.page || '', pending: pendingPage
    })
  }

  function visibility(entry, visible) {
    entry.view.setVisible(visible)
    send(entry, 'pages:visibility', visible)
  }

  function park() {
    if (!current) return
    visibility(current, false)
    main.contentView.removeChildView(current.view)
    current = null
  }

  function mount(entry) {
    if (current !== entry) park()
    current = entry
    main.contentView.addChildView(entry.view)
    resize(entry)
    visibility(entry, true)
    send(entry, 'window:maximized', main.isMaximized())
  }

  function ensure(page) {
    if (!pageNames.includes(page)) throw new Error('無效功能頁')
    if (entries.has(page)) return entries.get(page)
    const view = new WebContentsView({ webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webviewTag: page === 'chat' || page === 'telegram', spellcheck: false,
      preload: path.join(__dirname, '../preload/preload.js')
    } })
    view.setBackgroundColor(background())
    const entry = { page, view, popup: null, ready: null, resolve: null }
    entry.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('功能頁載入逾時')), 30000)
      entry.resolve = () => { clearTimeout(timer); resolve() }
      view.webContents.once('did-fail-load', () => { clearTimeout(timer); reject(new Error('功能頁載入失敗')) })
    })
    // 提早掛 rejection handler，避免 renderer 還未 ready 時變成 unhandled rejection。
    entry.ready.catch(() => {})
    entries.set(page, entry)
    secure({ webContents: view.webContents })
    const loading = isDev
      ? view.webContents.loadURL(`http://localhost:5173/?page=${page}`)
      : view.webContents.loadFile(indexFile, { query: { page } })
    loading.catch(() => {}) // did-fail-load 統一回報給呼叫端。
    return entry
  }

  function ready(sender) {
    const entry = entryFor(sender)
    if (!entry) return false
    entry.resolve()
    send(entry, 'pages:visibility', current === entry || !!entry.popup)
    publish()
    return true
  }

  function validateRequest(request) {
    if (!request || !pageNames.includes(request.page)) throw new Error('無效功能頁')
    const { page, subtab = '', action = '', full = '', kind = 'dir', project = '', target = '' } = request
    if (!['', 'recommend', 'runtime', 'cloud', 'basic', 'appearance', 'cli', 'install'].includes(subtab)) throw new Error('無效子頁')
    if (!['', 'files', 'project', 'browser'].includes(action) || typeof full !== 'string' || full.length > 32768
      || !['', 'browser', 'tab'].includes(target)
      || !['dir', 'file'].includes(kind) || (action === 'files' && page !== 'explorer')
      || ((action === 'project' || action === 'browser') && page !== 'chat')
      || (action === 'browser' && !/^https?:\/\//i.test(full) && !(target === 'tab' && isInternalBrowserUrl(full)))
      || typeof project !== 'string' || !/^[\w.-]{0,128}$/.test(project)) throw new Error('無效頁面操作')
    const sourceGuestId = request.sourceGuestId ?? 0
    if (!Number.isSafeInteger(sourceGuestId) || sourceGuestId < 0) throw new Error('無效來源分頁')
    return { page, subtab, action, full, kind, project, target, sourceGuestId }
  }

  async function navigate(request, detach = false, record = true) {
    const data = validateRequest(request)
    const sequence = ++revision
    const entry = ensure(data.page)
    if (!detach && !entry.popup) { pendingPage = data.page; publish() }
    try { await entry.ready } catch (error) {
      if (sequence === revision) { pendingPage = ''; publish() }
      entries.delete(data.page)
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
      throw error
    }
    if (disposed || sequence !== revision) return false
    pendingPage = ''
    if (detach) pop(entry)
    else if (entry.popup) {
      if (!hidden) { entry.popup.show(); entry.popup.focus() }
    } else mount(entry)
    if (!detach && record && history[historyIndex] !== data.page) {
      history = [...history.slice(0, historyIndex + 1), data.page].slice(-50)
      historyIndex = history.length - 1
    }
    send(entry, 'pages:navigate', data)
    publish()
    return true
  }

  function dock(entry) {
    if (!entry.popup || disposed) return
    ++revision
    const popup = entry.popup
    popup.contentView.removeChildView(entry.view)
    entry.popup = null
    // 主視窗正在顯示別頁就維持原畫面，收回的頁先藏著；主視窗沒頁可顯示才換過去
    if (current) visibility(entry, false)
    else {
      mount(entry)
      if (history[historyIndex] !== entry.page) {
        history = [...history.slice(0, historyIndex + 1), entry.page].slice(-50)
        historyIndex = history.length - 1
      }
    }
    popup.destroy()
    if (!hidden) { if (main.isMinimized()) main.restore(); main.show(); main.focus() }
    publish()
  }

  function pop(entry) {
    if (entry.popup) {
      if (!hidden) { entry.popup.show(); entry.popup.focus() }
      return
    }
    if (current === entry) {
      main.contentView.removeChildView(entry.view)
      current = null
    }
    const popup = new BrowserWindow({ width: 1100, height: 760, minWidth: 900, minHeight: 600,
      frame: false, icon, title: pageLabels.has(entry.page) ? `${pageLabels.get(entry.page)} — AxonDeck` : 'AxonDeck', backgroundColor: background(), show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    entry.popup = popup
    popup.setMenu(null)
    secure(popup)
    popup.contentView.addChildView(entry.view)
    resize(entry)
    visibility(entry, true)
    send(entry, 'window:maximized', false)
    popup.on('resize', () => resize(entry))
    for (const event of ['maximize', 'unmaximize', 'restore']) popup.on(event, () => { resize(entry); send(entry, 'window:maximized', popup.isMaximized()) })
    // 在原生最小化事件內同步 destroy 會卡住主程序，等事件結束再收回。
    popup.on('minimize', () => setImmediate(() => dock(entry)))
    popup.on('close', (event) => { if (!disposed) { event.preventDefault(); dock(entry) } })
    if (!hidden) popup.show()
  }

  main.on('resize', () => { if (current) resize(current) })
  // 無邊框視窗最大化／還原時 Windows 不一定發 resize，沒跟著調會讓頁面停在舊尺寸、右側按鈕跑到視窗外
  for (const event of ['maximize', 'unmaximize', 'restore']) main.on(event, () => {
    if (!current) return
    resize(current)
    send(current, 'window:maximized', main.isMaximized())
  })
  main.once('closed', () => {
    disposed = true
    for (const entry of entries.values()) {
      if (entry.popup && !entry.popup.isDestroyed()) entry.popup.destroy()
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    }
    entries.clear()
  })

  return {
    ready, navigate,
    history: async (delta) => {
      const next = historyIndex + (delta === -1 ? -1 : 1)
      if (next < 0 || next >= history.length) return false
      historyIndex = next
      return navigate({ page: history[next] }, false, false)
    },
    owns: (sender) => !!entryFor(sender),
    contents: (page) => entries.get(page)?.view.webContents,
    host: (sender) => entryFor(sender)?.popup || main,
    dock: (sender) => { const entry = entryFor(sender); if (!entry?.popup) return false; dock(entry); return true },
    broadcast: (channel, payload) => { for (const entry of entries.values()) send(entry, channel, payload) }
  }
}

module.exports = {
  createPageWindows,
  pageLabels
}
