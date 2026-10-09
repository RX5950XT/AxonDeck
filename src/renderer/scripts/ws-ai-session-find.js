const readers = new WeakMap()

export function sessionTitleExcerpt(text) {
  const chars = [...text.replace(/\s+/gu, ' ').trim()]
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : chars.join('')
}

export function findTextMatches(text, query) {
  if (!query) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches = []
  for (const match of text.matchAll(pattern)) matches.push([match.index, match.index + match[0].length])
  return matches
}

function updateCurrent(state, scroll) {
  CSS.highlights.delete('ws-ai-find-current')
  state.count.textContent = state.input.value ? (state.total ? `${state.index + 1} / ${state.total}` : '找不到') : '輸入關鍵字'
  state.previous.disabled = state.next.disabled = !state.total
  if (!state.total || state.bar.hidden) return
  const entry = state.entries.find(one => state.index < one.base + one.matches.length)
  const [start, end] = entry.matches[state.index - entry.base]
  const range = document.createRange()
  range.setStart(entry.node.firstChild, start)
  range.setEnd(entry.node.firstChild, end)
  CSS.highlights.set('ws-ai-find-current', new Highlight(range))
  if (!scroll) return
  const fold = entry.node.closest('details')
  if (fold) fold.open = true
  const bodyRect = state.body.getBoundingClientRect()
  const top = state.overview.offsetHeight + 12
  state.body.scrollTop += range.getBoundingClientRect().top - bodyRect.top - top
}

function search(state, scroll = false) {
  clearTimeout(state.timer)
  state.timer = 0
  state.entries = []
  state.total = 0
  for (const node of state.body.querySelectorAll('.ws-ai-turn-text, .ws-ai-tool-name, .ws-ai-turn-tool-detail')) {
    if (node.closest('.ws-ai-overview')) continue
    const matches = findTextMatches(node.textContent, state.input.value)
    if (matches.length) state.entries.push({ node, matches, base: state.total })
    state.total += matches.length
  }
  state.index = Math.min(state.index, Math.max(0, state.total - 1))
  updateCurrent(state, scroll)
}

function close(state, focus = false) {
  clearTimeout(state.timer)
  state.timer = 0
  state.bar.hidden = true
  state.entries = []
  state.total = 0
  CSS.highlights.delete('ws-ai-find-current')
  if (focus) state.button.focus()
}

export function initAiSessionFind(root, body) {
  if (!root || !body || readers.has(body)) return
  const bar = document.createElement('div')
  bar.className = 'ws-ai-find'
  bar.hidden = true
  bar.setAttribute('role', 'search')
  const input = document.createElement('input')
  input.className = 'input ws-ai-find-input'
  input.type = 'search'
  input.placeholder = '搜尋對話與工具內容'
  input.setAttribute('aria-label', '搜尋目前對話紀錄')
  const count = document.createElement('span')
  count.className = 'ws-ai-find-count'
  count.setAttribute('role', 'status')
  const button = root.querySelector('#wsAiFindBtn')
  const state = { root, body, bar, input, count, button, entries: [], total: 0, index: 0, timer: 0, view: '' }
  const addButton = (label, title, action) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-secondary btn-sm'
    btn.textContent = label
    btn.title = title
    btn.setAttribute('aria-label', title)
    btn.onclick = action
    bar.appendChild(btn)
    return btn
  }
  const navigate = direction => {
    if (!state.total) return
    state.index = (state.index + direction + state.total) % state.total
    updateCurrent(state, true)
  }
  const open = () => {
    bar.hidden = false
    search(state)
    input.focus()
    input.select()
  }
  bar.append(input, count)
  state.previous = addButton('↑', '上一筆（Shift+Enter）', () => navigate(-1))
  state.next = addButton('↓', '下一筆（Enter）', () => navigate(1))
  addButton('關閉', '關閉搜尋（Esc）', () => close(state, true))
  button.onclick = open
  input.oninput = () => {
    clearTimeout(state.timer)
    state.index = 0
    state.timer = setTimeout(() => search(state, true), 120)
  }
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !root.getClientRects().length || event.target.closest('dialog[open]')) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      open()
    } else if (!bar.hidden && (event.key === 'F3' || (event.key === 'Enter' && event.target === input))) {
      event.preventDefault()
      if (state.timer) search(state)
      navigate(event.shiftKey ? -1 : 1)
    } else if (!bar.hidden && event.key === 'Escape') {
      event.preventDefault()
      close(state, true)
    }
  })
  readers.set(body, state)
}

export function refreshAiSessionFind(body, overview, view, focused = false) {
  const state = readers.get(body)
  if (!state) return
  if (state.view !== view) {
    close(state)
    state.input.value = ''
    state.index = 0
    state.view = view
  }
  state.overview = overview
  overview.appendChild(state.bar)
  if (!state.bar.hidden) search(state)
  if (focused && !state.bar.hidden) state.input.focus({ preventScroll: true })
}

export function closeAiSessionFind(body) {
  const state = readers.get(body)
  if (state) close(state)
}
