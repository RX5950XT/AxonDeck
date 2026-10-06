'use strict'

/**
 * 執行環境「占用」：CPU%、記憶體 used/total、NVIDIA 使用率。
 * 不開常駐 nvidia-smi（系統監控已經有一顆）；這裡每輪問一次就結束。
 */

const os = require('os')
const { execFile } = require('child_process')
const { cpuUsage } = require('../sysmon/metrics')

const GPU_TIMEOUT_MS = 1500
const GPU_ARGS = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits'
]

/** @type {object[] | null} */
let prevCpus = null
/** @type {Promise<Array<object>> | null} */
let gpuFlight = null
/** @type {Array<object>} */
let lastGpus = []

/**
 * 沒有上一輪就回 null。0 只代表這段時間真的沒在忙。
 * @param {object[] | null} prev
 * @param {object[] | null} curr
 * @returns {number | null}
 */
function readCpuPercent(prev, curr) {
  if (!prev || !curr) return null
  const { total } = cpuUsage(prev, curr)
  if (!Number.isFinite(total)) return null
  return Math.round(Math.max(0, Math.min(100, total)))
}

function takeCpu() {
  const curr = os.cpus()
  const pct = readCpuPercent(prevCpus, curr)
  prevCpus = curr
  return pct
}

function takeMemory() {
  const total = os.totalmem()
  const used = Math.max(0, total - os.freemem())
  return {
    usedMiB: Math.round(used / (1024 * 1024)),
    totalMiB: Math.round(total / (1024 * 1024))
  }
}

/**
 * @param {string} text nvidia-smi CSV
 * @returns {Array<{ index: number, name: string, utilization: number | null, usedMiB: number | null, totalMiB: number | null }>}
 */
function parseGpuCsv(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = line.split(',').map((value) => value.trim())
    if (fields.length < 5 || !fields[1]) continue
    rows.push({
      index: numOrNull(fields[0]) ?? 0,
      name: fields[1],
      utilization: numOrNull(fields[2]),
      usedMiB: numOrNull(fields[3]),
      totalMiB: numOrNull(fields[4])
    })
  }
  return rows
}

/** `[N/A]` 是缺值，不准當成 0 */
function numOrNull(raw) {
  if (!raw || /N\/A/i.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function queryGpus(execFileFn = execFile) {
  if (gpuFlight) return gpuFlight
  gpuFlight = new Promise((resolve) => {
    let settled = false
    const finish = (rows) => {
      if (settled) return
      settled = true
      gpuFlight = null
      if (rows) lastGpus = rows
      resolve(lastGpus)
    }
    try {
      execFileFn('nvidia-smi', GPU_ARGS, { timeout: GPU_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        finish(error ? null : parseGpuCsv(stdout))
      })
    } catch {
      finish(null)
    }
  })
  return gpuFlight
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * 把 nvidia-smi 的使用率接到 llama.cpp 列出來的同一張卡。對不到就留 null。
 * @param {Array<object>} devices
 * @param {Array<object>} gpus
 */
function attachUtil(devices, gpus) {
  const used = new Set()
  return (devices || []).map((device) => {
    const name = normName(device?.name)
    const idx = (gpus || []).findIndex((gpu, i) => {
      if (used.has(i)) return false
      const gpuName = normName(gpu?.name)
      return !!gpuName && !!name && (name.includes(gpuName) || gpuName.includes(name))
    })
    if (idx < 0) return { ...device, utilization: null }
    used.add(idx)
    return { ...device, utilization: gpus[idx].utilization ?? null }
  })
}

async function sample(deps = {}) {
  const gpus = await queryGpus(deps.execFileFn)
  return { cpu: takeCpu(), memory: takeMemory(), gpus }
}

module.exports = { readCpuPercent, parseGpuCsv, attachUtil, sample }
