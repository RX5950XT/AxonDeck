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

/**
 * 畫一個 AI 會話分頁。
 *
 * @param {object} opts
 * @param {any} opts.tab 分頁本身（帶 sessionData／sessionRow）
 * @param {{ title: HTMLElement | null, meta: HTMLElement | null, body: HTMLElement | null, resumeBtn: HTMLButtonElement | null, resumeIntoBtn: HTMLButtonElement | null, copyPathBtn: HTMLButtonElement | null }} opts.els
 * @param {(rel: string) => void} opts.onOpenFile
 * @param {() => Array<{ id: string, title: string }>} opts.terminals 這個專案現在開著哪些終端機
 * @param {(terminalId: string) => void} opts.onResume 接續（空字串＝開一個新的）
 * @param {(file: string) => void} opts.onCopyPath 複製記錄檔的完整路徑
 */
export function paintAiSession({ tab, els, onOpenFile, terminals, onResume, onCopyPath, onLoadPage }) {
  const data = tab.sessionData
  const row = tab.sessionRow
  if (els.title) {
    els.title.textContent = tab.title
    els.title.title = tab.title
  }
  if (els.meta) {
    const bits = []
    if (data?.source) bits.push(`來源：${data.source}`)
    if (row?.mtime) bits.push(new Date(row.mtime).toLocaleString('zh-TW'))
    bits.push(`第 ${(tab.sessionPage || 0) + 1} 頁`)
    if (data?.hasMore) bits.push('還有後續內容')
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
  els.body.replaceChildren()

  if (!data || data.error) {
    els.body.appendChild(note(data?.error ? `解析失敗：${data.error}` : '無法解析這份對話記錄', 'ws-ai-card'))
    return
  }

  // ── 1. 概況 ──
  const summary = document.createElement('div')
  summary.className = 'ws-ai-card'
  const summaryTitle = document.createElement('h3')
  summaryTitle.className = 'ws-ai-card-title'
  summaryTitle.textContent = '本頁概況'
  summary.appendChild(summaryTitle)

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
  addMeta('代理類型', row?.agentLabel || data.agent)
  addMeta('會話識別碼', data.sessionId)
  addMeta('本頁提問片段', `${data.prompts?.length || 0} 段`)
  addMeta('本頁工具呼叫', `${data.toolCallsCount || 0} 次`)
  addMeta('記錄來源', data.source || '本機預設位置')
  summary.appendChild(grid)
  for (const limitation of data.limitations || []) summary.appendChild(note(limitation))

  // ── 2. 改過的／讀過的（分開，不可以混）──
  const edited = Array.isArray(data.editedFiles) ? data.editedFiles : []
  const read = Array.isArray(data.readFiles) ? data.readFiles : []
  if (edited.length) {
    const title = document.createElement('div')
    title.className = 'ws-ai-sub-title'
    title.textContent = `本頁改過的檔案（${edited.length}）：`
    summary.append(title, fileChips(edited, onOpenFile))
  }
  if (read.length) {
    const fold = foldable(`本頁只是讀過的檔案（${read.length}）`, false)
    fold.body.appendChild(fileChips(read, onOpenFile))
    summary.appendChild(fold.box)
  }
  if (!edited.length && !read.length) {
    summary.appendChild(note('這頁沒有對到這個專案裡的檔案。'))
  }
  els.body.appendChild(summary)

  // ── 3. 工具呼叫統計（收起來）──
  const breakdown = data.toolCallsBreakdown || {}
  if (Object.keys(breakdown).length) {
    const card = document.createElement('div')
    card.className = 'ws-ai-card'
    const fold = foldable(`本頁工具呼叫統計（${Object.keys(breakdown).length} 種）`, false)
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
    fold.body.appendChild(tools)
    card.appendChild(fold.box)
    els.body.appendChild(card)
  }

  // ── 4. 對話內容（工具細節各自收起來）──
  const turns = Array.isArray(data.turns) ? data.turns : []
  if (turns.length) {
    const card = document.createElement('div')
    card.className = 'ws-ai-card'
    const title = document.createElement('h3')
    title.className = 'ws-ai-card-title'
    title.textContent = '對話內容'
    card.appendChild(title)
    const list = document.createElement('div')
    list.className = 'ws-ai-turns'
    for (const turn of turns) {
      const item = document.createElement('div')
      item.className = turn.role === 'user' ? 'ws-ai-turn is-user' : 'ws-ai-turn'
      const who = document.createElement('span')
      who.className = 'ws-ai-turn-role'
      who.textContent = turn.role === 'user' ? '我' : `${row?.agentLabel || 'AI'}${turn.thought ? ' · 思考' : ''}${turn.continued ? ' · 接續' : ''}`
      const text = document.createElement('div')
      text.className = 'ws-ai-turn-text'
      text.textContent = turn.text || ''
      item.append(who, text)
      if (Array.isArray(turn.tools) && turn.tools.length) {
        const fold = foldable(`工具 ${turn.tools.length} 次`, false)
        for (const tool of turn.tools) {
          const line = document.createElement('div')
          line.className = 'ws-ai-turn-tool'
          const name = document.createElement('span')
          name.className = 'ws-ai-tool-name'
          name.textContent = tool.name
          const detail = document.createElement('span')
          detail.className = 'ws-ai-turn-tool-detail'
          detail.textContent = tool.detail || ''
          line.append(name, detail)
          fold.body.appendChild(line)
        }
        item.appendChild(fold.box)
      }
      list.appendChild(item)
    }
    card.appendChild(list)
    els.body.appendChild(card)
  }
  const navigation = document.createElement('div')
  navigation.className = 'ws-ai-card'
  const pageNote = note(`第 ${(tab.sessionPage || 0) + 1} 頁${data.hasMore ? '，還有後續內容。' : '，已讀到記錄末尾。'}`)
  navigation.appendChild(pageNote)
  for (const [direction, label, action, available] of [
    [-1, '上一頁', 'previous-page', (tab.sessionPage || 0) > 0],
    [1, '下一頁（繼續讀取）', 'next-page', Boolean(data.nextCursor)]
  ]) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-secondary btn-sm'
    button.dataset.action = action
    button.textContent = label
    button.disabled = !available || Boolean(tab.sessionLoading)
    button.onclick = () => onLoadPage?.(direction)
    navigation.appendChild(button)
  }
  els.body.prepend(navigation)
}

const PAGE_BUDGET = 40
let watchTimer = 0
let watchToken = 0
let readGeneration = 0

/** 剛打開跟著最新頁；使用者翻回舊頁時 sessionFollow 為 false。 */
export function sessionReadPlan(tab) {
  const cursors = Array.isArray(tab?.sessionPageCursors) ? tab.sessionPageCursors : [null]
  const page = tab?.sessionPage || 0
  return { follow: tab?.sessionFollow !== false, page, cursor: cursors[page] ?? null, cursors }
}

/** 跟著最新內容時才往後翻；一輪最多走到 limit 頁，下一輪從這一頁繼續。 */
export function advanceSessionRead(plan, data, limit) {
  const page = plan.page || 0
  const cursors = plan.cursors || [null]
  if (plan.follow && data?.hasMore && data.nextCursor && page + 1 < limit) {
    const next = cursors.slice()
    next[page + 1] = data.nextCursor
    return { follow: true, page: page + 1, cursor: data.nextCursor, cursors: next, walk: true }
  }
  return { follow: Boolean(plan.follow), page, cursor: plan.cursor ?? null, cursors, walk: false }
}

/** 頁碼、有沒有後續、每一句的角色與文字。沒變就不要整頁重畫。 */
export function sessionContentKey(data, page) {
  const turns = Array.isArray(data?.turns) ? data.turns : []
  const body = turns.map((turn) => `${turn?.role || ''}\u0000${turn?.continued ? 1 : 0}\u0000${turn?.text || ''}`).join('\u0001')
  return `${page}\u0000${data?.sessionId || ''}\u0000${data?.hasMore ? 1 : 0}\u0000${body}`
}

export function invalidateAiSessionRead() {
  readGeneration += 1
  return readGeneration
}

export function stopAiSessionWatch() {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = 0
  watchToken += 1
}

async function readFollowedPage(tab, hooks, token, generation) {
  let plan = sessionReadPlan(tab)
  const ceiling = plan.page + PAGE_BUDGET
  let data = null
  for (;;) {
    if (token !== watchToken || generation !== readGeneration || !hooks.current(tab)) return null
    data = await hooks.read(plan.cursor)
    if (!data || token !== watchToken || generation !== readGeneration || !hooks.current(tab)) return null
    const next = advanceSessionRead(plan, data, ceiling)
    if (!next.walk) return { plan, data }
    plan = next
  }
}

async function reloadFollowedSession(tab, hooks, token) {
  const generation = readGeneration
  const before = tab.sessionPage || 0
  const found = await readFollowedPage(tab, hooks, token, generation)
  if (!found || token !== watchToken || generation !== readGeneration || !hooks.current(tab)) return
  const key = sessionContentKey(found.data, found.plan.page)
  if (key === tab.sessionKey) return
  const body = hooks.body()
  const gap = body ? body.scrollHeight - body.scrollTop - body.clientHeight : 0
  const top = body ? body.scrollTop : 0
  const stick = !tab.sessionKey || found.plan.page !== before || gap < 80
  tab.sessionData = found.data
  tab.sessionPage = found.plan.page
  tab.sessionPageCursors = found.plan.cursors
  tab.sessionFollow = found.plan.follow
  tab.sessionKey = key
  hooks.paint()
  const nextBody = hooks.body()
  if (!nextBody) return
  if (found.plan.follow && stick) nextBody.scrollTop = nextBody.scrollHeight
  else nextBody.scrollTop = top
}

/** 這個分頁還開著時，約每 2 秒重讀目前這一段的尾頁。手動翻頁不會被蓋掉。 */
export function startAiSessionWatch(tab, hooks) {
  stopAiSessionWatch()
  const token = watchToken
  let reading = false
  const run = () => {
    if (reading || token !== watchToken || hooks.hidden() || !hooks.current(tab)) return
    reading = true
    void reloadFollowedSession(tab, hooks, token).catch(() => {}).finally(() => { reading = false })
  }
  run()
  watchTimer = setInterval(run, 2000)
}
