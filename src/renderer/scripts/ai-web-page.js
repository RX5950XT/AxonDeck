import { electronAPI, setChatPaneMode } from './app.js'

/**
 * 網頁版 AI 對話（ChatGPT／Gemini／Claude／Grok）：官方網頁放進 <webview>（比照 Telegram 頁）。
 *
 * - 每一則就是側欄裡的一個對話（chats.json 的 `web`），跟 Local 一樣能多開、改名、搬資料夾。
 * - 同一家共用 `persist:ai-<site>` 登入分區：登入一次，該家每一則都是登入狀態。
 * - webview 換頁就回報 main 存成這則的網址（main 擋登入頁與別的網域），下次點、App 重開都回到原本那頁；
 *   分頁標題也回報，使用者沒改過名就拿來當側欄標題。
 * - 第一次打開才建；沒在看的過 RELEASE_MS 就整個收掉（一則約 200–400MB），再點照存的網址載回來。
 */

const HOMES = /** @type {Record<string, string>} */ ({
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  claude: 'https://claude.ai/new',
  grok: 'https://grok.com/'
})
// ponytail: 固定 5 分鐘、每 30 秒掃一次；要可調再進設定
const RELEASE_MS = 5 * 60 * 1000
const SWEEP_EVERY_MS = 30 * 1000

// ponytail: 靠 Gemini 頁面的 class／屬性抓對話標題，改版就抓不到（退回不取標題，不會出錯）
const GEMINI_TITLE = `(document.querySelector('[data-test-id="conversation-title"], .conversation-title-container, .conversation.selected .conversation-title')?.textContent
  || document.querySelector('user-query .query-text, user-query')?.textContent || '').trim().slice(0, 60)`

/** 目前顯示的那一則 @type {{ id: string, site: string, url: string } | null} */
let current = null
/** @type {Map<string, { pane: HTMLElement, hiddenSince: number }>} */
const live = new Map()
/** @type {Map<string, number>} */
const crashedAt = new Map()
let sweepTimer = 0
/** 標題變了要叫側欄重讀（chat-page 給） */
let onTitle = () => {}

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
  const entry = { pane, hiddenSince: 0 }
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
  entry.pane.remove()
}

function sweep() {
  const now = Date.now()
  for (const [id, entry] of live) {
    if (entry.pane.offsetParent !== null) entry.hiddenSince = 0
    else if (!entry.hiddenSince) entry.hiddenSince = now
    else if (now - entry.hiddenSince >= RELEASE_MS) release(id)
  }
  if (!live.size) {
    clearInterval(sweepTimer)
    sweepTimer = 0
  }
}

/** 主區切到網頁模式時（app.js 的 setChatPaneMode）叫：顯示目前那一則，被收掉了就照網址重建 */
export async function showAiWeb() {
  if (!current || !host() || host().classList.contains('hidden')) return
  for (const [id, entry] of live) entry.pane.hidden = id !== current.id
  const entry = live.get(current.id) || build(current)
  entry.pane.hidden = false
  entry.hiddenSince = 0
  if (!sweepTimer) sweepTimer = window.setInterval(sweep, SWEEP_EVERY_MS)
}

/**
 * 側欄點到網頁版對話（chat-page 的 openConversation 叫）
 * @param {{ id: string, web: { site: string, url: string } }} conv
 * @param {() => void} titleChanged
 */
export function openAiWeb(conv, titleChanged) {
  if (!conv?.web || !Object.hasOwn(HOMES, conv.web.site)) return
  current = { id: conv.id, site: conv.web.site, url: conv.web.url }
  onTitle = titleChanged
  setChatPaneMode('web') // 會回頭叫 showAiWeb
}
