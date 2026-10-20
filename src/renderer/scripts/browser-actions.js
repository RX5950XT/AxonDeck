/**
 * 瀏覽器工具列的擴充功能圖示列（跟 Chrome 一樣：圖示＋右下角徽章）。
 * 圖示、標題、徽章由 main 依目前分頁算好（browser-extensions.js 的 `actions`）；
 * 左鍵開浮動 popup（或送 action.onClicked），右鍵叫整組「擴充功能」選單。
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
    const order = readOrder()
    const rank = (row) => (order.includes(row.id) ? order.indexOf(row.id) : order.length) // 沒排過的接在後面
    rows = [...rows].sort((a, b) => rank(a) - rank(b))
    host.replaceChildren(...rows.map((row) => actionButton(row, guestId, api)))
    host.hidden = !rows.length
  }

  enableReorder(host)

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

const ORDER_KEY = 'browserExtOrder'

/** @returns {string[]} */
function readOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** @param {string[]} ids */
function writeOrder(ids) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
  } catch {
    // 沒有 storage 就只是這次有效
  }
}

/**
 * 指標拖曳排序：拖的那顆跟著游標，其他圖示用 FLIP 動畫滑開讓位，放開後滑回格子。
 * 放開時依畫面順序存起來，所有瀏覽器共用同一個順序。
 * @param {HTMLElement} host
 */
function enableReorder(host) {
  host.addEventListener('pointerdown', (event) => {
    const el = /** @type {HTMLElement | null} */ (event.target)?.closest?.('[data-ext]')
    if (!el || event.button !== 0) return
    const startX = event.clientX
    const startOffset = el.offsetLeft
    let dragging = false

    const move = (e) => {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < 5) return
        dragging = true
        Object.assign(el.style, { position: 'relative', zIndex: '2', cursor: 'grabbing' })
        el.classList.add('dragging')
      }
      const visualLeft = startOffset + (e.clientX - startX)
      const center = visualLeft + el.offsetWidth / 2
      const others = [...host.children].filter((node) => node !== el)
      const index = others.filter((node) => node.offsetLeft + node.offsetWidth / 2 < center).length
      if ([...host.children].indexOf(el) !== index) {
        const before = new Map(others.map((node) => [node, node.getBoundingClientRect().left]))
        host.insertBefore(el, others[index] ?? null)
        for (const node of others) {
          const delta = before.get(node) - node.getBoundingClientRect().left
          if (delta) node.animate([{ transform: `translateX(${delta}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' })
        }
      }
      el.style.transform = `translateX(${visualLeft - el.offsetLeft}px)`
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (!dragging) return
      // 放開後的那一下 click 不要當成按圖示
      const swallow = (e) => e.stopImmediatePropagation()
      el.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => el.removeEventListener('click', swallow, true), 0)
      const from = el.style.transform || 'none'
      Object.assign(el.style, { transform: '', position: '', zIndex: '', cursor: '' })
      el.classList.remove('dragging')
      el.animate([{ transform: from }, { transform: 'none' }], { duration: 140, easing: 'ease-out' })
      writeOrder([...host.children].map((node) => /** @type {HTMLElement} */ (node).dataset.ext || ''))
    }

    // 放在 window 上聽：拖的時候 el 會被搬動位置，綁在 el 上會斷線
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })
  // 圖示 <img> 預設會啟動瀏覽器內建拖曳，把指標事件吃掉
  host.addEventListener('dragstart', (event) => event.preventDefault())
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
  btn.dataset.ext = row.id
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
