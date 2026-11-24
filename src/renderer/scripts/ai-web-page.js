import { electronAPI, setChatPaneMode } from './app.js'

/**
 * 網頁版 AI 對話（ChatGPT／Gemini／Claude／Grok／DeepSeek／Meta AI）：官方網頁放進 <webview>（比照 Telegram 頁）。
 *
 * - 每一則就是側欄裡的一個對話（chats.json 的 `web`），跟 Local 一樣能多開、改名、搬資料夾。
 * - 同一家共用 `persist:ai-<site>` 登入分區：登入一次，該家每一則都是登入狀態。
 * - webview 換頁就回報 main 存成這則的網址（main 擋登入頁與別的網域），下次點、App 重開都回到原本那頁；
 *   分頁標題也回報，使用者沒改過名就拿來當側欄標題。
 * - 第一次打開才建；切換時保留頁面，關閉對話、當機、或閒置超過 1 小時（`sleepIdleAiWeb`）才收掉，點回來照網址重建。
 * - 開著的那幾則每 2 秒看有沒有「停止」鈕（`pollAiWebStatus`）：有＝生成中；消失時沒在看＝完成未讀，交給側欄顯示。
 */

const HOMES = /** @type {Record<string, string>} */ ({
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  claude: 'https://claude.ai/new',
  grok: 'https://grok.com/',
  deepseek: 'https://chat.deepseek.com/',
  meta: 'https://www.meta.ai/',
  arena: 'https://llm-arena-opal.vercel.app/'
})
// Arena 只有一個（不像四家網頁版每按一次多一則）、不進對話清單，網址與標題不存
const ARENA_ID = '__arena'
// ponytail: 靠 Gemini 頁面的 class／屬性抓對話標題，改版就抓不到（退回不取標題，不會出錯）
const GEMINI_TITLE = `(document.querySelector('[data-test-id="conversation-title"], .conversation-title-container, .conversation.selected .conversation-title')?.textContent
  || document.querySelector('user-query .query-text, user-query')?.textContent || '').trim().slice(0, 60)`

// ponytail: 靠官方網頁的按鈕標籤認生成中，改版就抓不到（退回不顯示狀態，不會出錯）
const STOP_BUTTON = '[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]'
const IS_GENERATING = `!!document.querySelector('${STOP_BUTTON}')`
const STATUS_EVERY_MS = 2000
const SLEEP_AFTER_MS = 60 * 60 * 1000
const SWEEP_MS = 5 * 60 * 1000
// 在 webview 裡跑：重開後長得跟現在一樣才收。打到一半的字、還在生成、往上翻著舊對話，收了都會變樣，留著
const CAN_SLEEP_PROBE = `(() => {
  const fields = document.querySelectorAll('textarea, [contenteditable="true"]')
  if ([...fields].some((el) => (el.value ?? el.textContent ?? '').trim())) return false
  if (${IS_GENERATING}) return false
  const scrolled = (el) => el.scrollHeight - el.clientHeight > 80 && el.scrollHeight - el.scrollTop - el.clientHeight > 80
  const isScroller = (el) => /auto|scroll/.test(getComputedStyle(el).overflowY)
  const inner = [...document.querySelectorAll('main, main *, [class*="scroll" i]')].some((el) => scrolled(el) && isScroller(el))
  return !inner && !scrolled(document.scrollingElement)
})()`

/** 目前顯示的那一則 @type {{ id: string, site: string, url: string } | null} */
let current = null
/** @type {Map<string, { pane: HTMLElement }>} */
const live = new Map()
/** @type {Map<string, number>} */
const crashedAt = new Map()
/** 被切走的時間（目前顯示的那則不在裡面） @type {Map<string, number>} */
const hiddenAt = new Map()
/** 正在生成的那幾則 @type {Set<string>} */
const generating = new Set()
let sweeper = 0
/** 標題變了要叫側欄重讀（chat-page 給） */
let onTitle = () => {}
/** 生成狀態變了告訴側欄（chat-page 給） @type {(id: string, state: 'running'|'done'|'') => void} */
let onStatus = () => {}

function host() {
  return document.getElementById('aiWebMain')
}

function build({ id, site, url }) {
  const pane = document.createElement('div')
  pane.className = 'ai-web-pane'
  pane.dataset.convId = id
  const view = /** @type {any} */ (document.createElement('webview'))
  // partition 建了就不能改，插入前設好。UA、權限、瀏覽器特徵在 main 依分區設（ai-web.js 的 setupSession）；
  // popup：登入小視窗留在 App，其他外部連結由 main 轉系統瀏覽器
  view.setAttribute('partition', `persist:ai-${site}`)
  view.setAttribute('allowpopups', '')
  const remember = (event) => {
    if (id === ARENA_ID) return
    if (!event.url.startsWith(new URL(HOMES[site]).origin)) return // 登入、OAuth 在別的網域
    if (current?.id === id) current = { ...current, url: event.url } // 當掉重建時接著這頁
    electronAPI.chat.setWebUrl(id, event.url).catch((error) => console.error('[ai-web] 存不了網址:', error))
  }
  view.addEventListener('did-navigate', remember)
  view.addEventListener('did-navigate-in-page', (event) => {
    if (event.isMainFrame) remember(event)
  })
  // 分頁標題回報給 main（只有在真正的對話頁才會被拿來當側欄標題）
  const reportTitle = async (title) => {
    if (id === ARENA_ID) return
    try {
      const text = site === 'gemini' ? (await view.executeJavaScript(GEMINI_TITLE)) || title : title
      if (await electronAPI.chat.setWebTitle(id, text, view.getURL())) onTitle()
    } catch (error) {
      console.error('[ai-web] 存不了標題:', error)
    }
  }
  view.addEventListener('page-title-updated', (event) => void reportTitle(event.title))
  // Gemini 的分頁標題永遠是「Google Gemini」，換到對話頁後隔一下再去頁面上讀標題
  if (site === 'gemini') {
    view.addEventListener('did-navigate-in-page', (event) => {
      if (!event.isMainFrame) return
      for (const ms of [2000, 10000]) setTimeout(() => void reportTitle(''), ms)
    })
  }
  // 當掉就收掉重建；一分鐘內又當一次就不自動重建（避免一直當一直重開），等使用者再點
  view.addEventListener('render-process-gone', () => {
    const again = Date.now() - (crashedAt.get(id) || 0) < 60_000
    crashedAt.set(id, Date.now())
    release(id)
    if (!again) void showAiWeb()
  })
  view.setAttribute('src', url || HOMES[site])
  pane.appendChild(view)
  host().appendChild(pane)
  if (!sweeper) {
    sweeper = window.setInterval(() => void sleepIdleAiWeb(Date.now()), SWEEP_MS)
    window.setInterval(() => void pollAiWebStatus(), STATUS_EVERY_MS)
  }
  const entry = { pane }
  live.set(id, entry)
  return entry
}

/** 收掉一則：網址早就存了，直接拿掉 webview（guest 程序跟著結束） */
export function releaseAiWeb(id) {
  release(id)
}

function release(id) {
  const entry = live.get(id)
  if (!entry) return
  live.delete(id)
  hiddenAt.delete(id)
  entry.pane.remove()
  if (generating.delete(id)) onStatus(id, '')
}

/** 看每則開著的網頁在不在生成；生成完使用者正看著就不算未讀 */
export async function pollAiWebStatus() {
  for (const [id, entry] of [...live]) {
    if (id === ARENA_ID) continue
    let busy
    try {
      busy = await /** @type {any} */ (entry.pane.querySelector('webview')).executeJavaScript(IS_GENERATING)
    } catch {
      continue // 還沒載好或正在當機，下一輪再看
    }
    if (!live.has(id) || busy === generating.has(id)) continue
    if (busy) {
      generating.add(id)
      onStatus(id, 'running')
    } else {
      generating.delete(id)
      const seen = current?.id === id && !host().classList.contains('hidden') && !document.hidden
      onStatus(id, seen ? '' : 'done')
    }
  }
}

/** @param {string} id @param {any} view @param {number} now 這則現在能不能收 */
async function canSleep(id, view, now) {
  if (id === current?.id || id === ARENA_ID || now - (hiddenAt.get(id) ?? now) < SLEEP_AFTER_MS) return false
  try {
    return !view.isCurrentlyAudible() && (await view.executeJavaScript(CAN_SLEEP_PROBE)) === true
  } catch {
    return false // 還沒載好或正在當機，下一輪再看
  }
}

/**
 * 收掉太久沒看的網頁版對話，回傳收了幾則。網址早就存在 chats.json，點回來由 openAiWeb 照網址重建。
 * @param {number} now
 */
export async function sleepIdleAiWeb(now) {
  let slept = 0
  for (const [id, entry] of [...live]) {
    const view = entry.pane.querySelector('webview')
    if (!await canSleep(id, view, now) || id === current?.id) continue
    release(id)
    slept++
  }
  return slept
}

/** 主區切到網頁模式時（app.js 的 setChatPaneMode）叫：顯示目前那一則，被收掉了就照網址重建 */
export async function showAiWeb() {
  if (!current || !host() || host().classList.contains('hidden')) return
  for (const [id, entry] of live) {
    entry.pane.hidden = id !== current.id
    if (id === current.id) hiddenAt.delete(id)
    else if (!hiddenAt.has(id)) hiddenAt.set(id, Date.now())
  }
  document.getElementById('chatPanel')?.classList.toggle('is-arena', current.id === ARENA_ID)
  const entry = live.get(current.id) || build(current)
  entry.pane.hidden = false
}

/**
 * 側欄點到網頁版對話（chat-page 的 openConversation 叫）
 * @param {{ id: string, web: { site: string, url: string } }} conv
 * @param {() => void} titleChanged
 * @param {(id: string, state: 'running'|'done'|'') => void} statusChanged
 */
export function openAiWeb(conv, titleChanged, statusChanged) {
  if (!conv?.web || !Object.hasOwn(HOMES, conv.web.site)) return
  current = { id: conv.id, site: conv.web.site, url: conv.web.url }
  onTitle = titleChanged
  onStatus = statusChanged
  setChatPaneMode('web') // 會回頭叫 showAiWeb
}

/** 要彈成獨立視窗：這邊那份收掉 */
export function releaseArena() {
  if (current?.id === ARENA_ID) current = null
  release(ARENA_ID)
}

/** 獨立視窗那份：Arena 改放進 #page-arena（AI 頁主區在這個視窗看不到） */
export function mountArenaPopup() {
  document.getElementById('page-arena')?.append(host())
  openArena()
}

/** 側欄 Arena 鈕：切到唯一那個 Arena（第一次才建，之後切走切回都是同一頁） */
export function openArena() {
  current = { id: ARENA_ID, site: 'arena', url: '' }
  setChatPaneMode('web')
}
