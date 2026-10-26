/**
 * 額度條右邊的「資源」：這個 App 各部分吃掉的 CPU／記憶體（renderer）。
 *
 * 資料在 main 算好（`src/main/app-resources.js`）：條看得到時每 5 秒問一次，
 * 按鈕上顯示總計，抽屜打開時列出每一部分。DOM 全程 `textContent`，零 innerHTML。
 */

import { electronAPI } from './app.js'
import { formatBytes } from './disk-treemap.js'

const POLL_MS = 5000

let open = false
let timer = 0
/** @type {any} */
let last = null

const byId = (id) => document.getElementById(id)

/** @param {number} value 佔整台機器的 % */
function formatCpu(value) {
  const n = Math.max(0, Number(value) || 0)
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`
}

function paintButton() {
  const value = byId('quotaResValue')
  if (!value) return
  value.textContent = last ? `${formatCpu(last.total.cpu)} · ${formatBytes(last.total.memory)}` : ''
}

/** @param {{ label: string, cpu: number, memory: number, count: number }} group */
function row(group, maxMemory) {
  const item = document.createElement('div')
  item.className = 'res-row'
  item.setAttribute('role', 'row')
  const name = document.createElement('span')
  name.className = 'res-name'
  name.setAttribute('role', 'cell')
  name.textContent = group.label
  name.title = `${group.label}（${group.count} 個程序）`
  const count = document.createElement('span')
  count.className = 'res-count'
  count.setAttribute('role', 'cell')
  count.textContent = `×${group.count}`
  const cpu = document.createElement('span')
  cpu.className = 'res-num'
  cpu.setAttribute('role', 'cell')
  cpu.textContent = formatCpu(group.cpu)
  const mem = document.createElement('span')
  mem.className = 'res-num'
  mem.setAttribute('role', 'cell')
  mem.textContent = formatBytes(group.memory)
  const meter = document.createElement('span')
  meter.className = 'res-meter'
  meter.setAttribute('aria-hidden', 'true')
  const fill = document.createElement('span')
  fill.style.width = `${maxMemory > 0 ? Math.max(2, group.memory / maxMemory * 100) : 0}%`
  meter.append(fill)
  item.append(name, count, cpu, mem, meter)
  return item
}

function paintList() {
  const list = byId('resList')
  if (!list) return
  if (!last) {
    list.replaceChildren()
    return
  }
  const head = document.createElement('div')
  head.className = 'res-row res-head'
  head.setAttribute('role', 'row')
  for (const text of ['部分', '程序', 'CPU', '記憶體', '']) {
    const cell = document.createElement('span')
    cell.setAttribute('role', 'columnheader')
    cell.textContent = text
    head.append(cell)
  }
  const maxMemory = Math.max(0, ...last.groups.map((g) => g.memory))
  list.replaceChildren(head, ...last.groups.map((g) => row(g, maxMemory)))
  const total = byId('resTotal')
  if (total) total.textContent = `共 ${last.total.count} 個程序 · CPU ${formatCpu(last.total.cpu)} · 記憶體 ${formatBytes(last.total.memory)}`
  const note = byId('resNote')
  if (note) {
    const age = last.childrenAt ? Math.round((Date.now() - last.childrenAt) / 1000) : -1
    note.textContent = age < 0
      ? 'CPU 是佔整台電腦的比例。終端機、本機模型這些子程序要等系統監控取樣器跑起來才算得到。'
      : `CPU 是佔整台電腦的比例。終端機、本機模型這些子程序的讀數是 ${age} 秒前的（系統監控在背景時約 30 秒更新一次）。`
  }
}

async function refresh() {
  try {
    const res = await electronAPI.sysmon.appResources()
    if (!res?.ok) throw new Error(res?.error?.message || '讀不到資源佔用')
    last = res.data
  } catch (error) {
    const note = byId('resNote')
    if (note && open) note.textContent = error.message || '讀不到資源佔用'
    return
  }
  paintButton()
  if (open) paintList()
}

/** @param {() => boolean} isVisible 額度條看得到才問 */
export function initResourcesBar(isVisible) {
  if (timer) return
  void refresh()
  timer = window.setInterval(() => { if (isVisible()) void refresh() }, POLL_MS)
}

/** @param {boolean} next 抽屜切到／離開「資源」 */
export function setResourcesOpen(next) {
  open = next
  if (!open) return
  paintList()
  void refresh()
}
