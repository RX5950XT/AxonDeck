/**
 * 「這個專案跑過的 AI 對話」那個分頁的畫面。
 *
 * 從 `ws-tabs.js` 拆出來的：那支已經很大，而這裡的規則跟分頁機制無關。
 *
 * 三件跟以前不一樣的事：
 * 1. **讀過的檔案跟改過的檔案分開**（main 也分開回了）。混在一起的話，
 *    使用者以為 agent 動過三十個檔案，其實只是看過。
 * 2. **工具細節預設收起來**（`<details>`）：一輪對話動輒上百次工具呼叫，
 *    全部攤開之後看不到自己講過什麼。
 * 3. **可以直接接續**：開新終端機，或送進**已經開著**的那個終端機
 *    （常見情況是 agent 就在那裡等，只是被別的分頁蓋住）。
 */

/**
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLElement}
 */
import { refreshAiSessionFind, sessionTitleExcerpt } from './ws-ai-session-find.js'

function note(text, className = 'ws-ai-note') {
  const el = document.createElement('p')
  el.className = className
  el.textContent = text
  return el
}

/**
 * 一組可以收合的清單。
 * @param {string} title
 * @param {boolean} open
 * @returns {{ box: HTMLDetailsElement, body: HTMLElement }}
 */
function foldable(title, open) {
  const box = document.createElement('details')
  box.className = 'ws-ai-fold'
  box.open = open
  const head = document.createElement('summary')
  head.className = 'ws-ai-fold-head'
  head.textContent = title
  const body = document.createElement('div')
  body.className = 'ws-ai-fold-body'
  box.append(head, body)
  return { box, body }
}

/**
 * 一組檔案徽章。
 * @param {string[]} list
 * @param {(rel: string) => void} onOpen
 * @returns {HTMLElement}
 */
function fileChips(list, onOpen) {
  const host = document.createElement('div')
  host.className = 'ws-ai-files-list'
  for (const rel of list) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ws-ai-file-pill'
    btn.textContent = rel
    btn.title = `開啟 ${rel}`
    btn.addEventListener('click', () => onOpen(rel))
    host.appendChild(btn)
  }
  return host
}

/** 只合併連續工具片段，文字仍在原本的位置，原始資料不動。 */
export function groupSessionTurns(turns) {
  const groups = []
  for (const turn of turns) {
    if (turn.text) groups.push({ ...turn, tools: undefined })
    if (!Array.isArray(turn.tools) || !turn.tools.length) continue
    const tools = turn.tools.map(tool => ({ ...tool, continued: turn.continued }))
    const previous = groups.at(-1)
    if (previous?.tools) previous.tools.push(...tools)
    else groups.push({ tools })
  }
  return groups
}

function toolGroup(tools) {
  const names = [...new Set(tools.map(tool => tool.name))].join('、')
  const fold = foldable(`工具紀錄 ${tools.length} 段 · ${names}`, false)
  fold.box.classList.add('ws-ai-tool-group')
  for (const tool of tools) {
    const line = document.createElement('div')
    line.className = 'ws-ai-turn-tool'
    const name = document.createElement('span')
    name.className = 'ws-ai-tool-name'
    name.textContent = `${tool.name}${tool.continued ? ' · 接續' : ''}`
    const detail = document.createElement('div')
    detail.className = 'ws-ai-turn-tool-detail'
    detail.textContent = tool.detail || ''
    line.append(name, detail)
    fold.body.appendChild(line)
  }
  return fold.box
}

/**
 * 畫一個 AI 會話分頁。
 *
 * @param {object} opts
 * @param {any} opts.tab 分頁本身（帶 sessionData／sessionRow）
 * @param {{ bar: HTMLElement | null, title: HTMLElement | null, meta: HTMLElement | null, body: HTMLElement | null, resumeBtn: HTMLButtonElement | null, resumeIntoBtn: HTMLButtonElement | null, copyPathBtn: HTMLButtonElement | null }} opts.els
 * @param {(rel: string) => void} opts.onOpenFile
 * @param {() => Array<{ id: string, title: string }>} opts.terminals 這個專案現在開著哪些終端機
 * @param {(terminalId: string) => void} opts.onResume 接續（空字串＝開一個新的）
 * @param {(file: string) => void} opts.onCopyPath 複製記錄檔的完整路徑
 */
export function paintAiSession({ tab, els, onOpenFile, terminals, onResume, onCopyPath }) {
  const data = tab.sessionData
  const row = tab.sessionRow
  const findFocused = els.body?.querySelector('.ws-ai-find-input') === document.activeElement
  const view = `${tab.projectId || ''}:${data?.agent || ''}:${data?.sessionId || ''}`
  if (els.title) {
    const full = row?.title ? `${row.agentLabel || data?.agentLabel || 'AI'} · ${row.title}` : tab.title
    const excerpt = sessionTitleExcerpt(full)
    const open = els.title.dataset.sessionView === view && els.title.querySelector('details')?.open
    els.title.dataset.sessionView = view
    els.title.replaceChildren()
    if (excerpt.endsWith('…') && excerpt !== full) {
      const titleFold = foldable(excerpt, Boolean(open))
      titleFold.box.classList.add('ws-ai-title-fold')
      titleFold.box.querySelector('summary').title = '展開完整標題'
      titleFold.body.textContent = full
      els.title.appendChild(titleFold.box)
    } else els.title.textContent = excerpt
    els.title.title = full
  }
  if (els.meta) {
    const bits = []
    bits.push(`來源：${data?.source || '本機預設位置'}`)
    if (row?.mtime) bits.push(new Date(row.mtime).toLocaleString('zh-TW'))
    els.meta.textContent = bits.join(' · ')
    els.meta.title = els.meta.textContent
  }

  // 接續：兩顆鈕都掛在工具列上（第二顆只有真的有終端機開著時才出現）
  if (els.resumeBtn) {
    els.resumeBtn.onclick = () => onResume('')
    els.resumeBtn.hidden = false
  }
  if (els.resumeIntoBtn) {
    const list = terminals()
    els.resumeIntoBtn.hidden = list.length === 0
    els.resumeIntoBtn.onclick = (event) => {
      const rect = /** @type {HTMLElement} */ (event.currentTarget).getBoundingClientRect()
      import('./ws-menu.js').then((mod) => {
        mod.showMenu(
          { x: rect.left, y: rect.bottom + 4 },
          list.map((one) => ({
            label: one.title,
            onSelect: () => onResume(one.id)
          }))
        )
      })
    }
  }

  if (els.copyPathBtn) {
    const file = typeof data?.file === 'string' ? data.file : ''
    els.copyPathBtn.hidden = !file
    els.copyPathBtn.onclick = () => onCopyPath(file)
  }

  if (!els.body) return
  const folds = '.ws-ai-overview > .ws-ai-fold, .ws-ai-tool-group'
  const sameView = els.body.dataset.sessionView === view
  const expanded = sameView
    ? [...els.body.querySelectorAll(folds)].map(fold => fold.open) : []
  els.body.dataset.sessionView = view
  const overview = document.createElement('div')
  overview.className = 'ws-ai-card ws-ai-overview'
  if (els.bar) overview.appendChild(els.bar)
  els.body.replaceChildren()
  els.body.appendChild(overview)

  if (!data || data.error) {
    els.body.appendChild(note(data?.error ? `解析失敗：${data.error}` : '無法解析這份對話記錄', 'ws-ai-card'))
    refreshAiSessionFind(els.body, overview, view, findFocused)
    return
  }

  // ── 1. 同一塊置頂工具列、概況與統計 ──
  const overviewFold = foldable(`提問 ${data.prompts?.length || 0} 段 · 工具 ${data.toolCallsCount || 0} 次 · 概況與工具統計${data.hasMore ? ' · 載入完整對話中…' : ''}`, false)
  const summary = overviewFold.body
  overview.appendChild(overviewFold.box)
  if (tab.sessionReadError) overview.appendChild(note(tab.sessionReadError))
  if (els.meta) summary.appendChild(els.meta)

  const grid = document.createElement('div')
  grid.className = 'ws-ai-meta-grid'
  const addMeta = (label, value) => {
    const item = document.createElement('div')
    item.className = 'ws-ai-meta-item'
    const l = document.createElement('span')
    l.className = 'ws-ai-meta-label'
    l.textContent = label
    const v = document.createElement('span')
    v.className = 'ws-ai-meta-value'
    v.textContent = value
    item.append(l, v)
    grid.appendChild(item)
  }
  addMeta('會話識別碼', data.sessionId)
  summary.appendChild(grid)
  for (const limitation of data.limitations || []) summary.appendChild(note(limitation))

  // ── 2. 改過的／讀過的（分開，不可以混）──
  const edited = Array.isArray(data.editedFiles) ? data.editedFiles : []
  const read = Array.isArray(data.readFiles) ? data.readFiles : []
  if (edited.length) {
    const title = document.createElement('div')
    title.className = 'ws-ai-sub-title'
    title.textContent = `改過的檔案（${edited.length}）：`
    summary.append(title, fileChips(edited, onOpenFile))
  }
  if (read.length) {
    const fold = foldable(`只是讀過的檔案（${read.length}）`, false)
    fold.body.appendChild(fileChips(read, onOpenFile))
    summary.appendChild(fold.box)
  }
  if (!edited.length && !read.length) {
    summary.appendChild(note('沒有對到這個專案裡的檔案。'))
  }

  // ── 3. 工具呼叫統計（收起來）──
  const breakdown = data.toolCallsBreakdown || {}
  if (Object.keys(breakdown).length) {
    const title = document.createElement('div')
    title.className = 'ws-ai-sub-title'
    title.textContent = `工具呼叫統計（${Object.keys(breakdown).length} 種）`
    const tools = document.createElement('div')
    tools.className = 'ws-ai-tools-grid'
    for (const [name, count] of Object.entries(breakdown)) {
      const badge = document.createElement('span')
      badge.className = 'ws-ai-tool-badge'
      const label = document.createElement('span')
      label.className = 'ws-ai-tool-name'
      label.textContent = name
      const num = document.createElement('span')
      num.className = 'ws-ai-tool-count'
      num.textContent = String(count)
      badge.append(label, document.createTextNode(' '), num)
      tools.appendChild(badge)
    }
    tools.prepend(title)
    summary.appendChild(tools)
  }

  // ── 4. 對話全文，連續工具紀錄合併收合 ──
  const turns = Array.isArray(data.turns) ? data.turns : []
  if (turns.length) {
    const card = document.createElement('div')
    card.className = 'ws-ai-conversation'
    const title = document.createElement('h3')
    title.className = 'ws-ai-card-title'
    title.textContent = '對話內容'
    card.appendChild(title)
    const list = document.createElement('div')
    list.className = 'ws-ai-turns'
    for (const turn of groupSessionTurns(turns)) {
      if (turn.tools) {
        list.appendChild(toolGroup(turn.tools))
        continue
      }
      const item = document.createElement('div')
      item.className = turn.role === 'user' ? 'ws-ai-turn is-user' : 'ws-ai-turn'
      const who = document.createElement('span')
      who.className = 'ws-ai-turn-role'
      who.textContent = turn.role === 'user' ? '我' : `${row?.agentLabel || 'AI'}${turn.thought ? ' · 思考' : ''}${turn.continued ? ' · 接續' : ''}`
      const text = document.createElement('div')
      text.className = 'ws-ai-turn-text'
      text.textContent = turn.text || ''
      item.append(who, text)
      list.appendChild(item)
    }
    card.appendChild(list)
    els.body.appendChild(card)
  }
  // 同頁有新內容時，保留使用者正在看的展開區塊。
  els.body.querySelectorAll(folds).forEach((fold, index) => { fold.open = Boolean(expanded[index]) })
  refreshAiSessionFind(els.body, overview, view, sameView && findFocused)
  if (!sameView) els.body.scrollTop = 0
}

const PAGE_BUDGET = 40
let watchTimer = 0
let watchToken = 0

/** 小段 IPC 資料接成一份畫面資料；讀過／改過分開，統計涵蓋全部內容。 */
export function mergeSessionPages(pages) {
  const toolCallsBreakdown = {}
  for (const page of pages) {
    for (const [name, count] of Object.entries(page.toolCallsBreakdown || {})) {
      toolCallsBreakdown[name] = (toolCallsBreakdown[name] || 0) + count
    }
  }
  const turns = pages.flatMap(page => page.turns || [])
  const editedFiles = [...new Set(pages.flatMap(page => page.editedFiles || []))]
  const edited = new Set(editedFiles)
  const readFiles = [...new Set(pages.flatMap(page => page.readFiles || []))].filter(file => !edited.has(file))
  return { ...pages.at(-1), turns, editedFiles, readFiles, toolCallsBreakdown,
    prompts: turns.filter(turn => turn.role === 'user' && !turn.continued).map(turn => ({ text: turn.text })),
    toolCallsCount: Object.values(toolCallsBreakdown).reduce((sum, count) => sum + count, 0),
    stats: { totalTurns: turns.length, toolUsage: toolCallsBreakdown, editedFiles, readFiles }
  }
}

/** 更新從末段重讀並取代舊末段，再自動接下去；單批上限不限制全文長度。 */
export async function readSessionPages(pages, read, current, limit = PAGE_BUDGET) {
  const result = pages.slice(0, -1)
  let cursor = pages.at(-1)?.pageCursor || null
  for (let i = 0; i < limit; i++) {
    if (!current()) return null
    const data = await read(cursor)
    if (!current()) return null
    if (!data || data.error) throw new Error('讀取對話內容失敗')
    result.push(data)
    if (!data.hasMore) break
    if (!data.nextCursor || JSON.stringify(data.nextCursor) === JSON.stringify(cursor)) throw new Error('讀取對話游標未前進')
    cursor = data.nextCursor
  }
  return result
}

/** 只比末段與段數；較早的紀錄已讀取，不反覆複製完整長對話。 */
export function sessionContentKey(data, count = 1) {
  return `${count}\u0000${JSON.stringify(data)}`
}

export function stopAiSessionWatch() {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = 0
  watchToken += 1
}

async function reloadFollowedSession(tab, hooks, token) {
  const current = () => token === watchToken && hooks.current(tab)
  const pages = await readSessionPages(tab.sessionPages || [tab.sessionData], hooks.read, current)
  if (!pages || !current()) return
  const key = sessionContentKey(pages.at(-1), pages.length)
  if (key === tab.sessionKey && !tab.sessionReadError) return
  const body = hooks.body()
  const gap = body ? body.scrollHeight - body.scrollTop - body.clientHeight : 0
  const top = body ? body.scrollTop : 0
  const stick = Boolean(tab.sessionKey) && gap < 80
  tab.sessionPages = pages
  tab.sessionData = mergeSessionPages(pages)
  tab.sessionReadError = ''
  tab.sessionKey = key
  hooks.paint()
  const nextBody = hooks.body()
  if (!nextBody) return
  if (stick) nextBody.scrollTop = nextBody.scrollHeight
  else nextBody.scrollTop = top
}

/** 自動讀完全部段落；之後每 2 秒更新末段，不把閱讀中的使用者拉到最底。 */
export function startAiSessionWatch(tab, hooks) {
  stopAiSessionWatch()
  const token = watchToken
  let reading = false
  const run = () => {
    if (reading || token !== watchToken || (!tab.sessionData?.hasMore && hooks.hidden()) || !hooks.current(tab)) return
    reading = true
    void reloadFollowedSession(tab, hooks, token).catch(() => {
      if (token !== watchToken || !hooks.current(tab)) return
      tab.sessionReadError = '後續內容讀取失敗，稍後自動重試。'
      hooks.paint()
    }).finally(() => {
      reading = false
      if (tab.sessionData?.hasMore && !tab.sessionReadError && token === watchToken && hooks.current(tab)) setTimeout(run, 0)
    })
  }
  run()
  watchTimer = setInterval(run, 2000)
}
