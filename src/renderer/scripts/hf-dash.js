/**
 * HF 模型儀表板：GPU VRAM、用量、本機端點、llama-server log。
 * 金鑰不出 renderer；端點只顯示 127.0.0.1 與埠。
 */

import { electronAPI } from './app.js'

const POLL_MS = 2000
const $ = (id) => document.getElementById(id)

/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null
let on = false
let generation = 0

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function fmtInt(n) {
  return n == null ? '—' : Math.round(Number(n)).toLocaleString('zh-TW')
}

function fmtTps(n) {
  const v = Number(n)
  return v > 0 ? `${v.toFixed(1)} tok/s` : '—'
}

function spec(dl, rows) {
  if (!dl) return
  dl.replaceChildren()
  for (const [label, value] of rows) {
    const group = el('div')
    group.appendChild(el('dt', '', label))
    group.appendChild(el('dd', '', value || '—'))
    dl.appendChild(group)
  }
}

/** 沒有資料就收起來，避免一排破折號跟旁邊的狀態列講同一件事 */
function fillSpecs(id, rows) {
  const dl = $(id)
  if (!dl) return
  dl.classList.toggle('hidden', !rows)
  if (rows) spec(dl, rows)
  else dl.replaceChildren()
}

function meterCard(label, value, pct) {
  const card = el('div', 'hf-gpu')
  const head = el('div', 'hf-gpu-head')
  head.appendChild(el('b', '', label))
  head.appendChild(el('span', '', value))
  card.appendChild(head)
  const meter = el('div', 'hf-meter')
  meter.setAttribute('role', 'meter')
  meter.setAttribute('aria-valuemin', '0')
  meter.setAttribute('aria-valuemax', '100')
  meter.setAttribute('aria-valuenow', String(Math.round(pct)))
  meter.setAttribute('aria-label', `${label} ${value}`)
  const fill = el('i')
  fill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`
  if (pct > 80) fill.dataset.hot = 'true'
  meter.appendChild(fill)
  card.appendChild(meter)
  return card
}

function fmtGb(mib) {
  const gb = Number(mib) / 1024
  return gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)
}

function renderOccupancy(occ) {
  const box = $('hfOccupancy')
  if (!box) return
  const cpu = occ?.cpu
  const mem = occ?.memory
  const memValue = mem?.totalMiB > 0 && mem.usedMiB != null
    ? `${fmtGb(mem.usedMiB)} / ${fmtGb(mem.totalMiB)} GB`
    : '—'
  const memPct = mem?.totalMiB > 0 && mem.usedMiB != null
    ? (mem.usedMiB / mem.totalMiB) * 100
    : 0
  box.replaceChildren(
    meterCard('CPU', cpu == null ? '—' : `${cpu}%`, cpu == null ? 0 : cpu),
    meterCard('記憶體', memValue, memPct)
  )
}

function gpuRows(devices, gpus) {
  if (devices?.length) return devices
  return (gpus || []).filter((gpu) => gpu?.totalMiB).map((gpu) => ({
    id: String(gpu.index),
    name: gpu.name,
    totalMiB: gpu.totalMiB,
    freeMiB: gpu.usedMiB == null ? null : Math.max(0, gpu.totalMiB - gpu.usedMiB),
    utilization: gpu.utilization
  }))
}

function vramLabel(device) {
  const total = Number(device.totalMiB)
  const free = Number(device.freeMiB)
  if (!total || !Number.isFinite(free)) return { text: '', pct: 0 }
  const used = Math.max(0, total - free)
  return {
    text: `${fmtInt(used)} / ${fmtInt(total)} MiB`,
    pct: Math.min(100, (used / total) * 100)
  }
}

function renderGpus(devices, gpus) {
  const box = $('hfGpuMeters')
  if (!box) return
  const rows = gpuRows(devices, gpus)
  if (!rows.length) {
    box.replaceChildren(el('p', 'setting-hint', '沒有可用的 GPU 後端。'))
    return
  }
  box.replaceChildren(...rows.map((device) => {
    const name = device.name || device.id || 'GPU'
    const vram = vramLabel(device)
    const util = device.utilization == null ? '' : `${Math.round(device.utilization)}%`
    const value = [util, vram.text].filter(Boolean).join(' · ') || '—'
    const id = device.id && device.id !== name ? `${device.id}　${value}` : value
    const pct = vram.text ? vram.pct : (device.utilization ?? 0)
    return meterCard(name, id, pct)
  }))
}

function renderLog(lines) {
  const pre = $('hfServerLog')
  if (!pre) return
  const text = (lines || []).join('\n') || '還沒有 log。'
  if (pre.textContent === text) return
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24
  pre.textContent = text
  if (atBottom) pre.scrollTop = pre.scrollHeight
}

async function refresh(seq) {
  let result
  try {
    result = await electronAPI.hfmodels.dashboard()
  } catch {
    return
  }
  const data = result?.ok ? result.data : null
  if (!data || !on || seq !== generation) return

  // 跑沒跑、埠號在大按鈕旁邊那一行。這裡只在真的有端點／用量時才展開。
  fillSpecs('hfServerSpecs', data.running ? [
    ['OpenAI', data.openaiBaseUrl || '—'],
    ['Anthropic', data.anthropicBaseUrl || '—']
  ] : null)
  const m = data.metrics || {}
  fillSpecs('hfUsageSpecs', data.running && data.metrics ? [
    ['處理中 / 排隊', `${fmtInt(m.requestsProcessing)} / ${fmtInt(m.requestsDeferred)}`],
    ['生成速度', fmtTps(m.predictedTps)],
    ['Prompt 速度', fmtTps(m.promptTps)],
    ['Prompt tokens', fmtInt(m.promptTokens)],
    ['生成 tokens', fmtInt(m.predictedTokens)]
  ] : null)
  renderOccupancy(data.occupancy)
  renderGpus(data.devices, data.occupancy?.gpus)
  renderLog(data.logTail)
}

function tick() {
  clearTimeout(timer)
  if (!on) return
  const seq = generation
  refresh(seq).finally(() => {
    if (on && seq === generation) timer = setTimeout(tick, POLL_MS)
  })
}

export function startDash() {
  if (on) return // 切回「執行環境」子分頁會再叫一次；不擋就多一條輪詢鏈，停不乾淨
  on = true
  tick()
}

export function stopDash() {
  on = false
  generation++
  clearTimeout(timer)
  timer = null
}
