import { electronAPI, getChatPaneMode, setChatPaneMode } from './app.js'
import { openChatMenu } from './chat-menu.js'
import { navigateToPage } from './page-windows.js'

/**
 * Chat 側欄最上面的入口（新增對話那排、Arena、Telegram）可以選要顯示哪些。
 * 存的是「藏起來的」，以後新增入口預設會顯示。
 */
const HIDDEN_KEY = 'chatLaunchersHidden'
const LAUNCHERS = Object.freeze([
  { id: 'local', label: 'Local', selector: '#chatNewBtn' },
  { id: 'chatgpt', label: 'ChatGPT', selector: '.ai-web-btn[data-ai-web="chatgpt"]' },
  { id: 'gemini', label: 'Gemini', selector: '.ai-web-btn[data-ai-web="gemini"]' },
  { id: 'claude', label: 'Claude', selector: '.ai-web-btn[data-ai-web="claude"]' },
  { id: 'grok', label: 'Grok', selector: '.ai-web-btn[data-ai-web="grok"]' },
  { id: 'deepseek', label: 'DeepSeek', selector: '.ai-web-btn[data-ai-web="deepseek"]' },
  { id: 'meta', label: 'Meta AI', selector: '.ai-web-btn[data-ai-web="meta"]' },
  { id: 'arena', label: 'Arena', selector: '#chatArenaBtn' },
  { id: 'telegram', label: 'Telegram', selector: '#chatTelegramBtn' }
])

/** @type {Set<string>} */
let hidden = new Set()
/** 現在彈成獨立視窗的頁（main 的 pages:state） @type {string[]} */
let detached = []

function loadHidden() {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')
    return new Set(Array.isArray(saved) ? saved : [])
  } catch {
    return new Set() // 沒有 storage 或內容壞掉：全部顯示
  }
}

function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]))
  } catch {
    // 沒有 storage 就只是這次有效
  }
}

/** 整排都藏起來時連空白也收掉；Arena、Telegram 都顯示時各佔一半 */
function paint() {
  for (const { id, selector } of LAUNCHERS) {
    const el = /** @type {HTMLElement | null} */ (document.querySelector(selector))
    if (el) el.hidden = hidden.has(id)
  }
  for (const selector of ['.chat-panel-actions', '.chat-pinned']) {
    const group = /** @type {HTMLElement | null} */ (document.querySelector(selector))
    if (!group) continue
    const shown = [...group.children].filter((el) => !(/** @type {HTMLElement} */ (el).hidden)).length
    group.hidden = shown === 0
    group.classList.toggle('is-split', shown > 1)
  }
}

/** 選一項就關的選單：勾完馬上再開，才能連續勾好幾個 @param {HTMLElement} anchor */
function openEditor(anchor) {
  openChatMenu(anchor, LAUNCHERS.map(({ id, label }) => ({
    label,
    checked: !hidden.has(id),
    onSelect: () => {
      hidden = new Set(hidden.has(id) ? [...hidden].filter((item) => item !== id) : [...hidden, id])
      saveHidden()
      paint()
      openEditor(anchor)
    }
  })))
}

const openArena = () => import('./ai-web-page.js').then((m) => m.openArena())
const openTelegram = () => setChatPaneMode('telegram')

/**
 * 主區這份收掉（網頁沒辦法搬到別的視窗），正看著就退回對話，再開獨立視窗。
 * @param {'arena'|'telegram'} page
 * @param {() => unknown} leavePane
 */
async function popOut(page, leavePane) {
  const showing = page === 'telegram'
    ? getChatPaneMode() === 'telegram'
    : getChatPaneMode() === 'web' && !!document.querySelector('#chatPanel.is-arena')
  if (showing) await leavePane()
  if (page === 'telegram') await (await import('./telegram-page.js')).closeTelegramPanes()
  else (await import('./ai-web-page.js')).releaseArena()
  await navigateToPage({ page }, true)
}

/**
 * 點一下：獨立視窗開著就叫到前面，否則在主區開；右鍵：彈成獨立視窗。
 * @param {string} id
 * @param {'arena'|'telegram'} page
 * @param {() => unknown} open
 * @param {() => unknown} leavePane
 */
function bindPinned(id, page, open, leavePane) {
  const btn = document.getElementById(id)
  btn?.addEventListener('click', () => void (detached.includes(page) ? navigateToPage({ page }) : open()))
  btn?.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void popOut(page, leavePane)
  })
}

/** @param {() => unknown} leavePane 退回目前那則對話 */
export function initChatLaunchers(leavePane) {
  hidden = loadHidden()
  paint()
  electronAPI.pages?.onState((state) => { detached = state.detached })
  bindPinned('chatArenaBtn', 'arena', openArena, leavePane)
  bindPinned('chatTelegramBtn', 'telegram', openTelegram, leavePane)
  const edit = document.getElementById('chatLauncherEditBtn')
  edit?.addEventListener('click', () => openEditor(edit))
}
