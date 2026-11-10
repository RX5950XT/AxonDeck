import { electronAPI } from './app.js'

/**
 * Telegram（AI 頁 Chat 側欄的入口，主區 `setChatPaneMode('telegram')`）：官方網頁版（Web A）放進 <webview>，可以並排多開幾格。
 *
 * 每一格都用同一個 `persist:telegram`：Web A 本來就支援同帳號多分頁，
 * 所以登入一次、每一格都是登入狀態。每格頂端一條細列：✕ 關掉這格，
 * 最右邊那格多一顆 ＋ 往右再開一格。每格停在哪個聊天室（網址的 #hash）
 * 存進設定 `telegramPanes`，下次打開接著原本那幾格；沒存過就開兩格。
 * 每格寬度卡在 600px（CSS），Web A 一律是手機版版面。
 */

const HOME_URL = 'https://web.telegram.org/a/'
const STORE_KEY = 'telegramPanes'
// ponytail: 每格就是一整份 Web A（約 200–300MB），先卡 4 格；main 的 store:set 也卡 4
const MAX_PANES = 4
// Web A 多開時只有「主分頁」連線，其他格的收發都靠它；它只在 beforeunload 交棒，沒有心跳。
// 主分頁當掉或連線狀態卡死，其他格永遠不知道，就一直停在「等待網路連線」、收不到新訊息。
// 救法是全部格子先卸載（各自送出交棒通知）再一格一格載回來，讓 Web A 重新選主分頁。
const WATCH_EVERY_MS = 20000
const STUCK_MS = 60000
// 全部重載之間至少隔這麼久：網路真的不通時不要每分鐘重載一次
const RELOAD_ALL_GAP_MS = 5 * 60 * 1000
// 在格子裡跑：連得上網，卻顯示「等待網路連線」或「更新中」（左欄的提示框，或聊天室標題下的狀態字）。
// 「更新中」是 Web A 的同步（sync／getDifference）卡住：它自己 30 秒的補救失敗後就永遠停在這，新訊息也不進來
const STUCK_PROBE = `navigator.onLine && !!(document.getElementById('ConnectionStatusOverlay') ||
  [...document.querySelectorAll('.MiddleHeader .status')].some((el) => /等待網路|等待网络|waiting for network|更新中|正在更新|updating/i.test(el.textContent)))`

// 在格子裡跑：外部連結搶在 Web A 前面直接 window.open（main 轉到 AI 頁的 Browser 模式），跳過「確定要開啟？」確認框；
// t.me 這類 Telegram 自己的連結留給 Web A 在 App 內開聊天室
const DIRECT_LINKS = `window.__axDirectLinks || (window.__axDirectLinks = true, window.addEventListener('click', (e) => {
  const a = e.button === 0 && e.target.closest && e.target.closest('a[href]')
  if (!a) return
  let u
  try { u = new URL(a.href) } catch { return }
  if (!/^https?:$/.test(u.protocol) || /(^|\\.)(t\\.me|telegram\\.me|telegram\\.dog|telegram\\.org)$/i.test(u.hostname)) return
  e.preventDefault()
  e.stopImmediatePropagation()
  window.open(u.href, '_blank', 'noopener')
}, true))`

// 在格子裡跑：自己送出訊息後跳到聊天室最下面（往上翻舊訊息時送出，Web A 不會自己捲回來）。
// 優先按 Web A 的「到最下面」鈕（舊訊息沒載完時它會去載最新的），沒有就直接捲
const SEND_SCROLL = `window.__axSendScroll || (window.__axSendScroll = true, (() => {
  const toBottom = () => setTimeout(() => {
    const icon = document.querySelector('#MiddleColumn button .icon-arrow-down')
    const btn = icon && icon.closest('button')
    if (btn && !btn.closest('[inert]')) { btn.click(); return }
    const list = document.querySelector('.MessageList')
    if (list) list.scrollTop = list.scrollHeight
  }, 250)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.closest && e.target.closest('#editable-message-text')) toBottom()
  }, true)
  window.addEventListener('click', (e) => {
    if (e.button === 0 && e.target.closest && e.target.closest('.main-button.send')) toBottom()
  }, true)
})())`

// Web A 不吃外部改的 hash：開著的頁面被改 hash（loadURL 或 location.hash 都一樣）會立刻彈回聊天列表。
// 要換聊天室只能整頁重載；重載時網址也會走「聊天室 → 列表 → 聊天室」，有時最後還停在列表（真實 Web A 量到的），都不是使用者去的
const SETTLE_MS = 15000
// 看不到超過這麼久才收，只留第一格連線收通知；其他格導到 about:blank 放掉網頁（每格約 150–200MB，導走時正常交棒）
const PARK_AFTER_MS = 60 * 60 * 1000
// 在格子裡跑：重載後長得跟現在一樣才收——有打到一半的字，或往上翻著舊訊息，重載會變樣，就留著
const CAN_PARK_PROBE = `(() => {
  if (document.getElementById('editable-message-text')?.textContent.trim()) return false
  const list = document.querySelector('.MessageList')
  return !list || list.scrollHeight - list.scrollTop - list.clientHeight < 80
})()`

// 在格子裡跑：Web A 只要失焦就當自己在背景（新訊息不捲到底、不標已讀，全部失焦還向伺服器回報離線）。
// 但 webview 的焦點常在側欄或另一格：畫面上看得到時，失焦就立刻補回 focus
const KEEP_FOREGROUND = `window.__axKeepForeground || (window.__axKeepForeground = true, window.addEventListener('blur', () => {
  setTimeout(() => { if (window.__axForeground) window.dispatchEvent(new Event('focus')) })
}))`

let initialized = false
let loading = false
/** 第一次開 Telegram 一定是使用者在 App 裡點的，所以先當在前景 */
let appFocused = true
let pageVisible = true
/** AI 頁主區現在是不是 Telegram（對話、專案、瀏覽器都在同一頁） */
let paneVisible = true
let hiddenSince = 0
/** 收掉的格子：切回來照 dataset.src 載回 @type {Set<HTMLElement>} */
const parked = new Set()
/** 正在載入、還沒穩定的格子 @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>} */
const settling = new WeakMap()
/** 載入後被 Web A 彈回列表的格子：記住的聊天室留著下次開，但不一直重載 @type {WeakSet<HTMLElement>} */
const bounced = new WeakSet()
let stuckSince = 0
let lastReloadAllAt = 0

/** 只收 Telegram 網頁版自己的網址；設定檔壞掉或被改過就回首頁 */
function safeUrl(value) {
  return typeof value === 'string' && value.startsWith(HOME_URL) ? value : HOME_URL
}

async function loadSaved() {
  try {
    const list = await electronAPI.store.get(STORE_KEY, [])
    if (Array.isArray(list) && list.length) return list.slice(0, MAX_PANES).map(safeUrl)
  } catch (error) {
    console.error('[telegram] 讀不到上次的格子:', error)
  }
  return [HOME_URL, HOME_URL]
}

function frame() {
  return document.getElementById('telegramFrame')
}

/** 每格保留使用者最後停留的網址，背景導覽不覆蓋它 */
function paneUrl(pane) {
  return pane.querySelector('webview')?.dataset.src || HOME_URL
}

function save() {
  const urls = [...frame().querySelectorAll('.telegram-pane')].map(paneUrl)
  electronAPI.store.set(STORE_KEY, urls).catch((error) => {
    console.error('[telegram] 存不了格子:', error)
  })
}

/** ✕ 只剩一格時不給關；＋ 只放在最右邊那格、滿了就收起來 */
function paintBars() {
  const panes = [...frame().querySelectorAll('.telegram-pane')]
  panes.forEach((pane, index) => {
    pane.querySelector('.telegram-pane-close').hidden = panes.length <= 1
    pane.querySelector('.telegram-pane-add').hidden = index !== panes.length - 1 || panes.length >= MAX_PANES
  })
}

function barButton(className, text, label, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `btn-icon ${className}`
  btn.textContent = text
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.addEventListener('click', onClick)
  return btn
}

const isOnScreen = () => pageVisible && paneVisible
const isShown = () => isOnScreen() && !document.hidden
const isHome = (url) => url.replace(/#$/, '') === HOME_URL

/** Telegram 在畫面上且 App 在前景才算使用者在看；其餘照實告訴 Web A 在背景（回報離線、不標已讀） */
function syncForeground() {
  const foreground = isShown() && appFocused
  for (const view of frame().querySelectorAll('webview')) {
    try {
      view.executeJavaScript(`window.__axForeground = ${foreground}; window.dispatchEvent(new Event('${foreground ? 'focus' : 'blur'}')); 1`).catch(() => {})
    } catch { /* 還沒載好：dom-ready 會補 */ }
  }
}

/** 使用者看得到時，這格現在的網址就是他停的地方 */
function rememberUrl(view, url) {
  if (!isShown() || url === 'about:blank') return // about:blank 是關格子、重載、收格子的過渡頁
  bounced.delete(view)
  view.dataset.src = safeUrl(url)
  save()
}

/** 載入中先不把「回到列表」當成使用者去的（見 SETTLE_MS）；穩定後還在列表也不蓋掉記住的聊天室，只是不再重載它 */
function settle(view) {
  clearTimeout(settling.get(view))
  bounced.delete(view)
  settling.set(view, setTimeout(() => {
    settling.delete(view)
    let url = ''
    try { url = view.getURL() } catch { return } // 格子已經拿掉
    if (isHome(url) && !isHome(view.dataset.src)) bounced.add(view)
    else rememberUrl(view, url)
  }, SETTLE_MS))
}

/** 全部格子先卸載再同時載回原本的聊天室（理由見 WATCH_EVERY_MS 上面） */
async function reloadAll(why) {
  if (Date.now() - lastReloadAllAt < RELOAD_ALL_GAP_MS) return
  lastReloadAllAt = Date.now()
  stuckSince = 0
  parked.clear()
  console.warn('[telegram] 全部格子重載:', why)
  const views = [...frame().querySelectorAll('webview')]
  const urls = views.map((view) => view.dataset.src)
  await Promise.allSettled(views.map((view) => view.loadURL('about:blank')))
  views.forEach((view, index) => {
    settle(view)
    view.loadURL(urls[index]).catch(() => {})
  })
}

/** 只重載一格回原本的聊天室：先導走才是整頁重載（只改 hash 會被彈回列表，見 SETTLE_MS） */
async function reloadPane(view, url) {
  settle(view)
  await view.loadURL('about:blank').catch(() => {})
  await view.loadURL(url)
}

/** 第一格以外閒置夠久就收掉；正在出聲（通話、語音）或收了會變樣的不收 */
async function parkIdle() {
  if (isShown() || !hiddenSince || Date.now() - hiddenSince < PARK_AFTER_MS) return
  for (const view of [...frame().querySelectorAll('webview')].slice(1)) {
    if (parked.has(view)) continue
    try {
      if (view.isCurrentlyAudible() || !await view.executeJavaScript(CAN_PARK_PROBE) || isShown()) continue
      parked.add(view)
      await view.loadURL('about:blank')
    } catch (error) {
      parked.delete(view)
      console.error('[telegram] 收格子失敗:', error)
    }
  }
}

async function watchStuck() {
  syncForeground() // Web A 主程式比 dom-ready 晚載，掛載時會自己當成背景，這裡補回來
  void parkIdle()
  if (!isOnScreen()) { stuckSince = 0; return }
  let stuck = false
  for (const view of frame().querySelectorAll('webview')) {
    try {
      if (await view.executeJavaScript(STUCK_PROBE)) stuck = true
    } catch { /* 還沒載好或正在重載 */ }
  }
  if (!isOnScreen()) return
  if (!stuck) {
    stuckSince = 0
  } else if (!stuckSince) {
    stuckSince = Date.now()
  } else if (Date.now() - stuckSince >= STUCK_MS) {
    reloadAll('卡在等待網路連線或更新中')
  }
}

/** 切走（換頁、最小化）開始算閒置；切回來把收掉的載回、背景被 Web A 改掉網址的格子帶回原本的聊天室 */
function onVisibilityChanged() {
  stuckSince = 0
  syncForeground()
  if (!isShown()) {
    hiddenSince ||= Date.now()
    return
  }
  hiddenSince = 0
  for (const view of frame().querySelectorAll('webview')) {
    try {
      const url = view.dataset.src
      const currentUrl = view.getURL()
      const wasParked = parked.delete(view)
      if (bounced.has(view) && !wasParked) continue
      if (currentUrl && currentUrl !== url && (wasParked || currentUrl !== 'about:blank')) {
        reloadPane(view, url).catch((error) => console.error('[telegram] 還原聊天室失敗:', error))
      }
    } catch { /* 還沒載好的格子會沿用建立時的網址 */ }
  }
}

function onPageVisibility(visible) {
  pageVisible = visible
  onVisibilityChanged()
}

/** @param {boolean} visible */
export function setTelegramPaneVisible(visible) {
  if (paneVisible === visible) return
  paneVisible = visible
  if (initialized) onVisibilityChanged()
}

/**
 * 直接拿掉 webview 不會觸發頁面的 beforeunload：這格若是 Web A 負責連線的主分頁，
 * 其他格收不到交棒通知、全部卡在連線中。先導到 about:blank 讓它正常卸載再拿掉。
 */
function closePane(pane) {
  const view = pane.querySelector('webview')
  if (!view) { pane.remove(); save(); paintBars(); return } // 收掉中的格子：沒有頁面要卸載
  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    pane.remove()
    save()
    paintBars()
  }
  view.addEventListener('did-navigate', remove, { once: true })
  setTimeout(remove, 1500)
  try {
    view.loadURL('about:blank').catch(remove)
  } catch {
    remove() // 還在排隊、沒載過的格子：沒有頁面要卸載
  }
}

/** @param {string} url */
function addPane(url) {
  const pane = document.createElement('div')
  pane.className = 'telegram-pane'

  const bar = document.createElement('div')
  bar.className = 'telegram-pane-bar'
  bar.append(
    barButton('telegram-pane-add', '＋', '往右再開一格', () => {
      addPane(HOME_URL)
      save()
    }),
    barButton('telegram-pane-close', '✕', '關掉這一格', () => closePane(pane))
  )

  pane.append(bar)
  frame().appendChild(pane)
  paintBars()
  mountView(pane, url)
}

function mountView(pane, url) {
  const view = document.createElement('webview')
  // partition 建了就不能改，要在插入前設好；popup（外部連結）由 main 轉系統瀏覽器
  view.setAttribute('partition', 'persist:telegram')
  view.setAttribute('allowpopups', '')
  view.dataset.src = url
  const remember = (event) => {
    if (/** @type {any} */ (event).isMainFrame === false) return
    const url = /** @type {any} */ (event).url
    if (isHome(url) && settling.has(view)) return
    rememberUrl(view, url)
  }
  view.addEventListener('did-navigate', remember)
  view.addEventListener('did-navigate-in-page', remember)
  view.addEventListener('dom-ready', () => {
    view.executeJavaScript(DIRECT_LINKS).catch((error) => console.error('[telegram] 連結直開掛不上:', error))
    view.executeJavaScript(SEND_SCROLL).catch((error) => console.error('[telegram] 送出後捲到底掛不上:', error))
    view.executeJavaScript(KEEP_FOREGROUND).catch((error) => console.error('[telegram] 前景狀態掛不上:', error))
    syncForeground()
  })
  // 當掉的若是主分頁，其他格收不到交棒通知，只重載這一格也會被它們帶回死掉的主分頁
  view.addEventListener('render-process-gone', (event) => {
    reloadAll(`格子的程序不見了（${/** @type {any} */ (event).details?.reason || 'unknown'}）`)
  })

  pane.append(view)
  settle(view)
  view.setAttribute('src', url) // 幾格同時載，不排隊
}

/** 第一次切進來才建：沒點過 Telegram 就不去連線；彈成獨立視窗後收掉，回來再照存檔建 */
export async function refreshTelegramPage() {
  if (!frame() || loading || frame().children.length) return
  loading = true
  if (!initialized) {
    initialized = true
    electronAPI.pages.onVisibility(onPageVisibility)
    electronAPI.pages.onAppFocus((focused) => {
      appFocused = focused
      syncForeground()
    })
    document.addEventListener('visibilitychange', onVisibilityChanged)
    setInterval(watchStuck, WATCH_EVERY_MS)
  }
  ;(await loadSaved()).forEach(addPane)
  loading = false
}

/** 要彈成獨立視窗：這邊全部卸載交棒（見 closePane），聊天室已存在 telegramPanes，那邊照著開 */
export async function closeTelegramPanes() {
  const panes = [...(frame()?.querySelectorAll('.telegram-pane') || [])]
  parked.clear()
  const unload = async (pane) => { await pane.querySelector('webview').loadURL('about:blank') }
  await Promise.race([Promise.allSettled(panes.map(unload)), new Promise((resolve) => setTimeout(resolve, 1500))])
  panes.forEach((pane) => pane.remove())
}

/** 獨立視窗那份：格子改放進 #page-telegram（AI 頁主區在這個視窗看不到） */
export function mountTelegramPopup() {
  document.getElementById('page-telegram')?.append(frame())
  return refreshTelegramPage()
}
