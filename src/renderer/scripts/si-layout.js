/**
 * SI 頁的版面：標題列那兩顆收合左右側欄的鈕，以及額度條／四顆入口的擺放位置。
 *
 * - 專案模式（workspace）：額度條搬進 `#termMain` 最下面，只跟終端機那一塊一樣寬；
 *   供應商／用量統計／Port／資源（`#quotaDock`）搬到右側欄底部。
 * - 其他模式、右側欄收起或視窗太窄（≤900px 時 CSS 會藏右側欄）：四顆入口回到額度條右邊，
 *   額度條回到 `.chat-stage` 最下面（四顆放在條右邊、同步鈕左側）。
 * 只搬節點不複製：按鈕的監聽與 id 都在 quota-bar.js，搬到哪裡都照樣動。
 */

const LEFT_KEY = 'siLeftCollapsed'
const RIGHT_KEY = 'siRightCollapsed'
const NARROW = window.matchMedia('(max-width: 900px)')

let mode = ''
let leftCollapsed = readFlag(LEFT_KEY)
let rightCollapsed = readFlag(RIGHT_KEY)
let initialized = false

function readFlag(key) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key, on) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // 沒有 storage 就只是這次有效
  }
}

/** 只在父層不同時才搬，避免每次切模式都重插一次 */
function moveTo(node, parent, before = null) {
  if (!node || !parent) return
  if (node.parentElement === parent && (before === null || node.nextElementSibling === before)) return
  parent.insertBefore(node, before)
}

function placeQuota() {
  const bar = document.getElementById('quotaBar')
  const dock = document.getElementById('quotaDock')
  const termMain = document.getElementById('termMain')
  const stage = document.querySelector('#page-chat .chat-stage')
  const rightDock = document.getElementById('wsRightDock')
  if (!bar || !dock) return
  const workspace = mode === 'workspace'
  moveTo(bar, workspace ? termMain : stage)
  const inRight = workspace && !rightCollapsed && !NARROW.matches
  if (inRight) moveTo(dock, rightDock)
  else moveTo(dock, bar, bar.querySelector('.quota-bar-side'))
  bar.classList.toggle('has-dock', !inRight)
  document.dispatchEvent(new CustomEvent('quota:layout'))
}

function syncButtons() {
  const left = document.getElementById('siToggleLeft')
  const right = document.getElementById('siToggleRight')
  if (left) {
    const label = leftCollapsed ? '展開左側欄' : '收起左側欄'
    left.title = label
    left.setAttribute('aria-label', label)
    left.setAttribute('aria-pressed', String(!leftCollapsed))
  }
  if (right) {
    const usable = mode === 'workspace'
    const label = !usable ? '右側欄只在專案模式出現' : rightCollapsed ? '展開右側欄' : '收起右側欄'
    right.title = label
    right.setAttribute('aria-label', label)
    right.setAttribute('aria-pressed', String(!rightCollapsed))
    right.disabled = !usable
  }
}

function apply() {
  const layout = document.querySelector('#page-chat .chat-layout')
  layout?.classList.toggle('si-left-collapsed', leftCollapsed)
  layout?.classList.toggle('si-right-collapsed', rightCollapsed)
  syncButtons()
  placeQuota()
}

function init() {
  if (initialized) return
  initialized = true
  document.getElementById('siToggleLeft')?.addEventListener('click', () => {
    leftCollapsed = !leftCollapsed
    writeFlag(LEFT_KEY, leftCollapsed)
    apply()
  })
  document.getElementById('siToggleRight')?.addEventListener('click', () => {
    rightCollapsed = !rightCollapsed
    writeFlag(RIGHT_KEY, rightCollapsed)
    apply()
  })
  NARROW.addEventListener('change', placeQuota)
}

/** setChatPaneMode 每次切主區都呼叫 */
export function syncSiLayout(nextMode) {
  init()
  mode = nextMode
  apply()
}

/** 標題列那兩顆只在 SI 頁顯示 */
export function setSiHeaderVisible(on) {
  const group = document.getElementById('siPaneToggles')
  if (group) group.hidden = !on
}
