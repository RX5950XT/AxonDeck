/** 處理程序表：欄序／整機占用／圖示與虛擬列。維持固定列高、重用節點。 */
const COLUMNS = [
  { key: 'name', label: '名稱', width: 'minmax(180px, 1fr)' },
  { key: 'pid', label: 'PID', width: '70px' },
  { key: 'cpu', label: 'CPU', width: '72px' },
  { key: 'memory', label: '記憶體', width: '90px', hint: '私有工作集（跟工作管理員同一個數字，不含共用的 DLL 頁）' },
  // 程序的讀寫計數含檔案快取命中、管道與裝置 I/O，不等於實體磁碟，所以叫 I/O 不叫磁碟
  { key: 'diskTotal', label: 'I/O', width: '96px', hint: '程序自己的讀寫量，含快取命中與管道，不等於實體磁碟；表頭是全部加總' },
  { key: 'network', label: '網路', width: '96px', hint: 'TCP／UDP、IPv4／IPv6 的收送總量；表頭是整機占用' },
  { key: 'gpu', label: 'GPU', width: '66px' },
  { key: 'gpuMemory', label: 'VRAM', width: '88px', hint: 'Windows 記帳的配置量（dwm 會預留大塊）；實際駐留量看總覽頁' },
  { key: 'threads', label: '執行緒', width: '72px' }
]
const STORAGE_KEY = 'sysmonProcessColumns'
const DRAG_HINT = '拖曳調換欄位；Alt＋方向鍵也可調換'
const FALLBACK_ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="2" fill="#8993a4"/><path d="M3 5h10M5 8h2m2 0h2M5 11h6" stroke="#fff" fill="none"/></svg>')
const PICKS = {
  pid: (p) => p.pid, name: (p) => p.name.toLowerCase(), cpu: (p) => p.cpu,
  memory: (p) => p.memory, threads: (p) => p.threads,
  diskTotal: (p) => p.diskRead + p.diskWrite, network: (p) => p.network,
  gpu: (p) => p.gpu, gpuMemory: (p) => p.gpuMemory
}

export function normalizeOrder(input) {
  const valid = COLUMNS.map((col) => col.key)
  const saved = Array.isArray(input) ? input.filter((key) => valid.includes(key) && key !== 'name') : []
  return ['name', ...new Set([...saved, ...valid.filter((key) => key !== 'name')])]
}

export function moveColumn(order, from, to) {
  if (from === 'name' || to === 'name' || from === to || !order.includes(from) || !order.includes(to)) return [...order]
  const next = order.filter((key) => key !== from)
  next.splice(order.indexOf(to), 0, from)
  return next
}

export function safeIcon(data) {
  return typeof data === 'string' && data.length < 128000
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data) ? data : ''
}

export function networkRate(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  return value >= 125000 ? `${(value * 8 / 1e6).toFixed(1)} Mbps` : `${(value / 1024).toFixed(value < 1024 ? 0 : 1)} KB/s`
}

/** 位元組／秒 → 表頭用的總速率；不到 1 KB/s 當閒置 */
export function ioRate(value) {
  if (!Number.isFinite(value) || value < 1024) return '—'
  const units = ['KB/s', 'MB/s', 'GB/s']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1 }
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

const pct = (value) => Number.isFinite(value) ? `${value > 0 && value < 1 ? value.toFixed(1) : Math.round(value)}%` : '—'
const maximum = (values) => values.length ? Math.max(...values) : null

export function processTotals(s = {}) {
  const ready = s.countersReady !== false
  const nets = s.nets || []
  const linksKnown = nets.length > 0 && nets.every((n) => n.linkSpeed > 0 && Number.isFinite(n.rx) && Number.isFinite(n.tx))
  const cards = s.gpu?.cards || []
  const vramKnown = cards.length > 0 && cards.every((c) => Number.isFinite(c.memoryUsed) && c.memoryTotal > 0)
  const gpus = [...Object.values(s.gpuAdapterUtil || {}), ...cards.map((c) => c.utilization)].filter(Number.isFinite)
  return {
    cpu: pct(ready ? s.cpu?.total : null),
    memory: pct(s.memory && s.totalMemory > 0 ? (1 - s.memory.available / s.totalMemory) * 100 : null),
    diskTotal: ready ? ioRate((s.processes || []).reduce((n, p) => n + (p.diskRead || 0) + (p.diskWrite || 0), 0)) : '—',
    network: pct(ready && linksKnown ? nets.reduce((n, x) => n + x.rx + x.tx, 0) * 800 / nets.reduce((n, x) => n + x.linkSpeed, 0) : null),
    gpu: pct(ready ? maximum(gpus) : null),
    gpuMemory: pct(vramKnown ? cards.reduce((n, c) => n + c.memoryUsed, 0) / cards.reduce((n, c) => n + c.memoryTotal, 0) * 100 : null),
    pid: String((s.processes || []).reduce((n, p) => n + (p.count || 1), 0)),
    threads: String((s.processes || []).reduce((n, p) => n + (p.threads || 0), 0))
  }
}

export function sortProcessRows(list, key, dir) {
  const pick = PICKS[key] || PICKS.cpu
  const sign = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const av = pick(a), bv = pick(b)
    if (av == null || bv == null) return av == null && bv == null ? a.pid - b.pid : av == null ? 1 : -1
    return av < bv ? -sign : av > bv ? sign : a.pid - b.pid
  })
}

/**
 * 依工作管理員的分法切兩段：有應用程式視窗的（前台）在上、其餘背景處理程序在下，
 * 各段前面插一列標題。段內維持原本的排序。
 */
export function splitProcessRows(rows) {
  const apps = rows.filter((p) => p.app)
  const rest = rows.filter((p) => !p.app)
  return [
    ...(apps.length ? [{ header: '應用程式', count: apps.length }, ...apps] : []),
    ...(rest.length ? [{ header: '背景處理程序', count: rest.length }, ...rest] : [])
  ]
}

export function isProcessSortKey(key) { return Object.hasOwn(PICKS, key) }

export function createProcessTable({ state, $, onSort, onSelect, fmtBytes, fmtRate, fmtPct }) {
  let order
  try { order = normalizeOrder(JSON.parse(localStorage.getItem(STORAGE_KEY))) } catch { order = normalizeOrder() }
  const pool = []
  let dragging = ''
  let ignoreClickUntil = 0

  function applyOrder() {
    const grid = order.map((key) => COLUMNS.find((col) => col.key === key).width).join(' ')
    $('sysmonHead')?.closest('.sysmon-table')?.style.setProperty('--sysmon-proc-columns', grid)
    for (const host of [$('sysmonHead'), ...pool]) {
      if (!host) continue
      for (const key of order) {
        const cell = [...host.children].find((item) => item.dataset.key === key)
        if (cell) host.appendChild(cell)
      }
    }
  }

  function changeOrder(from, to) {
    order = moveColumn(order, from, to)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)) } catch { /* 儲存被停用仍可換順序 */ }
    applyOrder()
  }

  function setupDrag(btn, key) {
    if (key === 'name') return
    btn.draggable = true
    const hint = COLUMNS.find((col) => col.key === key)?.hint
    btn.title = [hint, DRAG_HINT].filter(Boolean).join('\n')
    btn.addEventListener('dragstart', (e) => {
      dragging = key
      e.dataTransfer.setData('text/plain', key)
      e.dataTransfer.effectAllowed = 'move'
      btn.classList.add('is-dragging')
    })
    btn.addEventListener('dragover', (e) => {
      if (!dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      btn.classList.add('is-drop-target')
    })
    btn.addEventListener('dragleave', () => btn.classList.remove('is-drop-target'))
    btn.addEventListener('drop', (e) => {
      if (!dragging) return
      e.preventDefault()
      changeOrder(dragging, key)
      endDrag()
    })
    btn.addEventListener('dragend', endDrag)
    btn.addEventListener('keydown', (e) => {
      if (!e.altKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return
      e.preventDefault()
      const to = order[order.indexOf(key) + (e.key === 'ArrowLeft' ? -1 : 1)]
      if (to) changeOrder(key, to)
      btn.focus()
    })
  }

  function endDrag() {
    dragging = ''
    ignoreClickUntil = Date.now() + 200
    for (const btn of $('sysmonHead')?.children || []) btn.classList.remove('is-dragging', 'is-drop-target')
  }

  function renderHead() {
    const head = $('sysmonHead')
    if (!head) return
    if (!head.children.length) for (const col of COLUMNS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `sysmon-th sysmon-th-${col.key === 'name' ? 'left' : 'right'}`
      btn.dataset.key = col.key
      btn.setAttribute('role', 'columnheader')
      const total = document.createElement('span')
      total.className = 'sysmon-column-total'
      const label = document.createElement('span')
      label.className = 'sysmon-column-label'
      label.textContent = col.label
      const arrow = document.createElement('i')
      arrow.className = 'sysmon-sort-arrow'
      label.appendChild(arrow)
      btn.append(total, label)
      btn.addEventListener('click', () => {
        if (!dragging && Date.now() >= ignoreClickUntil) onSort(col.key)
      })
      setupDrag(btn, col.key)
      head.appendChild(btn)
    }
    applyOrder()
    updateHead()
  }

  function updateHead() {
    const totals = processTotals(state.sample || {})
    for (const btn of $('sysmonHead')?.children || []) {
      const key = btn.dataset.key
      const sorted = key === state.sortKey
      btn.firstElementChild.textContent = key === 'name' ? '' : totals[key]
      btn.classList.toggle('is-sorted', sorted)
      btn.classList.toggle('is-asc', sorted && state.sortDir === 'asc')
      btn.setAttribute('aria-sort', sorted ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none')
    }
    const net = [...($('sysmonHead')?.children || [])].find((btn) => btn.dataset.key === 'network')
    if (net) net.title = [state.sample?.processNetwork?.available
      ? COLUMNS.find((col) => col.key === 'network').hint
      : '「—」表示目前無法讀取：沿用完整感測器的權限，不另外跳授權視窗', DRAG_HINT].join('\n')
  }

  function newRow(host) {
    const row = document.createElement('div')
    row.className = 'sysmon-row'
    row.setAttribute('role', 'row')
    for (const key of order) {
      const cell = document.createElement('span')
      cell.className = `sysmon-td sysmon-td-${key === 'name' ? 'left' : 'right'}`
      cell.dataset.key = key
      cell.setAttribute('role', 'cell')
      if (key === 'name') {
        const img = document.createElement('img')
        img.className = 'sysmon-proc-icon'
        img.width = img.height = 16
        img.alt = ''
        img.draggable = false
        img.addEventListener('error', () => { if (img.src !== FALLBACK_ICON) img.src = FALLBACK_ICON })
        cell.append(img, document.createElement('span'))
      }
      row.appendChild(cell)
    }
    row.addEventListener('click', () => {
      if (row.dataset.pid) onSelect(Number(row.dataset.pid))
    })
    pool.push(row)
    host.appendChild(row)
  }

  function paintHeader(row, p) {
    row.classList.remove('hidden', 'is-selected')
    row.classList.add('is-group')
    row.dataset.pid = ''
    for (const cell of row.children) {
      cell.classList.remove('is-hot')
      if (cell.dataset.key === 'name') {
        cell.lastElementChild.textContent = `${p.header}（${p.count}）`
        cell.title = ''
      } else cell.textContent = ''
    }
  }

  function paintRow(row, p) {
    if (p.header) { paintHeader(row, p); return }
    row.classList.remove('hidden', 'is-group')
    row.dataset.pid = String(p.pid)
    row.classList.toggle('is-selected', state.selectedPid === p.pid)
    const values = {
      pid: (p.count || 1) > 1 ? `×${p.count}` : String(p.pid),
      cpu: fmtPct(p.cpu), memory: fmtBytes(p.memory), diskTotal: fmtRate(p.diskRead + p.diskWrite),
      network: networkRate(p.network), gpu: fmtPct(p.gpu), gpuMemory: p.gpuMemory > 0 ? fmtBytes(p.gpuMemory) : '—',
      threads: String(p.threads)
    }
    for (const cell of row.children) {
      const key = cell.dataset.key
      if (key === 'name') {
        const img = cell.firstElementChild
        const src = safeIcon(p.icon) || FALLBACK_ICON
        if (img.getAttribute('src') !== src) img.src = src
        cell.lastElementChild.textContent = p.name
        cell.title = p.name
      } else cell.textContent = values[key]
      cell.classList.toggle('is-hot', key === 'cpu' ? p.cpu >= 10 : key === 'memory' && p.memory >= 1073741824)
    }
  }

  function renderRows() {
    const body = $('sysmonBody'), spacer = $('sysmonSpacer'), host = $('sysmonRows')
    if (!body || !spacer || !host) return
    const rows = state.viewRows || state.rows
    spacer.style.height = `${rows.length * 30}px`
    const first = Math.max(0, Math.floor(state.scrollTop / 30) - 8)
    const slice = rows.slice(first, first + Math.ceil((body.clientHeight || 400) / 30) + 16)
    host.style.transform = `translateY(${first * 30}px)`
    while (pool.length < slice.length) newRow(host)
    for (let i = slice.length; i < pool.length; i += 1) pool[i].classList.add('hidden')
    slice.forEach((p, i) => paintRow(pool[i], p))
  }

  return { renderHead, updateHead, renderRows }
}
