/**
 * 聊天側欄的選單。掛在 `document.body`：側欄有 `backdrop-filter`，會偷走 `position: fixed` 的定位基準。
 * 全程 createElement + textContent（選項裡有資料夾名稱與對話標題，都是使用者輸入）。
 *
 * 兩參數 `(anchor, items)` 維持貼在 anchor、再叫一次同一個 anchor 就收合。
 * 第三參數 `point` 貼在游標或鍵盤列的座標，並夾在視窗內。
 */

/** @typedef {{ label: string, onSelect: () => void, danger?: boolean, checked?: boolean, disabled?: boolean } | { separator: true }} MenuItem */

/** @type {{ el: HTMLElement, anchor: HTMLElement, cleanup: () => void } | null} */
let open = null

export function closeChatMenu() {
  if (!open) return
  const { el, anchor, cleanup } = open
  open = null
  cleanup()
  el.remove()
  anchor.setAttribute('aria-expanded', 'false')
}

/**
 * @param {HTMLElement} anchor 關閉（Escape）時把焦點還給它
 * @param {MenuItem[]} items
 * @param {{ x: number, y: number } | null} [point] 省略則貼在 anchor
 */
export function openChatMenu(anchor, items, point) {
  const toggleOff = open?.anchor === anchor && point == null
  closeChatMenu()
  if (toggleOff) return

  const el = document.createElement('div')
  el.className = 'chat-menu'
  el.setAttribute('role', 'menu')
  for (const item of items) el.appendChild(buildItem(item))
  document.body.appendChild(el)
  place(el, anchor, point)
  anchor.setAttribute('aria-expanded', 'true')

  const onPointer = (event) => {
    if (!el.contains(event.target) && !anchor.contains(event.target)) closeChatMenu()
  }
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeChatMenu()
      anchor.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(el, event.key === 'ArrowDown' ? 1 : -1)
    }
  }
  document.addEventListener('pointerdown', onPointer, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', closeChatMenu)
  window.addEventListener('resize', closeChatMenu)
  open = {
    el,
    anchor,
    cleanup: () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', closeChatMenu)
      window.removeEventListener('resize', closeChatMenu)
    }
  }
  el.querySelector('button:not(:disabled)')?.focus()
}

/**
 * @param {MenuItem} item
 * @returns {HTMLElement}
 */
function buildItem(item) {
  if ('separator' in item) {
    const sep = document.createElement('div')
    sep.className = 'chat-menu-sep'
    sep.setAttribute('role', 'separator')
    return sep
  }
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = item.danger ? 'chat-menu-item is-danger' : 'chat-menu-item'
  btn.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio')
  if (item.checked !== undefined) btn.setAttribute('aria-checked', String(item.checked))
  btn.disabled = item.disabled === true
  btn.textContent = item.label
  btn.addEventListener('click', () => {
    closeChatMenu()
    item.onSelect()
  })
  return btn
}

/**
 * 沒給座標就貼在 anchor 右下，超出視窗就往左／往上翻。
 * 有座標就以那個點為左上角，右邊或下邊不夠就整塊挪進視窗。
 * @param {HTMLElement} el
 * @param {HTMLElement} anchor
 * @param {{ x: number, y: number } | null | undefined} point
 */
function place(el, anchor, point) {
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    placeAtPoint(el, point.x, point.y)
    return
  }
  const rect = anchor.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))
  const below = rect.bottom + 4
  const top = below + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 4) : below
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}

/**
 * @param {HTMLElement} el
 * @param {number} x
 * @param {number} y
 */
function placeAtPoint(el, x, y) {
  const margin = 8
  const w = el.offsetWidth
  const h = el.offsetHeight
  let left = x
  let top = y
  if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w
  if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h
  el.style.left = `${Math.round(Math.max(margin, left))}px`
  el.style.top = `${Math.round(Math.max(margin, top))}px`
}

/**
 * @param {HTMLElement} el
 * @param {1 | -1} step
 */
function moveFocus(el, step) {
  const buttons = [...el.querySelectorAll('button:not(:disabled)')]
  if (!buttons.length) return
  const at = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement))
  buttons[(at + step + buttons.length) % buttons.length].focus()
}
