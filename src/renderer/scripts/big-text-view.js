/**
 * 超大文字檔（超過 Monaco 上限）的唯讀檢視：只畫看得到的那幾十列，資料一段一段跟 main 要。
 *
 * 垂直捲動不用原生的：瀏覽器元素高度上限約 3,300 萬 px，幾千萬列早就超過。
 * 右邊那條捲軸只是「位置比例」，真正的位置是 `top`（第幾列在最上面）；滾輪、鍵盤都直接改 `top`。
 * 水平捲動照原生（一列最多 4096 位元組，寬度有限）。
 *
 * 文字一律 `textContent`／Text 節點，不碰 innerHTML（檔案內容是外部輸入）。
 *
 * 檔案在外面被改（例如還在寫的 log）：每 POLL_MS 問一次修改時間，變了就重建索引、重畫；
 * 原本停在檔尾就跟著停在新的檔尾。
 */

const ROW_PX = 20
const BLOCK = 200
const MAX_BLOCKS = 60
/** 假捲軸的高度上限（低於瀏覽器的元素高度上限） */
const MAX_SPACER_PX = 8_000_000
const POLL_MS = 2000

/**
 * @typedef {{ t: string, n: number }} Row  n＝行號，長行切出來的接續列為 0
 * @typedef {{ rows: number, lines: number, size: number, mtimeMs: number }} BigMeta
 * @typedef {BigMeta & {
 *   read: (start: number, count: number) => Promise<Row[]>,
 *   line: (line: number) => Promise<number>,
 *   find: (query: string, afterRow: number, matchCase: boolean) => Promise<number | null>,
 *   mtime: () => Promise<number>,
 *   reopen: () => Promise<BigMeta>
 * }} BigSource  mtime＝磁碟上現在的修改時間（0＝檔案不在了）；reopen＝重建索引
 */

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const formatSize = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`

/** 只把 A–Z 折成小寫（長度不變），跟 main 搜尋（`big-text.js` 的 foldAscii）同一套規則 */
const foldAscii = (text) => text.replace(/[A-Z]+/g, (m) => m.toLowerCase())

/**
 * @param {HTMLElement} host
 * @param {BigSource} source
 * @param {{ onError?: (message: string) => void }} [options]
 * @returns {{ destroy: () => void, focus: () => void }}
 */
export function mountBigText(host, source, options = {}) {
  const report = options.onError || (() => {})
  const root = el('div', 'bt')
  const bar = el('div', 'bt-bar')
  const lineInput = /** @type {HTMLInputElement} */ (el('input', 'input bt-input'))
  lineInput.type = 'number'
  lineInput.min = '1'
  lineInput.placeholder = '跳到第幾行'
  lineInput.setAttribute('aria-label', '跳到第幾行')
  const findInput = /** @type {HTMLInputElement} */ (el('input', 'input bt-input bt-find'))
  findInput.placeholder = '尋找（Enter 找下一個）'
  findInput.setAttribute('aria-label', '尋找')
  const caseBtn = el('button', 'btn btn-secondary btn-sm bt-case', 'Aa')
  caseBtn.type = 'button'
  caseBtn.title = '區分大小寫'
  caseBtn.setAttribute('aria-label', '區分大小寫')
  caseBtn.setAttribute('aria-pressed', 'false')
  const findBtn = el('button', 'btn btn-secondary btn-sm', '下一個')
  findBtn.type = 'button'
  const info = el('span', 'bt-info')
  const status = el('span', 'bt-status')
  status.setAttribute('role', 'status')
  bar.append(lineInput, findInput, caseBtn, findBtn, status, info)

  const view = el('div', 'bt-view')
  const body = el('div', 'bt-body')
  body.tabIndex = 0
  const layer = el('div', 'bt-rows')
  body.append(layer)
  const vbar = el('div', 'bt-vbar')
  const spacer = el('div', 'bt-spacer')
  vbar.append(spacer)
  view.append(body, vbar)
  root.append(bar, view)
  host.replaceChildren(root)

  /** @type {Map<number, Row[] | Promise<void>>} 第幾塊 → 那 BLOCK 列 */
  const blocks = new Map()
  let top = 0
  let visible = 1
  let current = -1
  let query = ''
  let matchCase = false
  /** 重建索引後舊的讀取結果作廢 */
  let generation = 0
  let syncing = false
  let destroyed = false
  /** @type {HTMLElement[]} */
  const pool = []

  const maxTop = () => Math.max(0, source.rows - visible + 1)
  const spacerPx = () => Math.min(MAX_SPACER_PX, source.rows * ROW_PX)

  function load(block) {
    if (blocks.has(block)) return
    const gen = generation
    const pending = source.read(block * BLOCK, BLOCK).then((rows) => {
      if (destroyed || gen !== generation) return
      blocks.set(block, rows)
      // 最舊的先丟（Map 照插入順序）
      while (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value)
      paint()
    }, (error) => {
      if (gen !== generation) return
      blocks.delete(block)
      report(error?.message || '讀不到這一段')
    })
    blocks.set(block, pending)
  }

  /** @returns {Row | null} */
  function rowAt(index) {
    const rows = blocks.get(Math.floor(index / BLOCK))
    if (!Array.isArray(rows)) return null
    return rows[index % BLOCK] || null
  }

  function fill(node, row, index) {
    const [ln, tx] = /** @type {HTMLElement[]} */ ([...node.children])
    node.classList.toggle('is-current', index === current)
    ln.textContent = row?.n ? String(row.n) : ''
    const text = row ? row.t : ''
    const hay = matchCase ? text : foldAscii(text)
    const needle = matchCase ? query : foldAscii(query)
    let at = query ? hay.indexOf(needle) : -1
    if (at < 0) {
      tx.textContent = text
      return
    }
    // 把找到的字包成 <mark>（保留原本的大小寫），其餘照文字放
    const frag = document.createDocumentFragment()
    let from = 0
    for (; at >= 0; at = hay.indexOf(needle, from)) {
      if (at > from) frag.append(document.createTextNode(text.slice(from, at)))
      from = at + needle.length
      frag.append(el('mark', 'bt-hit', text.slice(at, from)))
    }
    if (from < text.length) frag.append(document.createTextNode(text.slice(from)))
    tx.replaceChildren(frag)
  }

  function paint() {
    if (destroyed) return
    while (pool.length < visible) {
      const node = el('div', 'bt-row')
      node.append(el('span', 'bt-ln'), el('span', 'bt-tx'))
      pool.push(node)
      layer.append(node)
    }
    for (let i = 0; i < pool.length; i += 1) {
      const index = top + i
      const node = pool[i]
      node.hidden = i >= visible || index >= source.rows
      if (node.hidden) continue
      const row = rowAt(index)
      if (!row) load(Math.floor(index / BLOCK))
      fill(node, row, index)
    }
    syncBar()
  }

  function syncBar() {
    const range = spacerPx() - vbar.clientHeight
    if (range <= 0) return
    const target = maxTop() ? (top / maxTop()) * range : 0
    // 值一樣不會觸發 scroll，旗標就會卡住吃掉使用者下一次拖動
    if (Math.abs(vbar.scrollTop - target) < 1) return
    syncing = true
    vbar.scrollTop = target
  }

  function scrollTo(next) {
    const clamped = Math.max(0, Math.min(maxTop(), Math.round(next)))
    if (clamped === top) return
    top = clamped
    paint()
  }

  function measure() {
    visible = Math.max(1, Math.ceil(body.clientHeight / ROW_PX))
    spacer.style.height = `${spacerPx()}px`
    paint()
  }

  function paintInfo() {
    // 行號欄寬跟著最大行號的位數走
    root.style.setProperty('--bt-ln', `${String(source.lines).length}ch`)
    info.textContent = `唯讀檢視 · ${source.lines.toLocaleString()} 行 · ${formatSize(source.size)}`
  }

  /** 換上新索引：快取全丟，位置留著；原本在檔尾就跟到新的檔尾 */
  function refresh(meta) {
    const atEnd = top >= maxTop()
    source = { ...source, ...meta }
    generation += 1
    blocks.clear()
    if (current >= source.rows) current = -1
    paintInfo()
    if (atEnd) top = maxTop()
    else top = Math.min(top, maxTop())
    measure()
  }

  let checking = false
  async function checkDisk() {
    if (checking || destroyed || document.hidden) return
    checking = true
    try {
      const mtimeMs = await source.mtime()
      if (destroyed || !mtimeMs || mtimeMs === source.mtimeMs) return
      const meta = await source.reopen()
      if (!destroyed) refresh(meta)
    } catch (error) {
      report(error?.message || '重新讀取失敗')
    } finally {
      checking = false
    }
  }

  vbar.addEventListener('scroll', () => {
    // 自己設的 scrollTop 也會觸發一次 scroll，那次不算
    if (syncing) { syncing = false; return }
    const range = spacerPx() - vbar.clientHeight
    if (range > 0) scrollTo((vbar.scrollTop / range) * maxTop())
  })
  body.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
    event.preventDefault()
    const rows = event.deltaMode === 1 ? event.deltaY * 1 : event.deltaMode === 2 ? event.deltaY * visible : event.deltaY / ROW_PX
    scrollTo(top + (Math.abs(rows) < 1 ? Math.sign(rows) : rows))
  }, { passive: false })
  body.addEventListener('keydown', (event) => {
    const page = Math.max(1, visible - 1)
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }
    if (event.key in moves) scrollTo(top + moves[event.key])
    else if (event.key === 'Home' && event.ctrlKey) scrollTo(0)
    else if (event.key === 'End' && event.ctrlKey) scrollTo(maxTop())
    else return
    event.preventDefault()
  })

  /** 把某一列放到畫面上方三分之一並標起來 */
  function reveal(row) {
    current = row
    top = Math.max(0, Math.min(maxTop(), row - Math.floor(visible / 3)))
    paint()
  }

  lineInput.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return
    const line = Number(lineInput.value)
    if (!Number.isFinite(line) || line < 1) return
    try {
      reveal(await source.line(Math.min(line, source.lines)))
      status.textContent = ''
    } catch (error) {
      report(error?.message || '跳不過去')
    }
  })

  let finding = false
  async function findNext() {
    const q = findInput.value
    if (!q || finding) return
    finding = true
    status.textContent = '尋找中…'
    try {
      const after = q === query && current >= 0 ? current : top - 1
      const row = await source.find(q, after, matchCase)
      if (destroyed) return
      query = q
      if (row === null) {
        status.textContent = '找不到'
        paint()
      } else {
        status.textContent = ''
        reveal(row)
      }
    } catch (error) {
      status.textContent = ''
      report(error?.message || '搜尋失敗')
    } finally {
      finding = false
    }
  }
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void findNext()
  })
  findBtn.addEventListener('click', () => void findNext())
  caseBtn.addEventListener('click', () => {
    matchCase = !matchCase
    caseBtn.setAttribute('aria-pressed', String(matchCase))
    caseBtn.classList.toggle('is-on', matchCase)
    paint()
  })

  const resize = new ResizeObserver(() => measure())
  resize.observe(body)
  paintInfo()
  measure()
  const poll = window.setInterval(() => void checkDisk(), POLL_MS)
  // 視窗縮著時不問；一叫回來馬上問，不必等下一輪
  const onVisible = () => void checkDisk()
  document.addEventListener('visibilitychange', onVisible)

  return {
    destroy() {
      destroyed = true
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      resize.disconnect()
      blocks.clear()
      root.remove()
    },
    focus() { body.focus() }
  }
}
