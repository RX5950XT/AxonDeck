/**
 * 側欄的 Browser 模式：獨立的瀏覽器，分頁直排在側欄（比照 Edge 的垂直分頁）、網頁放主區。
 * partition 跟專案瀏覽器、聊天右側瀏覽器同一個（`persist:wsbrowser`），登入狀態與擴充功能共用；
 * 右鍵、F5、擴充功能由 main 依 partition 自動掛上。每個分頁一顆 webview，第一次切過去才建，關分頁就拆。
 *
 * 分頁可以拖曳排序、拖進／拖出群組；群組有顏色、可收合、可改名。分頁右鍵可「彈出獨立視窗」。
 * 側欄平常收成只剩圖示，滑鼠移上去才展開（📌 固定就一直展開，CSS 見 `.browser-pinned`）。
 * 分頁與群組存在 localStorage，下次打開還在（只建正在看的那一顆）。
 */

import { electronAPI, showToast, setChatPaneMode, getChatPaneMode } from './app.js'
import { createBrowserActions } from './browser-actions.js'
import { openChatMenu } from './chat-menu.js'
import { isInternalBrowserUrl } from '../../shared/browser-url.mjs'

const STORE_KEY = 'browserTabs'
const PIN_KEY = 'browserSidebarPinned'
const COLORS = ['#5b8def', '#e06c9f', '#f28b54', '#e5c34b', '#5fb878', '#4bb8c4', '#a77de8', '#8a94a6']

/** @typedef {{ id: number, url: string, title: string, icon: string, group: number }} Tab */
/** @typedef {{ id: number, name: string, color: string, collapsed: boolean }} Group */

/** @type {Tab[]} */
let tabs = []
/** @type {Group[]} */
let groups = []
let activeId = 0
let seq = 0
let bound = false
/** @type {{ kind: 'tab' | 'group', id: number } | null} */
let drag = null
/** 擴充功能圖示列（徽章跟著分頁走） */
let refreshActions = () => {}

/** @param {string} id */
const $ = (id) => document.getElementById(id)

/** 首頁與新分頁：Infinity New Tab Pro 的新分頁（擴充功能沒裝好時會開不起來） */
const NEWTAB_URL = 'chrome-extension://nnnkddnnlpamobajfibfdgfnbcnkgngh/newtab/index.html'
const isNewTab = (url) => url === NEWTAB_URL

/** 只收 http(s)（加上上面那個新分頁）；沒打協定就補 https:// */
function safeUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (isInternalBrowserUrl(text)) return new URL(text).href
  try {
    const u = new URL(/^[a-z][\w+.-]*:/i.test(text) ? text : `https://${text}`)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

/** 網址列輸入：像網址就開網址，否則丟給 Google AI Mode 搜尋 */
function urlOrSearch(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const looksLikeUrl = isInternalBrowserUrl(text) || /^https?:\/\//i.test(text) || (!/\s/.test(text) && /^(localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(text))
  return looksLikeUrl ? safeUrl(text) : `https://www.google.com/search?udm=50&aep=11&q=${encodeURIComponent(text)}`
}

function hostOf(url) {
  try {
    return new URL(url).host || '新分頁'
  } catch {
    return '新分頁'
  }
}

const tabOf = (id) => tabs.find((tab) => tab.id === id)
const groupOf = (id) => groups.find((group) => group.id === id)

// ===== 狀態（一律換新陣列，不改舊物件） =====

/** @param {number} id @param {Partial<Tab>} patch */
function patchTab(id, patch) {
  tabs = tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab))
}

/** @param {number} id @param {Partial<Group>} patch */
function patchGroup(id, patch) {
  groups = groups.map((group) => (group.id === id ? { ...group, ...patch } : group))
}

/** 同一群組的分頁排在一起（接在那個群組第一次出現的位置）；空群組收掉 */
function normalize() {
  const out = []
  const done = new Set()
  for (const tab of tabs) {
    if (!tab.group || !groupOf(tab.group)) out.push(tab.group ? { ...tab, group: 0 } : tab)
    else if (!done.has(tab.group)) {
      done.add(tab.group)
      out.push(...tabs.filter((item) => item.group === tab.group))
    }
  }
  tabs = out
  groups = groups.filter((group) => done.has(group.id))
}

/**
 * 把 ids 這幾個分頁搬到 anchorId 前／後（anchorId 為 0 就搬到最後）
 * @param {number[]} ids @param {number} anchorId @param {boolean} before @param {number} [group] 給了就順便換群組
 */
function moveTabs(ids, anchorId, before, group) {
  const moving = tabs.filter((tab) => ids.includes(tab.id)).map((tab) => (group === undefined ? tab : { ...tab, group }))
  const rest = tabs.filter((tab) => !ids.includes(tab.id))
  const at = rest.findIndex((tab) => tab.id === anchorId)
  const index = at < 0 ? rest.length : at + (before ? 0 : 1)
  tabs = [...rest.slice(0, index), ...moving, ...rest.slice(index)]
}

/** @param {number} groupId */
const blockOf = (groupId) => tabs.filter((tab) => tab.group === groupId).map((tab) => tab.id)

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      tabs: tabs.map(({ url, title, icon, group }) => ({ url, title, icon, group })),
      groups
    }))
  } catch {
    // 沒有 storage 就只是這次有效
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    // 舊版存的是單純的分頁陣列
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.tabs) ? raw.tabs : []
    const savedGroups = Array.isArray(raw?.groups) ? raw.groups : []
    groups = savedGroups
      .filter((group) => Number.isInteger(group?.id) && group.id > 0)
      .map((group) => ({
        id: group.id,
        name: String(group.name || '群組').slice(0, 60),
        color: COLORS.includes(group.color) ? group.color : COLORS[0],
        collapsed: group.collapsed === true
      }))
    seq = Math.max(0, ...groups.map((group) => group.id))
    tabs = list
      .map((row) => ({
        id: ++seq,
        url: safeUrl(row?.url),
        title: String(row?.title || '').slice(0, 200),
        icon: /^(https?:|data:image\/)/.test(String(row?.icon || '')) ? String(row.icon) : '',
        group: Number.isInteger(row?.group) ? row.group : 0
      }))
      .filter((tab) => tab.url)
    normalize()
  } catch {
    tabs = []
    groups = []
  }
}

// ===== webview =====

/** @param {number} id */
function guestOf(id) {
  return /** @type {any} */ ($('browserFrame')?.querySelector(`webview[data-tab="${id}"]`) || null)
}

function activeGuestId() {
  try {
    return guestOf(activeId)?.getWebContentsId() ?? null
  } catch {
    return null // 還沒 attach
  }
}

function paintChrome() {
  const guest = guestOf(activeId)
  let back = false
  let forward = false
  try {
    back = Boolean(guest?.canGoBack())
    forward = Boolean(guest?.canGoForward())
  } catch {
    // 還沒 attach：都當不能按
  }
  const backBtn = /** @type {HTMLButtonElement | null} */ ($('browserBackBtn'))
  const fwdBtn = /** @type {HTMLButtonElement | null} */ ($('browserFwdBtn'))
  if (backBtn) backBtn.disabled = !back
  if (fwdBtn) fwdBtn.disabled = !forward
  refreshActions()
}

/** @param {Tab} tab */
function ensureGuest(tab) {
  const existing = guestOf(tab.id)
  if (existing || !tab.url) return existing
  const guest = /** @type {any} */ (document.createElement('webview'))
  // partition 要在插入前設好，建了就不能改
  guest.setAttribute('partition', 'persist:wsbrowser')
  guest.setAttribute('allowpopups', '')
  guest.setAttribute('src', tab.url)
  guest.dataset.tab = String(tab.id)
  const id = tab.id
  const onNavigate = (event) => {
    const url = String(event.url || '')
    if (!tabOf(id) || !(/^https?:/i.test(url) || isInternalBrowserUrl(url))) return
    patchTab(id, { url })
    if (id === activeId) {
      const input = /** @type {HTMLInputElement | null} */ ($('browserUrl'))
      if (input && document.activeElement !== input) input.value = isNewTab(url) ? '' : url
      paintChrome()
    }
    save()
    renderList()
  }
  guest.addEventListener('did-navigate', onNavigate)
  guest.addEventListener('did-navigate-in-page', onNavigate)
  guest.addEventListener('page-title-updated', (event) => {
    if (!tabOf(id)) return
    patchTab(id, { title: String(event.title || '').slice(0, 200) })
    save()
    renderList()
  })
  guest.addEventListener('page-favicon-updated', (event) => {
    const icon = (event.favicons || []).find((url) => /^(https?:|data:image\/)/.test(url)) || ''
    if (!tabOf(id) || tabOf(id)?.icon === icon) return
    patchTab(id, { icon })
    save()
    renderList()
  })
  guest.addEventListener('did-stop-loading', () => {
    if (id === activeId) paintChrome()
  })
  $('browserFrame')?.appendChild(guest)
  return guest
}

// ===== 側欄清單 =====

/** @param {Tab} tab */
function tabIcon(tab) {
  const fallback = () => {
    const letter = document.createElement('span')
    letter.className = 'bt-icon bt-letter'
    letter.textContent = (tab.title || hostOf(tab.url)).slice(0, 1).toUpperCase()
    return letter
  }
  if (!tab.icon) return fallback()
  const img = document.createElement('img')
  img.className = 'bt-icon'
  img.alt = ''
  img.src = tab.icon
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true })
  return img
}

/** @param {string} label @param {string} text @param {() => void} onClick */
function miniButton(label, text, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'bt-btn'
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.textContent = text
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return btn
}

/** @param {Tab} tab */
function buildTabRow(tab) {
  const row = document.createElement('div')
  const group = groupOf(tab.group)
  row.className = `bt-tab${tab.id === activeId ? ' active' : ''}${group ? ' in-group' : ''}`
  row.setAttribute('role', 'listitem')
  row.tabIndex = 0
  row.title = `${tab.title || hostOf(tab.url)}\n${tab.url}`
  row.draggable = true
  row.dataset.tab = String(tab.id)
  if (group) row.style.setProperty('--bt-group', group.color)
  const label = document.createElement('span')
  label.className = 'bt-label'
  label.textContent = tab.title || hostOf(tab.url)
  row.append(tabIcon(tab), label, miniButton('關閉分頁', '✕', () => closeTab(tab.id)))
  row.addEventListener('click', () => activate(tab.id))
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') activate(tab.id)
  })
  // 中鍵關分頁（跟一般瀏覽器一樣）
  row.addEventListener('auxclick', (event) => {
    if (event.button === 1) closeTab(tab.id)
  })
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openChatMenu(row, tabMenu(tab.id), { x: event.clientX, y: event.clientY })
  })
  bindDrag(row, { kind: 'tab', id: tab.id })
  return row
}

/** @param {Group} group */
function buildGroupRow(group) {
  const row = document.createElement('div')
  row.className = `bt-group${group.collapsed ? ' collapsed' : ''}`
  row.setAttribute('role', 'listitem')
  row.tabIndex = 0
  row.draggable = true
  row.dataset.group = String(group.id)
  row.style.setProperty('--bt-group', group.color)
  row.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true')
  const chip = document.createElement('span')
  chip.className = 'bt-chip'
  const caret = document.createElement('span')
  caret.className = 'bt-caret'
  caret.textContent = '▶'
  const name = document.createElement('span')
  name.className = 'bt-label'
  name.textContent = group.name
  chip.append(caret, name)
  row.append(
    chip,
    miniButton('在群組新增分頁', '＋', () => newTab('', group.id)),
    miniButton('重新命名群組', '✎', () => renameGroup(group.id, name))
  )
  const toggle = () => {
    patchGroup(group.id, { collapsed: !group.collapsed })
    save()
    renderList()
  }
  row.addEventListener('click', toggle)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') toggle()
  })
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openChatMenu(row, groupMenu(group.id, name), { x: event.clientX, y: event.clientY })
  })
  bindDrag(row, { kind: 'group', id: group.id })
  return row
}

function renderList() {
  const list = $('browserTabList')
  if (!list) return
  const rows = []
  const shown = new Set()
  for (const tab of tabs) {
    const group = groupOf(tab.group)
    if (group && !shown.has(group.id)) {
      shown.add(group.id)
      rows.push(buildGroupRow(group))
    }
    if (!group?.collapsed) rows.push(buildTabRow(tab))
  }
  list.replaceChildren(...rows)
}

// ===== 拖曳：分頁排序、拖進／拖出群組、整組搬 =====

function clearDropMarks() {
  for (const el of document.querySelectorAll('.bt-drop-before, .bt-drop-after, .bt-drop-into')) {
    el.classList.remove('bt-drop-before', 'bt-drop-after', 'bt-drop-into')
  }
}

/** @param {HTMLElement} el @param {DragEvent} event 游標在上半部＝放在前面 */
function isBefore(el, event) {
  const rect = el.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2
}

/**
 * @param {HTMLElement} row
 * @param {{ kind: 'tab' | 'group', id: number }} item
 */
function bindDrag(row, item) {
  row.addEventListener('dragstart', (event) => {
    drag = item
    event.dataTransfer?.setData('text/plain', '')
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    row.classList.add('is-dragging')
  })
  row.addEventListener('dragend', () => {
    drag = null
    row.classList.remove('is-dragging')
    clearDropMarks()
  })
  row.addEventListener('dragover', (event) => {
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    clearDropMarks()
    const before = isBefore(row, event)
    // 分頁拖到群組標題下半部＝放進群組
    row.classList.add(item.kind === 'group' && drag.kind === 'tab' && !before ? 'bt-drop-into' : before ? 'bt-drop-before' : 'bt-drop-after')
  })
  row.addEventListener('drop', (event) => {
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    dropOn(item, isBefore(row, event))
  })
}

/**
 * @param {{ kind: 'tab' | 'group', id: number }} target
 * @param {boolean} before
 */
function dropOn(target, before) {
  const source = drag
  drag = null
  clearDropMarks()
  if (!source || (source.kind === target.kind && source.id === target.id)) return
  if (source.kind === 'tab') {
    if (target.kind === 'tab') moveTabs([source.id], target.id, before, tabOf(target.id)?.group || 0)
    else if (before) moveTabs([source.id], blockOf(target.id)[0], true, 0)
    else if (tabOf(source.id)?.group !== target.id) moveTabs([source.id], blockOf(target.id)[0], true, target.id)
  } else {
    const ids = blockOf(source.id)
    const targetGroup = target.kind === 'group' ? target.id : tabOf(target.id)?.group || 0
    if (targetGroup === source.id) return
    // 落在別的群組裡：整組放在那一組的前或後，不拆開人家
    const block = targetGroup ? blockOf(targetGroup) : [target.id]
    moveTabs(ids, before ? block[0] : block[block.length - 1], before)
  }
  normalize()
  save()
  renderList()
}

/** 拖到清單空白處：放到最後、離開群組 */
function bindListDrop(list) {
  list.addEventListener('dragover', (event) => {
    if (!drag) return
    event.preventDefault()
    clearDropMarks()
  })
  list.addEventListener('drop', (event) => {
    if (!drag) return
    event.preventDefault()
    const source = drag
    drag = null
    if (source.kind === 'tab') moveTabs([source.id], 0, false, 0)
    else moveTabs(blockOf(source.id), 0, false)
    normalize()
    save()
    renderList()
  })
}

// ===== 右鍵選單 =====

/** @param {number} id */
function tabMenu(id) {
  const tab = tabOf(id)
  if (!tab) return []
  const others = groups.filter((group) => group.id !== tab.group)
  return [
    { label: '彈出獨立視窗', onSelect: () => void popout(id) },
    { label: '重新整理', onSelect: () => reloadTab(id) },
    { label: '複製網址', onSelect: () => void navigator.clipboard.writeText(tab.url).catch(() => showToast('複製失敗', 'error')) },
    { label: '複製分頁', onSelect: () => newTab(tab.url, tab.group, id) },
    { separator: true },
    tab.group
      ? { label: '從群組移除', onSelect: () => ungroupTabs([id]) }
      : { label: '加入新群組', onSelect: () => createGroup([id]) },
    ...others.map((group) => ({ label: `移到「${group.name}」`, onSelect: () => moveToGroup(id, group.id) })),
    { separator: true },
    { label: '關閉其他分頁', disabled: tabs.length < 2, onSelect: () => closeOthers(id) },
    { label: '關閉分頁', danger: true, onSelect: () => closeTab(id) }
  ]
}

/** @param {number} id @param {HTMLElement} nameEl */
function groupMenu(id, nameEl) {
  const group = groupOf(id)
  if (!group) return []
  return [
    { label: '在群組新增分頁', onSelect: () => newTab('', id) },
    { label: '重新命名', onSelect: () => renameGroup(id, nameEl) },
    {
      label: '換顏色',
      onSelect: () => {
        patchGroup(id, { color: COLORS[(COLORS.indexOf(group.color) + 1) % COLORS.length] })
        save()
        renderList()
      }
    },
    { separator: true },
    { label: '取消群組', onSelect: () => ungroupTabs(blockOf(id)) },
    { label: '關閉群組', danger: true, onSelect: () => blockOf(id).forEach(closeTab) }
  ]
}

/** @param {number[]} ids */
function createGroup(ids) {
  const id = ++seq
  const used = new Set(groups.map((group) => group.color))
  groups = [...groups, {
    id,
    name: `群組 ${groups.length + 1}`,
    color: COLORS.find((color) => !used.has(color)) || COLORS[groups.length % COLORS.length],
    collapsed: false
  }]
  tabs = tabs.map((tab) => (ids.includes(tab.id) ? { ...tab, group: id } : tab))
  normalize()
  save()
  renderList()
}

/** @param {number[]} ids */
function ungroupTabs(ids) {
  // 放到原群組剩下的分頁後面，不打亂其他分頁
  const remaining = blockOf(tabOf(ids[0])?.group || 0).filter((id) => !ids.includes(id))
  if (remaining.length) moveTabs(ids, remaining[remaining.length - 1], false, 0)
  else tabs = tabs.map((tab) => (ids.includes(tab.id) ? { ...tab, group: 0 } : tab))
  normalize()
  save()
  renderList()
}

/** @param {number} id @param {number} groupId */
function moveToGroup(id, groupId) {
  const block = blockOf(groupId)
  moveTabs([id], block[block.length - 1], false, groupId)
  normalize()
  save()
  renderList()
}

/** @param {number} id @param {HTMLElement} nameEl */
function renameGroup(id, nameEl) {
  const group = groupOf(id)
  if (!group) return
  const input = document.createElement('input')
  input.className = 'bt-rename'
  input.value = group.name
  input.maxLength = 60
  input.setAttribute('aria-label', '群組名稱')
  let done = false
  const finish = (keep) => {
    if (done) return
    done = true
    const next = input.value.trim()
    if (keep && next) patchGroup(id, { name: next })
    save()
    renderList()
  }
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') finish(true)
    else if (event.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  // 輸入框裡的點擊、拖曳不要變成收合或拖群組
  for (const type of ['click', 'pointerdown', 'dragstart']) input.addEventListener(type, (event) => event.stopPropagation())
  nameEl.replaceWith(input)
  input.focus()
  input.select()
}

/**
 * 彈出獨立視窗：交給 main 開新視窗，這裡的分頁收掉（等同把分頁拖出去）。
 * 帶上這顆 webview 的 id，main 會把上一頁的歷史、捲動位置、填到一半的表單、影音進度一起搬過去。
 * @param {number} id
 */
async function popout(id) {
  const tab = tabOf(id)
  if (!tab?.url) return
  let guestId = null
  try {
    guestId = guestOf(id)?.getWebContentsId() ?? null
  } catch {
    guestId = null // 還沒 attach：只帶網址
  }
  try {
    // 記下原本的位置與群組；視窗最小化或關閉時 main 會叫我們收回（dock）
    const saved = { index: tabs.findIndex((item) => item.id === id), group: groupOf(tab.group) }
    if (await electronAPI.workspace.browserPopout(tab.url, tab.title, guestId, id)) {
      slots.set(id, saved)
      closeTab(id)
    }
  } catch {
    showToast('開不了獨立視窗', 'error')
  }
}

/** 彈出去的分頁原本的位置：分頁代號 → { index, group } */
const slots = new Map()

/** 獨立視窗被最小化或關閉：網頁放回原本的位置與群組 @param {{ slot: number, url: string, title: string }} info */
function dock({ slot, url, title }) {
  const saved = slots.get(slot)
  slots.delete(slot)
  const href = safeUrl(url)
  if (!href) return
  // 彈出時那個群組只剩這一頁就被收掉了，連群組一起放回來
  if (saved?.group && !groupOf(saved.group.id)) groups = [...groups, saved.group]
  const tab = { id: ++seq, url: href, title: String(title || '').slice(0, 200), icon: '', group: saved?.group ? saved.group.id : 0 }
  const at = Math.min(saved?.index ?? tabs.length, tabs.length)
  tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)]
  normalize()
  save()
  activate(tab.id)
}

/** @param {number} id */
function reloadTab(id) {
  try {
    guestOf(id)?.reload()
  } catch {
    // 還沒 attach
  }
}

// ===== 分頁操作 =====

/** @param {number} id */
function activate(id) {
  activeId = id
  const tab = tabOf(id)
  if (tab?.group && groupOf(tab.group)?.collapsed) patchGroup(tab.group, { collapsed: false })
  const guest = tab ? ensureGuest(tab) : null
  for (const node of $('browserFrame')?.querySelectorAll('webview') || []) {
    /** @type {HTMLElement} */ (node).hidden = node !== guest
  }
  const input = /** @type {HTMLInputElement | null} */ ($('browserUrl'))
  if (input) {
    input.value = isNewTab(tab?.url) ? '' : tab?.url || ''
    if (!input.value) input.focus() // 新分頁：游標直接落在網址列
  }
  setChatPaneMode('browser')
  paintChrome()
  renderList()
  $('browserTabList')?.querySelector('.bt-tab.active')?.scrollIntoView({ block: 'nearest' })
}

/** @param {number} id */
function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  guestOf(id)?.remove()
  tabs = tabs.filter((tab) => tab.id !== id)
  normalize()
  save()
  if (activeId !== id) return renderList()
  const next = tabs[Math.min(index, tabs.length - 1)]
  if (next) return activate(next.id)
  activeId = 0
  setChatPaneMode('chat') // 分頁都關了：主區回對話
  renderList()
}

/** @param {number} keep */
function closeOthers(keep) {
  for (const tab of tabs.filter((item) => item.id !== keep)) guestOf(tab.id)?.remove()
  tabs = tabs.filter((tab) => tab.id === keep).map((tab) => ({ ...tab, group: 0 }))
  normalize()
  save()
  activate(keep)
}

/**
 * @param {string} [url]
 * @param {number} [group] 放進哪個群組（放在那組最後）
 * @param {number} [after] 放在哪個分頁後面
 */
function newTab(url = '', group = 0, after = 0) {
  const tab = { id: ++seq, url: safeUrl(url) || NEWTAB_URL, title: '', icon: '', group: groupOf(group) ? group : 0 }
  const block = blockOf(tab.group)
  const anchor = after || (tab.group ? block[block.length - 1] : 0)
  tabs = [...tabs, tab]
  if (anchor) moveTabs([tab.id], anchor, false)
  normalize()
  save()
  activate(tab.id)
}

function go() {
  const input = /** @type {HTMLInputElement | null} */ ($('browserUrl'))
  const href = urlOrSearch(input?.value)
  if (!href) {
    showToast('只支援 http 與 https 的網址', 'error')
    return
  }
  const tab = tabOf(activeId)
  if (!tab) return newTab(href)
  patchTab(tab.id, { url: href, title: hostOf(href), icon: '' })
  const guest = guestOf(tab.id)
  if (guest) guest.src = href
  activate(tab.id)
  save()
}

/** @param {'back' | 'forward' | 'reload'} action */
function act(action) {
  const guest = guestOf(activeId)
  try {
    if (action === 'back' && guest?.canGoBack()) guest.goBack()
    else if (action === 'forward' && guest?.canGoForward()) guest.goForward()
    else if (action === 'reload') guest?.reload()
  } catch {
    // 還沒 attach：這次當沒按到
  }
}

// ===== 側欄收合：滑鼠移上去展開、離開收起；📌 固定就一直展開 =====

function applyPinned(pinned) {
  document.querySelector('#page-chat .chat-layout')?.classList.toggle('browser-pinned', pinned)
  const pin = $('browserPinBtn')
  pin?.setAttribute('aria-pressed', pinned ? 'true' : 'false')
  pin?.classList.toggle('active', pinned)
  if (pin) pin.title = pinned ? '取消固定（滑鼠離開就收起）' : '固定側欄（不自動收起）'
}

function readPinned() {
  try {
    return localStorage.getItem(PIN_KEY) === '1'
  } catch {
    return false
  }
}

function togglePinned() {
  const next = !readPinned()
  // 固定了就不用蓋子（展開狀態交給 CSS 的 .browser-pinned）
  if (next) $('browserFrame')?.classList.remove('bt-cover')
  try {
    localStorage.setItem(PIN_KEY, next ? '1' : '0')
  } catch {
    // 沒有 storage 就只是這次有效
  }
  applyPinned(next)
}

/**
 * 沒固定時的展開／收起。用 class 不用 CSS 的 :hover：祖先帶 :has() 時，
 * Chromium 不會因為 hover 重算子孫的樣式（實測展開了字卻還藏著）。
 * 右鍵選單開著、正在改群組名稱時不收，免得選單對不到位置。
 */
function bindHoverExpand() {
  const sidebar = document.querySelector('#page-chat .chat-sidebar')
  const frame = $('browserFrame')
  if (!sidebar) return
  let timer = 0
  // 游標直接滑進網頁時，宿主收不到 mouseleave（輸入全進了 webview）。
  // 展開時在網頁上蓋一層透明的（.bt-cover），游標一離開側欄就落在宿主自己的元素上
  const setOpen = (open) => {
    sidebar.classList.toggle('bt-open', open)
    frame?.classList.toggle('bt-cover', open)
  }
  const collapsible = () => {
    const layout = sidebar.parentElement?.classList
    return Boolean(layout?.contains('is-browser') && layout.contains('sidebar-browser') && !layout.contains('browser-pinned'))
  }
  sidebar.addEventListener('mouseenter', () => {
    clearTimeout(timer)
    if (collapsible()) timer = window.setTimeout(() => setOpen(true), 60)
  })
  const resizer = $('chatSidebarResizer')
  const closeSoon = () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (document.querySelector('.chat-menu') || sidebar.querySelector('.bt-rename')) return
      // 拖寬度時游標會跑出側欄，拖完再收
      if (document.body.classList.contains('is-col-resizing')) return closeSoon()
      setOpen(false)
    }, 250)
  }
  sidebar.addEventListener('mouseleave', closeSoon)
  // 用鍵盤（Tab）走進收起的側欄也要展開，不然焦點落在看不到的東西上
  sidebar.addEventListener('focusin', () => {
    clearTimeout(timer)
    if (collapsible()) setOpen(true)
  })
  sidebar.addEventListener('focusout', (event) => {
    const next = /** @type {Node | null} */ (event.relatedTarget)
    if (next && sidebar.contains(next)) return
    if (!sidebar.matches(':hover')) closeSoon()
  })
  resizer?.addEventListener('mouseenter', () => clearTimeout(timer))
  resizer?.addEventListener('mouseleave', closeSoon)
  // 點在蓋子上＝想操作網頁：直接收起
  frame?.addEventListener('pointerdown', (event) => {
    if (event.target !== frame || !frame.classList.contains('bt-cover')) return
    clearTimeout(timer)
    setOpen(false)
  })
}

function bind() {
  if (bound) return
  bound = true
  load()
  applyPinned(readPinned())
  bindHoverExpand()
  refreshActions = createBrowserActions($('browserActions'), activeGuestId)
  const list = $('browserTabList')
  if (list) bindListDrop(list)
  electronAPI.workspace.onBrowserDock(dock)
  $('browserPinBtn')?.addEventListener('click', togglePinned)
  $('browserNewTabBtn')?.addEventListener('click', () => newTab())
  $('browserBackBtn')?.addEventListener('click', () => act('back'))
  $('browserFwdBtn')?.addEventListener('click', () => act('forward'))
  $('browserReloadBtn')?.addEventListener('click', () => act('reload'))
  $('browserExtBtn')?.addEventListener('click', (event) => {
    const { x, y, width, height } = /** @type {HTMLElement} */ (event.currentTarget).getBoundingClientRect()
    void electronAPI.workspace.extensionsMenu(activeGuestId(), { x, y, width, height })
  })
  $('browserExternalBtn')?.addEventListener('click', () => {
    const href = tabOf(activeId)?.url || ''
    if (href && !isNewTab(href)) void electronAPI.workspace.openExternal(href)
    else showToast('這個分頁還沒有網址', 'error')
  })
  $('browserUrl')?.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return // 輸入法選字的 Enter 不算
    if (event.key === 'Enter') {
      event.preventDefault()
      go()
    }
  })
  // Ctrl+T 新分頁、Ctrl+W 關分頁（焦點在網頁裡時按鍵進不到這裡）
  document.addEventListener('keydown', (event) => {
    if (getChatPaneMode() !== 'browser' || !event.ctrlKey || event.shiftKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 't') {
      event.preventDefault()
      newTab()
    } else if (key === 'w' && activeId) {
      event.preventDefault()
      closeTab(activeId)
    }
  })
  renderList()
}

/** 側欄切到 Browser：列出分頁（不建 webview） */
export function initBrowserPage() {
  bind()
}

/** 按下 Browser 那顆鈕：顯示目前分頁，沒有就開一個空白的 */
export function showBrowserPage() {
  bind()
  if (tabOf(activeId)) activate(activeId)
  else if (tabs.length) activate(tabs[tabs.length - 1].id)
  else newTab()
}

/** 外連開在 Browser 模式的新分頁 @param {string} url */
export function openInBrowserPage(url) {
  bind()
  const href = safeUrl(url)
  if (href) newTab(href)
}
