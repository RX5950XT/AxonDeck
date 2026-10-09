const PREVIEW_CHARS = 1800
const cursorKey = cursor => `${cursor?.offset || 0}:${cursor?.part || 0}`
const clip = text => text.slice(0, PREVIEW_CHARS)
export const terminalHistoryText = text => String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\n/g, '\r\n')

/** 分頁／長訊息的接續沿用來源 cursor；相同提示詞仍保留各自的一輪。 */
export function appendConversation(previous, turns) {
  const pairs = previous.map(pair => ({ ...pair }))
  for (const turn of turns) {
    if (!turn.text || turn.thought || turn.tools?.length) continue
    const key = cursorKey(turn.cursor)
    const last = pairs.at(-1)
    if (turn.role === 'user') {
      if (turn.continued && last?.key === key) {
        last.promptTruncated ||= last.prompt.length + turn.text.length > PREVIEW_CHARS
        last.prompt = clip(last.prompt + turn.text)
      } else {
        pairs.push({ key, cursor: turn.cursor, prompt: clip(turn.text), answer: '',
          promptTruncated: turn.text.length > PREVIEW_CHARS, answerTruncated: false })
      }
    } else if (turn.role === 'assistant' && last) {
      const continued = turn.continued && last.answerKey === key
      const answer = (continued ? last.answer : '') + turn.text
      last.answer = clip(answer)
      last.answerTruncated = (continued && last.answerTruncated) || answer.length > PREVIEW_CHARS
      last.answerCursor = continued ? last.answerCursor : turn.cursor
      last.answerKey = key
    }
  }
  return pairs
}

/** 額度中斷後，最後一則下面還有輸出。任何一列都停在該則，不把滾軸送到底。 */
export function scrollsToBottom() {
  return false
}

/** 畫面上的同一句可能重繪多次。有對上就跳那一列；對不上的重複提問不猜，也不整段重播。 */
export function chooseConversationLine(lines, sameCount, index) {
  if (!lines?.length || index < 0) return -1
  if (lines.length === sameCount) return lines[index]
  if (sameCount === 1) return lines[0]
  return -1
}

const normalized = text => text.replace(/[`*_#│┃┆┇┊┋║╎╏╭╮╯╰┌┐└┘├┤┬┴┼─═╔╗╚╝╠╣╦╩╬]/g, '').replace(/\s+/g, '')
const needleOf = text => (String(text || '').split(/\r?\n/).map(normalized).find(Boolean) || '').slice(0, 80)

function lineMatches(content, needle, promptOnly) {
  if (promptOnly && !/^\s*[›❯>]\s*/.test(content)) return false
  const value = normalized(content).replace(/^[›❯>●•]+/, '')
  return needle.length < 12 ? value === needle : value.startsWith(needle)
}

/** 跳轉搜目前畫面，包含全螢幕 CLI 的 alternate buffer。 */
export function searchBuffer(term) {
  return term?.buffer?.active || null
}

/** 只掃到最新一份。同一句在很長的 scrollback 裡，從底往上才不會先把整份掃完。 */
export function findLastConversationLine(buffer, text, promptOnly = false) {
  const needle = needleOf(text)
  if (!needle || !buffer) return -1
  for (let start = buffer.length - 1; start >= 0; start--) {
    const first = buffer.getLine(start)
    if (!first || first.isWrapped) continue
    let content = ''
    for (let i = start; i < buffer.length && i < start + 8; i++) {
      const line = buffer.getLine(i)
      const prefix = normalized(content).replace(/^[›❯>●•]+/, '')
      const continued = prefix.length > 0 && prefix.length < needle.length && needle.startsWith(prefix)
      if (!line || (i > start && !line.isWrapped && !continued)) break
      content += line.translateToString(true)
      if (lineMatches(content, needle, promptOnly)) return start
    }
  }
  return -1
}

/** xterm 折行要先接起來；找不到就回 -1，不能用百分比猜訊息在哪裡。 */
export function findConversationLine(buffer, text, from = 0, promptOnly = false) {
  const needle = needleOf(text)
  if (!needle) return -1
  let content = '', start = from
  const valueOf = () => normalized(content).replace(/^[›❯>●•]+/, '')
  const matches = () => lineMatches(content, needle, promptOnly)
  for (let i = from; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    if (!line.isWrapped) {
      if (content && matches()) return start
      const prefix = valueOf()
      if (prefix && prefix.length < needle.length && needle.startsWith(prefix)) {
        content += line.translateToString(true); continue
      }
      start = i
      content = ''
    }
    content += line.translateToString(true)
  }
  return matches() ? start : -1
}

function element(tag, className, text = '') {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function button(className, text, action) {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

/** 對話清單只控制原 CLI 的捲動；不建立第二份終端機。 */
export function bindConversationNav({ pane, term, read, reload, requestJump }) {
  const root = element('nav', 'term-conversation')
  root.setAttribute('aria-label', '終端機對話導覽')
  const rail = element('div', 'term-conversation-rail')
  const toggle = button('term-conversation-toggle', '☰', () => setOpen(true))
  toggle.title = '跳轉對話紀錄'
  toggle.setAttribute('aria-label', toggle.title)
  toggle.setAttribute('aria-expanded', 'false')
  rail.append(toggle)
  const panel = element('section', 'term-conversation-panel')
  panel.hidden = true
  const status = element('p', 'term-conversation-status', '讀取對話紀錄中…')
  status.setAttribute('role', 'status')
  const list = element('div', 'term-conversation-list')
  panel.append(status, list)
  root.append(rail, panel)
  pane.append(root)
  let pairs = [], sessionId = '', disposed = false, pending = null, dirty = true, initializing = true, rerun = false
  let refreshTimer = 0
  const anchors = new Map(), restored = new Set()
  const write = text => new Promise(resolve => term.write(text, resolve))
  // CLI 的清畫面可以照常；清 scrollback 不能抹掉已補回的保存紀錄。
  const preserveHistory = term.parser.registerCsiHandler({ final: 'J' }, params => params[0] === 3 && [...restored].some(key => { const marker = anchors.get(key); return marker && !marker.isDisposed }))
  let restoreKey = '', jumpRequest = 0

  async function restoreTurn(turn) {
    if (disposed || !turn.text || turn.thought || turn.tools?.length) return
    if (turn.role === 'user') restoreKey = cursorKey(turn.cursor)
    if (!restoreKey || !['user', 'assistant'].includes(turn.role)) return
    const key = `${restoreKey}:${turn.role === 'user' ? 'prompt' : 'answer'}`
    if (!turn.continued || !restored.has(key)) {
      await write(`\r\n\r\n${turn.role === 'user' ? '你' : 'AI'}\r\n`)
      anchors.get(key)?.dispose()
      const marker = term.registerMarker(0)
      if (marker) { anchors.set(key, marker); restored.add(key) }
    }
    await write(terminalHistoryText(turn.text))
  }

  function setOpen(value) {
    panel.hidden = !value
    toggle.setAttribute('aria-expanded', String(value))
    if (value && !initializing) void refresh()
  }

  function paint() {
    const scroll = list.scrollTop
    list.replaceChildren()
    pairs.forEach((pair, index) => {
      const turn = element('div', 'term-conversation-turn')
      for (const [role, label, text] of [['prompt', '你', pair.prompt], ['answer', 'AI', pair.answer]]) {
        if (!text) continue
        const row = button('term-conversation-row', '', () => void jumpTo(pair, role))
        row.dataset.key = pair.key; row.dataset.role = role
        row.setAttribute('aria-label', `第 ${index + 1} 輪 ${label}：${text.slice(0, 160)}`)
        row.append(element('small', 'term-conversation-role', `${index + 1} · ${label}`), element('span', '', text.slice(0, 160)))
        turn.append(row)
      }
      list.append(turn)
    })
    list.scrollTop = scroll
  }

  function clearAnchors() {
    for (const marker of anchors.values()) marker.dispose()
    anchors.clear(); restored.clear()
  }

  function schedule(delay = 300) {
    dirty = true
    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      if (!disposed && (pane.classList.contains('is-active') || !panel.hidden)) void refresh()
    }, delay)
  }

  async function refresh(force = false, restore = false) {
    if (disposed) return pending
    if (pending) {
      if (dirty || force) rerun = true
      return pending
    }
    if (!dirty && !force) return pending
    dirty = false
    pending = (async () => {
      const tail = force ? null : pairs.at(-1)
      let next = tail?.cursor || null, updated = tail ? pairs.slice(0, -1) : []
      try {
        do {
          let result = await read(next)
          if (next && result?.ok && result.data.sessionId !== sessionId) { next = null; result = await read(null) }
          if (disposed) return
          if (!result?.ok) throw new Error(result?.error?.message || '對話紀錄讀取失敗')
          const page = result.data
          if (page.sessionId !== sessionId) {
            clearAnchors(); pairs = []; updated = []; paint()
          }
          sessionId = page.sessionId
          updated = appendConversation(updated, page.turns || [])
          if (restore) for (const turn of page.turns || []) await restoreTurn(turn)
          next = page.nextCursor
        } while (next && !disposed)
        if (!restore) for (const pair of updated) {
          const before = pairs.find(item => item.key === pair.key)
          for (const role of ['prompt', 'answer']) if (before && before[role] !== pair[role]) {
            const key = `${pair.key}:${role}`
            anchors.get(key)?.dispose(); anchors.delete(key); restored.delete(key)
          }
        }
        if (JSON.stringify(updated) !== JSON.stringify(pairs)) { pairs = updated; paint() }
        status.hidden = pairs.length > 0
        status.textContent = sessionId ? '這段對話還沒有提問。' : '尚未綁定對話紀錄；產生記錄後會自動顯示。'
      } catch (error) {
        status.hidden = false; status.textContent = error.message; dirty = true
      }
    })()
    try { await pending } finally {
      pending = null
      if (rerun && !disposed) {
        rerun = false
        dirty = true
        void refresh()
      }
    }
  }

  function locate(pair, role) {
    const buffer = searchBuffer(term)
    if (!buffer) return -1
    const key = `${pair.key}:${role}`, text = role === 'prompt' ? pair.prompt : pair.answer
    const known = anchors.get(key)
    if (known && !known.isDisposed) {
      if (findConversationLine(buffer, text, known.line) === known.line) return known.line
      known.dispose(); anchors.delete(key); restored.delete(key)
    }
    const same = pairs.filter(item => item[role] === text)
    const lines = []
    // 只出現一次時從底部停在最新一份。框線提問再整段往上找，會把跳轉拖成一次重播。
    if (same.length === 1) {
      const last = findLastConversationLine(buffer, text, false)
      if (last >= 0) lines.push(last)
    }
    const promptOnly = !lines.length && role === 'prompt' && findConversationLine(buffer, text, 0, true) >= 0
    for (let from = 0; !lines.length && from < buffer.length;) {
      const line = findConversationLine(buffer, text, from, promptOnly)
      if (line < 0) break
      lines.push(line); from = line + 1
    }
    const line = chooseConversationLine(lines, same.length, same.indexOf(pair))
    if (!(line >= 0)) return -1
    const marker = term.registerMarker(line - buffer.baseY - buffer.cursorY)
    if (marker) anchors.set(key, marker)
    return line
  }

  function markCurrent(pair, role) {
    for (const row of list.querySelectorAll('button')) {
      row.setAttribute('aria-current', String(row.dataset.key === pair.key && row.dataset.role === role))
    }
  }

  async function jumpTo(pair, role) {
    const request = ++jumpRequest, expectedSession = sessionId
    for (const row of list.querySelectorAll('button')) row.removeAttribute('aria-current')
    setOpen(false)
    let line = locate(pair, role)
    if (line < 0 && requestJump && term.buffer.active.type === 'alternate') {
      const text = role === 'prompt' ? pair.prompt : pair.answer
      const index = pairs.filter(item => item[role] === text).indexOf(pair)
      let jumped = false
      try { jumped = await requestJump(text, role, index) } catch { jumped = false }
      if (disposed || request !== jumpRequest || sessionId !== expectedSession) return
      if (jumped) { markCurrent(pair, role); term.focus(); return }
    }
    if (line < 0 && reload && term.buffer.active.type === 'normal') {
      status.hidden = false; status.textContent = '正在補回舊對話…'
      try { await reload() } catch { status.textContent = '無法補回這段對話。'; setOpen(true); return }
      if (disposed || request !== jumpRequest || sessionId !== expectedSession) return
      pair = pairs.find(item => item.key === pair.key) || pair
      line = locate(pair, role)
    }
    if (line >= 0) {
      term.scrollToLine(line)
      term.focus()
      markCurrent(pair, role)
    } else {
      setOpen(true)
      status.hidden = false
      status.textContent = '目前 CLI 的可捲動畫面找不到這則訊息。'
    }
  }

  rail.addEventListener('pointerenter', () => setOpen(true))
  toggle.addEventListener('focus', () => setOpen(true))
  for (const node of [rail, panel]) node.addEventListener('pointerleave', event => {
    if (!root.contains(event.relatedTarget)) setOpen(false)
  })
  root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) setOpen(false) })
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation(); setOpen(false); term.focus()
  })
  const timer = setInterval(() => {
    if (initializing) return
    if (!sessionId || !panel.hidden) schedule(0)
    else if (pane.classList.contains('is-active') && dirty) void refresh()
  }, 1000)
  return {
    refresh,
    restore: async () => {
      initializing = true
      await pending
      if (disposed) return
      clearAnchors(); restoreKey = ''
      await refresh(true, true)
      initializing = false
      if (restored.size && !disposed) await write('\r\n\r\n── 即時終端機 ──' + '\r\n'.repeat(term.rows + 1) + '\x1b[2J\x1b[H')
    },
    focus: () => term.focus(),
    changed: () => { if (!initializing) schedule(); else dirty = true },
    dispose: () => {
      disposed = true; clearInterval(timer); clearTimeout(refreshTimer); preserveHistory.dispose()
      clearAnchors(); root.remove(); pairs = []
    }
  }
}
