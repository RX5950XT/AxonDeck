/**
 * 瀏覽器工具列的擴充功能圖示列（跟 Chrome 一樣：圖示＋右下角徽章）。
 * 圖示、標題、徽章由 main 依目前分頁算好（browser-extensions.js 的 `actions`）；
 * 左鍵開 popup（或送 action.onClicked），右鍵叫整組「擴充功能」選單。
 * 專案瀏覽器、Browser 模式、彈出的獨立視窗各一組（createBrowserActions）。
 * 不 import app.js：彈出視窗只有工具列，載整份 App 會把功能頁全部初始化一遍。
 */

/**
 * @typedef {{
 *   extensionActions: (guestId: number | null) => Promise<any[]>,
 *   extensionActivate: (guestId: number, extensionId: string, anchor: object) => Promise<unknown>,
 *   extensionsMenu: (guestId: number | null, anchor: object) => Promise<unknown>,
 *   onExtensionsChanged: (callback: () => void) => unknown
 * }} ActionsApi
 */

/**
 * @param {HTMLElement | null} host
 * @param {() => number | null} guestId 目前那顆瀏覽器 webview 的 webContents id
 * @param {ActionsApi} [api] 預設是主視窗的 electronAPI.workspace
 * @returns {() => void} refresh：換分頁、載入完都叫；短時間內多次只抓一次
 */
export function createBrowserActions(host, guestId, api = window.electronAPI?.workspace) {
  if (!host || !api) return () => {}
  let timer = 0
  let seq = 0

  async function paint() {
    const mine = ++seq
    let rows = []
    try {
      rows = await api.extensionActions(guestId())
    } catch (error) {
      console.error('[browser-actions] 讀不到擴充功能:', error)
    }
    if (mine !== seq || !host) return // 等的時候又換了分頁，用較新那次
    host.replaceChildren(...rows.map((row) => actionButton(row, guestId, api)))
    host.hidden = !rows.length
  }

  const refresh = () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => void paint(), 120)
  }
  api.onExtensionsChanged(refresh)
  refresh()
  return refresh
}

/** 專案瀏覽器那一組 */
let refreshWorkspace = () => {}

/**
 * @param {HTMLElement | null} container
 * @param {() => number | null} getGuestId
 */
export function initBrowserActions(container, getGuestId) {
  refreshWorkspace = createBrowserActions(container, getGuestId)
}

export function refreshBrowserActions() {
  refreshWorkspace()
}

function anchorOf(btn) {
  const { x, y, width, height } = btn.getBoundingClientRect()
  return { x, y, width, height }
}

/**
 * @param {{ id: string, title: string, badge: string, color: string, icon: string }} row
 * @param {() => number | null} guestId
 * @param {ActionsApi} api
 */
function actionButton(row, guestId, api) {
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
    if (id != null) void api.extensionActivate(id, row.id, anchorOf(btn))
  })
  btn.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void api.extensionsMenu(guestId(), anchorOf(btn))
  })
  return btn
}
