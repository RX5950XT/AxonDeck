import { electronAPI, showToast } from './app.js'
import { toolIcon } from './ws-tool-icons.js'
import { showMenu } from './ws-menu.js'

/**
 * 專案側欄每一列右邊的「AI 記錄」展開鈕：攤開就列出這個專案五家 AI
 * （Claude Code／Codex／Grok／OpenCode／Antigravity）有標題的對話，可以直接檢視、接續、複製。
 *
 * 清單由 main 掃（`workspace:agentSessions`，已拿掉沒標題的空白對話）；展開中的專案
 * 每隔幾秒重讀一次，**內容有變才就地換掉那一塊**（整份側欄重畫會洗掉拖曳與改名）。
 */

const STORE_KEY = 'wsProjectSessionsOpen'
const POLL_MS = 5000
/** 一次先列幾筆，其餘按「顯示全部」 */
const FIRST_ROWS = 8
/** 複製全文最多讀幾頁（每頁約 256K 字），避免超大對話把剪貼簿塞爆 */
const MAX_COPY_PAGES = 32

/**
 * @param {{
 *   call: (promise: Promise<any>, fallback: string) => Promise<any>,
 *   getList: () => HTMLElement | null,
 *   getProject: (id: string) => ({ id: string, name: string, path: string } | null),
 *   onOpen: (project: object, row: object) => void | Promise<void>,
 *   onResume: (project: object, row: object) => void | Promise<void>
 * }} deps
 */
export function createProjectSessions({ call, getList, getProject, onOpen, onResume }) {
  /** @type {Set<string>} */
  const open = new Set(readOpen())
  /** @type {Set<string>} 按過「顯示全部」的專案 */
  const showAll = new Set()
  /** @type {Map<string, { rows: object[], sig: string, error: boolean }>} */
  const cache = new Map()
  /** @type {Map<string, Promise<void>>} 同一個專案同時只讀一次 */
  const loading = new Map()
  let timer = 0

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...open])) } catch { /* 存不了只是下次不記得 */ }
  }

  /** 側欄看得到才輪詢（切到別頁、App 縮小都不讀磁碟） */
  function visible() {
    const list = getList()
    return Boolean(list && !document.hidden && list.offsetParent !== null)
  }

  async function load(projectId) {
    const pending = loading.get(projectId)
    if (pending) return pending
    const task = (async () => {
      let rows
      try {
        const result = await electronAPI.workspace.agentSessions(projectId)
        if (!result?.ok) throw new Error('load')
        rows = Array.isArray(result.data) ? result.data : []
      } catch {
        // 輪詢失敗不跳提示（每 5 秒一次會洗版）；保留上次的清單，沒有才標錯
        if (!cache.has(projectId)) cache.set(projectId, { rows: [], sig: 'error', error: true })
        paint(projectId)
        return
      }
      const sig = rows.map((row) => `${row.agent}:${row.id}:${row.mtime}:${row.sessionTitle || row.title}`).join('|')
      if (cache.get(projectId)?.sig === sig) return
      cache.set(projectId, { rows, sig, error: false })
      paint(projectId)
    })().finally(() => loading.delete(projectId))
    loading.set(projectId, task)
    return task
  }

  function tick() {
    if (!visible()) return
    for (const id of open) {
      if (getProject(id)) void load(id)
    }
  }

  function start() {
    window.clearInterval(timer)
    timer = window.setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
  }

  function toggle(projectId) {
    if (open.has(projectId)) open.delete(projectId)
    else open.add(projectId)
    persist()
    const row = findRow(projectId)
    if (row) syncRow(row, projectId)
    if (open.has(projectId)) void load(projectId)
  }

  function findRow(projectId) {
    return [...(getList()?.querySelectorAll('.proj-list-item') || [])]
      .find((node) => /** @type {HTMLElement} */ (node).dataset.id === projectId) || null
  }

  /** 只換掉那一個專案底下的清單，不動整份側欄 */
  function paint(projectId) {
    const row = findRow(projectId)
    const box = row?.querySelector('.proj-sessions')
    if (box && open.has(projectId)) fill(box, projectId)
  }

  function syncRow(row, projectId) {
    const on = open.has(projectId)
    row.classList.toggle('sessions-open', on)
    const btn = row.querySelector('.proj-sessions-toggle')
    btn?.setAttribute('aria-expanded', String(on))
    const box = row.querySelector('.proj-sessions')
    if (!box) return
    box.hidden = !on
    if (on) fill(box, projectId)
    else box.replaceChildren()
  }

  /**
   * 專案列畫好後由 `buildListItem` 叫：補上展開鈕與（展開中的話）清單。
   * @param {HTMLElement} row
   * @param {{ id: string, missing?: boolean }} item
   */
  function decorate(row, item) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chat-list-btn proj-sessions-toggle'
    btn.title = 'AI 對話記錄'
    btn.setAttribute('aria-label', 'AI 對話記錄')
    btn.append(chevron())
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      toggle(item.id)
    })
    const box = document.createElement('div')
    box.className = 'proj-sessions'
    box.hidden = true
    box.setAttribute('aria-label', 'AI 對話記錄')
    // 清單裡的按鍵與拖曳不要被專案列的排序吃掉
    box.addEventListener('pointerdown', (event) => event.stopPropagation())
    box.addEventListener('keydown', (event) => event.stopPropagation())
    box.addEventListener('contextmenu', (event) => event.stopPropagation())
    row.append(btn, box)
    syncRow(row, item.id)
    if (open.has(item.id) && !cache.has(item.id)) void load(item.id)
  }

  function fill(box, projectId) {
    const entry = cache.get(projectId)
    if (!entry) {
      box.replaceChildren(note('讀取中…'))
      return
    }
    if (entry.error && !entry.rows.length) {
      box.replaceChildren(note('讀不到 AI 記錄'))
      return
    }
    if (!entry.rows.length) {
      box.replaceChildren(note('最近 60 天沒有 AI 對話'))
      return
    }
    const all = showAll.has(projectId)
    const shown = all ? entry.rows : entry.rows.slice(0, FIRST_ROWS)
    const nodes = shown.map((row) => buildRow(projectId, row))
    if (entry.rows.length > FIRST_ROWS) {
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'proj-sess-more'
      more.textContent = all ? '收合' : `顯示全部 ${entry.rows.length} 筆`
      more.addEventListener('click', () => {
        if (all) showAll.delete(projectId)
        else showAll.add(projectId)
        fill(box, projectId)
      })
      nodes.push(more)
    }
    box.replaceChildren(...nodes)
  }

  function buildRow(projectId, row) {
    const title = row.sessionTitle || row.title
    const wrap = document.createElement('div')
    wrap.className = 'proj-sess'
    wrap.dataset.id = `${row.agent}:${row.id}`

    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'proj-sess-open'
    main.title = `${row.agentLabel} · ${title}${row.source ? `（${row.source}）` : ''}\n點一下檢視完整對話`
    const logo = toolIcon(row.agent)
    if (logo) main.append(logo)
    const text = document.createElement('span')
    text.className = 'proj-sess-title'
    text.textContent = title
    const when = document.createElement('span')
    when.className = 'proj-sess-when'
    when.textContent = formatWhen(row.mtime)
    main.append(text, when)
    main.addEventListener('click', () => withProject(projectId, (project) => onOpen(project, row)))

    const actions = document.createElement('span')
    actions.className = 'proj-sess-actions'
    actions.append(
      action('接續', '在新的終端機接續這段對話', () => withProject(projectId, (project) => onResume(project, row))),
      action('複製', '複製這段對話的文字內容', () => void copyText(projectId, row))
    )
    wrap.append(main, actions)
    wrap.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showMenu({ x: event.clientX, y: event.clientY }, [
        { label: '檢視對話', onSelect: () => withProject(projectId, (project) => onOpen(project, row)) },
        { label: '在新終端機接續', onSelect: () => withProject(projectId, (project) => onResume(project, row)) },
        { label: '複製對話內容', onSelect: () => void copyText(projectId, row) },
        { label: '複製紀錄檔路徑', onSelect: () => void copyPath(projectId, row) }
      ])
    })
    return wrap
  }

  function withProject(projectId, run) {
    const project = getProject(projectId)
    if (project) void run(project)
  }

  /** 一頁一頁跟 main 要（每次 IPC 只回一小段），接成「使用者／AI」交替的純文字 */
  async function copyText(projectId, row) {
    const parts = []
    let cursor = null
    let truncated = false
    try {
      for (let page = 0; ; page++) {
        if (page >= MAX_COPY_PAGES) { truncated = true; break }
        const data = await call(electronAPI.workspace.agentSessionDetail(projectId, row.agent, row.id, cursor), '讀不到對話內容')
        for (const turn of Array.isArray(data?.turns) ? data.turns : []) {
          if (typeof turn?.text !== 'string' || !turn.text) continue
          if (turn.continued && parts.length) parts[parts.length - 1] += turn.text
          else parts.push(`${turn.role === 'user' ? '【使用者】' : `【${row.agentLabel}】`}\n${turn.text}`)
        }
        if (!data?.hasMore || !data.nextCursor) break
        cursor = data.nextCursor
      }
    } catch {
      return
    }
    if (!parts.length) {
      showToast('這段對話沒有文字內容', 'error')
      return
    }
    try {
      await call(electronAPI.terminal.clipboardWrite(parts.join('\n\n')), '複製失敗')
      showToast(truncated ? '已複製（對話太長，只複製前段）' : '已複製對話內容')
    } catch { /* call 已顯示錯誤 */ }
  }

  async function copyPath(projectId, row) {
    try {
      const data = await call(electronAPI.workspace.agentSessionDetail(projectId, row.agent, row.id), '讀不到紀錄檔路徑')
      if (typeof data?.file !== 'string' || !data.file) {
        showToast('找不到紀錄檔路徑', 'error')
        return
      }
      await call(electronAPI.terminal.clipboardWrite(data.file), '複製不了路徑')
      showToast('已複製路徑')
    } catch { /* call 已顯示錯誤 */ }
  }

  return { decorate, start, refresh: tick }
}

function readOpen() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]')
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function note(text) {
  const p = document.createElement('p')
  p.className = 'proj-sess-note'
  p.textContent = text
  return p
}

function action(label, title, run) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'proj-sess-btn'
  btn.textContent = label
  btn.title = title
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    run()
  })
  return btn
}

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M6 9l6 6 6-6')
  svg.append(path)
  return svg
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatWhen(ms) {
  const diff = Date.now() - ms
  const hour = 60 * 60 * 1000
  if (diff < hour) return `${Math.max(1, Math.round(diff / 60000))} 分鐘前`
  if (diff < 24 * hour) return `${Math.round(diff / hour)} 小時前`
  const days = Math.round(diff / (24 * hour))
  return days <= 30 ? `${days} 天前` : new Date(ms).toLocaleDateString('zh-TW')
}
