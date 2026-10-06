/**
 * 滑鼠側鍵（上一頁／下一頁）：像瀏覽器一樣在 App 裡來回。
 * 先讓目前的頁面自己退（檔案頁的資料夾歷史），退不了才走 App 層的「足跡」：
 * 哪一頁＋AI 頁主區是對話／工作區／網頁版＋哪一則對話。
 * webview 裡按的側鍵進不到這份 DOM——main 先讓那個網頁自己上一頁，退到底才轉回來（nav:side）。
 */
import { electronAPI, switchPage, setChatPaneMode, getChatPaneMode } from './app.js'
import { currentChatId, openChatById } from './chat-page.js'

const MAX_STEPS = 50

/** @type {Array<{ page: string, pane: string, chatId: string }>} */
let steps = []
let index = -1
let restoring = false

function here() {
  const page = /** @type {HTMLElement | null} */ (document.querySelector('.nav-tab.active'))?.dataset.page || ''
  if (page !== 'chat') return { page, pane: '', chatId: '' }
  const pane = getChatPaneMode()
  return { page, pane, chatId: pane === 'workspace' ? '' : currentChatId() }
}

/** 切頁、切主區、開對話之後叫；跟目前這一步一樣就不記 */
export function noteLocation() {
  if (restoring) return
  const loc = here()
  const cur = steps[index]
  const samePane = cur && cur.page === loc.page && cur.pane === loc.pane
  if (!loc.page || (samePane && cur.chatId === loc.chatId)) return
  // 啟動或新增對話時先記到「還沒選對話」，緊接著才知道是哪一則：補上去，不多一步空的
  if (samePane && !cur.chatId) {
    steps = steps.map((s, i) => (i === index ? loc : s))
    return
  }
  steps = [...steps.slice(0, index + 1), loc].slice(-MAX_STEPS)
  index = steps.length - 1
}

/** @param {{ page: string, pane: string, chatId: string }} loc */
async function restore(loc) {
  switchPage(loc.page)
  if (loc.page !== 'chat') return
  if (loc.chatId) await openChatById(loc.chatId)
  else setChatPaneMode(/** @type {'chat' | 'workspace' | 'web'} */ (loc.pane))
}

/** @param {number} delta -1 上一頁、1 下一頁 */
async function go(delta) {
  if (document.querySelector('.ws-menu, dialog[open]')) return
  // 檔案頁一定已經載過（正在顯示）；其他頁不必為了這個把它拉進來
  if (here().page === 'explorer' && (await import('./explorer-page.js')).explorerHistory(delta)) return
  noteLocation()
  const next = index + delta
  if (next < 0 || next >= steps.length) return
  index = next
  restoring = true
  try {
    await restore(steps[next])
  } finally {
    restoring = false
  }
}

/** @param {MouseEvent} e */
function onSideButton(e) {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  e.stopPropagation()
  if (e.type === 'mouseup') void go(e.button === 3 ? -1 : 1)
}

export function initNavHistory() {
  for (const type of ['mousedown', 'mouseup', 'auxclick']) document.addEventListener(type, onSideButton, true)
  electronAPI.window?.onSideNav?.((delta) => void go(delta === -1 ? -1 : 1))
  noteLocation()
}
