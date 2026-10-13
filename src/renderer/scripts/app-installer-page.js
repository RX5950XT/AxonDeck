import { askConfirm } from './app-dialog.js'

let initialized = false
let state = { catalog: [], installed: [], jobs: [], checkedAt: null, busy: false }
let filter = 'catalog'
let query = ''
let category = ''
let pending = false
let icons = {}
let iconsAt = null
let iconsDrawn = 0
let drawn = ''
const byId = (id) => document.getElementById(id)
function el(tag, className, text) {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
function error(message = '') {
  byId('installError').textContent = message
  byId('installError').hidden = !message
}
function accept(result) {
  if (!result?.ok) throw new Error(result?.error?.message || '無法取得應用程式資料。')
  return result.data
}
async function refresh() {
  error()
  try { state = accept(await window.electronAPI.appInstaller.refresh()) }
  catch (err) { error(err.message) }
  render()
}
async function action(actionName, key, name) {
  if (pending) return
  if (actionName === 'uninstall' && !await askConfirm(`解除安裝 ${name}？`, { desc: '將執行這個程式的解除安裝工具。程式自己的資料保留規則仍然適用。', confirmText: '解除安裝', danger: true })) return
  pending = true
  error()
  render()
  try { accept(await window.electronAPI.appInstaller.start({ action: actionName, key })) }
  catch (err) { error(err.message) }
  finally { pending = false; render() }
}
async function upgradeAll(count) {
  if (pending || state.batch || state.scanning) return
  if (!await askConfirm(`更新全部 ${count} 個程式？`, { desc: '會在背景同時更新最多 3 個，可以切換到其他頁面。部分程式會要求 Windows 授權。', confirmText: '全部更新' })) return
  pending = true
  error()
  render()
  try { accept(await window.electronAPI.appInstaller.upgradeAll()) }
  catch (err) { error(err.message) }
  finally { pending = false; render() }
}
// 本機程式圖示優先；常用清單沒裝的用官網 favicon；都沒有就用首字方塊
function logo(name, site) {
  const box = el('span', 'install-logo')
  box.setAttribute('aria-hidden', 'true')
  const letter = () => { box.replaceChildren(); box.textContent = [...name.trim()][0]?.toUpperCase() || '?' }
  const src = icons[name] || (site ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=64` : '')
  if (!src) { letter(); return box }
  const img = document.createElement('img')
  img.alt = ''
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'
  img.src = src
  img.addEventListener('error', letter, { once: true })
  box.append(img)
  return box
}
async function loadIcons() {
  if (!state.iconsStamp || iconsAt === state.iconsStamp) return
  iconsAt = state.iconsStamp
  try { icons = accept(await window.electronAPI.appInstaller.icons()) || {}; iconsDrawn += 1; render() } catch { /* 圖示失敗就用首字方塊 */ }
}
function heading(name, site, iconName = name) {
  const node = el('div', 'install-head')
  node.append(logo(iconName, site), el('h3', 'install-name', name))
  return node
}
function button(label, actionName, row, primary = false) {
  const node = el('button', `btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm`, label)
  node.type = 'button'
  node.disabled = pending || !state.checkedAt || state.jobs.some((job) => !['done', 'failed'].includes(job.phase) && (job.key === row.key || job.catalogKey === row.key))
  node.setAttribute('aria-label', `${label} ${row.name}`)
  node.addEventListener('click', () => void action(actionName, row.key, row.name))
  return node
}
function installedRow(row) {
  const node = el('article', 'install-row')
  node.dataset.key = row.key
  const details = el('div', 'install-details')
  details.append(heading(row.name), el('p', 'install-meta', row.category || '其他'), el('p', 'install-version', `已安裝 ${row.version}${row.available ? ` → ${row.available}` : ''}`))
  if (row.note) details.append(el('p', 'install-meta', row.note))
  const actions = el('div', 'install-actions')
  if (row.canUpgrade) actions.append(button('更新', 'upgrade', row, true))
  if (row.canUninstall) actions.append(button('解除安裝', 'uninstall', row))
  if (!row.canUninstall && !row.note) details.append(el('p', 'install-meta', '系統識別資料不完整，無法安全操作。'))
  node.append(details, actions)
  return node
}
function catalogRow(entry) {
  const rows = entry.installedKeys.map((key) => state.installed.find((row) => row.key === key)).filter(Boolean)
  const node = el('article', 'install-row')
  node.dataset.catalog = entry.key
  const details = el('div', 'install-details')
  details.append(heading(entry.name, entry.site, rows.find((row) => icons[row.name])?.name || entry.name), el('p', 'install-meta', `${entry.group} · ${entry.source}`))
  if (rows.length) details.append(el('p', 'install-version', `已安裝 ${rows.map((row) => row.version).join('、')}${rows.some((row) => row.available) ? ' · 有更新' : ''}`))
  else details.append(el('p', 'install-version', state.checkedAt ? '尚未安裝' : '等待查詢'))
  for (const text of [entry.note, entry.sourceError]) if (text) details.append(el('p', 'install-meta', text))
  const actions = el('div', 'install-actions')
  if (!rows.length && entry.canInstall) actions.append(button('安裝', 'install', entry, true))
  for (const row of rows) {
    if (row.canUpgrade) actions.append(button(rows.length > 1 ? `更新 ${row.version}` : '更新', 'upgrade', row, true))
    if (row.canUninstall) actions.append(button(rows.length > 1 ? `解除安裝 ${row.version}` : '解除安裝', 'uninstall', row))
  }
  node.append(details, actions)
  return node
}
function renderJobs() {
  const host = byId('installJobs')
  const live = state.jobs.filter((job) => !['done', 'failed'].includes(job.phase))
  const recent = state.jobs.filter((job) => ['done', 'failed'].includes(job.phase)).reverse().slice(0, Math.max(0, 5 - live.length))
  host.hidden = !state.jobs.length && !state.batch
  host.replaceChildren()
  if (state.batch) {
    const { total, done, failed } = state.batch
    const node = el('div', 'install-job install-batch')
    node.append(el('strong', '', `全部更新 ${done} / ${total}`), el('span', '', failed ? `${failed} 個失敗，其餘繼續進行` : '最多同時更新 3 個'))
    const bar = el('progress', 'install-progress')
    bar.max = total
    bar.value = done
    bar.setAttribute('aria-label', '全部更新總進度')
    node.append(bar)
    host.append(node)
  }
  for (const job of [...live, ...recent]) {
    const node = el('div', 'install-job')
    node.dataset.phase = job.phase
    const label = { install: '安裝', upgrade: '更新', uninstall: '解除安裝' }[job.action]
    node.append(el('strong', '', `${label} ${job.name}${job.progress !== null && !['done', 'failed'].includes(job.phase) ? ` · ${job.progress}%` : ''}`), el('span', '', job.message))
    if (!['done', 'failed'].includes(job.phase)) {
      const progress = el('progress', 'install-progress')
      progress.max = 100
      if (job.progress !== null) progress.value = job.progress
      progress.setAttribute('aria-label', `${job.name}進度`)
      node.append(progress)
    }
    host.append(node)
  }
}
function renderCategories(counts, total) {
  const order = state.categories || [...counts.keys()]
  const chips = [['', '全部', total], ...order.filter((name) => counts.has(name)).map((name) => [name, name, counts.get(name)])]
  byId('installCategories').replaceChildren(...chips.map(([value, label, count]) => {
    const chip = el('button', `install-chip${value === category ? ' active' : ''}`, `${label} ${count}`)
    chip.type = 'button'
    chip.dataset.category = value
    chip.setAttribute('aria-pressed', String(value === category))
    return chip
  }))
}
function render() {
  const updates = state.installed.filter((row) => row.canUpgrade)
  byId('installRefresh').disabled = !!state.scanning
  const all = byId('installUpgradeAll')
  all.hidden = !updates.length
  all.textContent = `全部更新（${updates.length}）`
  all.disabled = pending || !!state.batch
  byId('installSummary').textContent = state.scanning ? '正在查詢已安裝程式與更新…' : state.checkedAt
    ? `已安裝 ${state.installed.length} 項 · 可更新 ${updates.length} 項 · ${new Date(state.checkedAt).toLocaleTimeString('zh-TW')} 查詢` : '尚未取得清單。'
  byId('installList').setAttribute('aria-busy', String(!!state.scanning))
  // 進度每秒會通知很多次；清單與分類沒變就不重畫，免得按鈕在點下去的瞬間被換掉而按不到
  const locks = state.jobs.filter((job) => !['done', 'failed'].includes(job.phase)).map((job) => job.key + job.catalogKey)
  const signature = JSON.stringify([state.checkedAt, state.scanning, state.iconsStamp, iconsDrawn, pending, filter, query, category, locks, state.installed.length, state.catalog.map((entry) => entry.sourceError)])
  if (signature === drawn) { renderJobs(); return }
  drawn = signature
  const matched = (filter === 'catalog' ? state.catalog : filter === 'updates' ? updates : state.installed)
    .filter((row) => row.name.toLocaleLowerCase().includes(query))
  const counts = new Map()
  for (const row of matched) counts.set(row.category || '其他', (counts.get(row.category || '其他') || 0) + 1)
  if (category && !counts.has(category)) category = ''
  renderCategories(counts, matched.length)
  const rows = category ? matched.filter((row) => (row.category || '其他') === category) : matched
  byId('installList').replaceChildren(...rows.map(filter === 'catalog' ? catalogRow : installedRow))
  if (!rows.length) byId('installList').append(el('p', 'install-empty', state.scanning ? '正在讀取…' : query ? '沒有符合的程式。' : !state.checkedAt ? '按「重新整理」取得清單。' : filter === 'updates' ? '目前沒有來源能確認的更新。' : '沒有程式。'))
  renderJobs()
  void loadIcons()
}
export async function openInstallerPage() {
  if (!initialized) {
    initialized = true
    byId('installRefresh').addEventListener('click', () => void refresh())
    byId('installUpgradeAll').addEventListener('click', () => void upgradeAll(state.installed.filter((row) => row.canUpgrade).length))
    byId('installCategories').addEventListener('click', (event) => {
      const chip = event.target.closest('[data-category]')
      if (chip) { category = chip.dataset.category; render() }
    })
    byId('installSearch').addEventListener('input', (event) => { query = event.target.value.trim().toLocaleLowerCase(); render() })
    byId('installFilters').addEventListener('click', (event) => {
      const item = event.target.closest('[data-filter]')
      if (!item) return
      filter = item.dataset.filter
      for (const button of byId('installFilters').children) {
        button.classList.toggle('active', button === item)
        button.setAttribute('aria-pressed', String(button === item))
      }
      render()
    })
    window.electronAPI.appInstaller.onState((next) => { state = next; if (next.scanError) error(next.scanError); render() })
  }
  try {
    state = accept(await window.electronAPI.appInstaller.status())
    render()
    if (!state.checkedAt && !state.scanning) await refresh()
  } catch (err) { error(err.message) }
}
