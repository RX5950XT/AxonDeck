import { electronAPI } from './app.js'

/**
 * 專案瀏覽器工具列的擴充功能圖示列（跟 Chrome 一樣：圖示＋右下角徽章）。
 * 圖示、標題、徽章由 main 依目前分頁算好（browser-extensions.js 的 `actions`）；
 * 左鍵開 popup（或送 action.onClicked），右鍵叫整組「擴充功能」選單。
 */

/** @type {HTMLElement | null} */
let host = null
/** @type {() => number | null} */
let guestId = () => null
let timer = 0
let seq = 0

/**
 * @param {HTMLElement | null} container
 * @param {() => number | null} getGuestId 目前那顆瀏覽器 webview 的 webContents id
 */
export function initBrowserActions(container, getGuestId) {
  host = container
  guestId = getGuestId
  if (!host) return
  electronAPI.workspace.onExtensionsChanged(refreshBrowserActions)
  refreshBrowserActions()
}

/** 換分頁、載入完、擴充功能改了徽章都叫；短時間內多次只抓一次 */
export function refreshBrowserActions() {
  if (!host) return
  clearTimeout(timer)
  timer = window.setTimeout(() => void paint(), 120)
}

async function paint() {
  const mine = ++seq
  let rows = []
  try {
    rows = await electronAPI.workspace.extensionActions(guestId())
  } catch (error) {
    console.error('[browser-actions] 讀不到擴充功能:', error)
  }
  if (mine !== seq || !host) return // 等的時候又換了分頁，用較新那次
  host.replaceChildren(...rows.map(actionButton))
  host.hidden = !rows.length
}

function anchorOf(btn) {
  const { x, y, width, height } = btn.getBoundingClientRect()
  return { x, y, width, height }
}

/** @param {{ id: string, title: string, badge: string, color: string, icon: string }} row */
function actionButton(row) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn-icon ws-browser-action'
  btn.title = row.badge ? `${row.title}（${row.badge}）` : row.title
  btn.setAttribute('aria-label', btn.title)
  if (row.icon) {
    const img = document.createElement('img')
    img.src = row.icon
    img.alt = ''
    btn.append(img)
  } else {
    btn.textContent = row.title.slice(0, 1) // 沒有圖示就放名稱第一個字
  }
  if (row.badge) {
    const badge = document.createElement('span')
    badge.className = 'ws-browser-action-badge'
    badge.textContent = row.badge.slice(0, 4)
    if (row.color) badge.style.background = row.color
    btn.append(badge)
  }
  btn.addEventListener('click', () => {
    const id = guestId()
    if (id != null) void electronAPI.workspace.extensionActivate(id, row.id, anchorOf(btn))
  })
  btn.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void electronAPI.workspace.extensionsMenu(guestId(), anchorOf(btn))
  })
  return btn
}
