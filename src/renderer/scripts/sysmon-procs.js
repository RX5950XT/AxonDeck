/** 處理程序表：欄序／整機占用／圖示與虛擬列。維持固定列高、重用節點。 */
const COLUMNS = [
  { key: 'name', label: '名稱', width: 'minmax(180px, 1fr)' },
  { key: 'pid', label: 'PID', width: '70px' },
  { key: 'cpu', label: 'CPU', width: '72px' },
  { key: 'memory', label: '記憶體', width: '90px' },
  { key: 'diskTotal', label: '磁碟', width: '96px' },
  { key: 'network', label: '網路', width: '96px' },
  { key: 'gpu', label: 'GPU', width: '66px' },
  { key: 'gpuMemory', label: 'VRAM', width: '88px' },
  { key: 'threads', label: '執行緒', width: '72px' }
]
const STORAGE_KEY = 'sysmonProcessColumns'
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
    diskTotal: pct(ready ? maximum((s.disks || []).map((d) => d.busy).filter(Number.isFinite)) : null),
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
    btn.title = '拖曳調換欄位；Alt＋方向鍵也可調換'
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
    const note = $('sysmonNetworkNote')
    if (note) note.textContent = state.sample?.processNetwork?.available
      ? '網路：TCP／UDP、IPv4／IPv6 的收送總量。欄名為整機占用；可拖曳或用 Alt＋方向鍵換欄。'
      : '網路「—」表示目前無法讀取：沿用完整感測器的權限，不另外跳授權視窗。可拖曳欄名換順序。'
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
    row.addEventListener('click', () => onSelect(Number(row.dataset.pid)))
    pool.push(row)
    host.appendChild(row)
  }

  function paintRow(row, p) {
    row.classList.remove('hidden')
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
    spacer.style.height = `${state.rows.length * 30}px`
    const first = Math.max(0, Math.floor(state.scrollTop / 30) - 8)
    const slice = state.rows.slice(first, first + Math.ceil((body.clientHeight || 400) / 30) + 16)
    host.style.transform = `translateY(${first * 30}px)`
    while (pool.length < slice.length) newRow(host)
    for (let i = slice.length; i < pool.length; i += 1) pool[i].classList.add('hidden')
    slice.forEach((p, i) => paintRow(pool[i], p))
  }

  return { renderHead, updateHead, renderRows }
}
