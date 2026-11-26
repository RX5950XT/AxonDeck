'use strict'

/**
 * AxonDeck — Linux 效能調整：NVIDIA（nvidia-smi）。
 *
 * Linux 的 nvidia-smi 只給「牆」與「鎖頻」，沒有 Windows NVAPI 那種時脈偏移／電壓／V/F 曲線：
 *   -pl <W>            功耗上限（驅動自己夾在 power.min_limit～power.max_limit）
 *   -lgc 0,<MHz>       鎖核心時脈上限（只能往下，不能超過出廠最高）；-rgc 解除
 *   -lmc 0,<MHz>       鎖記憶體時脈上限（Ampere 之後才支援）；-rmc 解除
 * 全部要 root：寫入一律經 oc-access-linux.js 的 runNvidia（pkexec 或 root 直接跑）。
 */

const fs = require('fs')
const { execFile } = require('child_process')

const SMI_PATHS = ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', '/opt/bin/nvidia-smi']
const QUERY = 'index,name,pci.bus_id,power.limit,power.default_limit,power.min_limit,power.max_limit,clocks.max.graphics,clocks.max.memory,clocks.gr,clocks.mem,temperature.gpu,power.draw,utilization.gpu'

function findSmi(exists = (p) => { try { return fs.existsSync(p) } catch { return false } }) {
  return SMI_PATHS.find((p) => exists(p)) || ''
}

function num(text) {
  const t = String(text ?? '').trim()
  if (!t || /^\[|N\/A/i.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {string} csv `--format=csv,noheader,nounits`
 */
function parseQuery(csv) {
  const out = []
  for (const line of String(csv || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const f = line.split(',').map((s) => s.trim())
    if (f.length < 14) continue
    const index = num(f[0])
    if (index === null) continue
    out.push({
      kind: 'nvidia',
      id: `nvidia:${f[2] || index}`,
      index,
      name: f[1],
      pci: f[2],
      powerW: num(f[3]),
      defPowerW: num(f[4]),
      minPowerW: num(f[5]),
      maxPowerW: num(f[6]),
      maxClock: num(f[7]),
      maxMemClock: num(f[8]),
      live: { clock: num(f[9]), mem: num(f[10]), temp: num(f[11]), powerW: num(f[12]), load: num(f[13]) }
    })
  }
  return out
}

/**
 * @param {{ smiPath: string, execFileFn?: Function, timeoutMs?: number }} deps
 */
function queryGpus(deps) {
  const run = deps.execFileFn || execFile
  if (!deps.smiPath) return Promise.resolve([])
  return new Promise((resolve) => {
    run(deps.smiPath, [`--query-gpu=${QUERY}`, '--format=csv,noheader,nounits'], { timeout: deps.timeoutMs || 5000 }, (err, stdout) => {
      resolve(err ? [] : parseQuery(String(stdout || '')))
    })
  })
}

/**
 * 草稿 → nvidia-smi 指令。coreMHz／memMHz 在 Linux 是「上限往下調多少」（≤0），0＝解除鎖頻。
 * @param {any} gpu parseQuery 的一張
 * @param {{ powerPct: number, coreMHz: number, memMHz: number }} draft
 */
function buildOps(gpu, draft) {
  const ops = []
  const i = gpu.index
  if (gpu.defPowerW && gpu.minPowerW !== null && gpu.maxPowerW !== null) {
    const watts = Math.round(Math.min(gpu.maxPowerW, Math.max(gpu.minPowerW, gpu.defPowerW * draft.powerPct / 100)))
    ops.push([i, '-pl', String(watts)])
  }
  if (gpu.maxClock) {
    const off = Math.min(0, Math.round(draft.coreMHz))
    ops.push(off === 0 ? [i, '-rgc', null] : [i, '-lgc', `0,${Math.max(200, gpu.maxClock + off)}`])
  }
  if (gpu.maxMemClock) {
    const off = Math.min(0, Math.round(draft.memMHz))
    ops.push(off === 0 ? [i, '-rmc', null] : [i, '-lmc', `0,${Math.max(200, gpu.maxMemClock + off)}`])
  }
  return ops
}

/**
 * 還原：解除鎖頻、功耗牆回到接手前（沒有就回出廠）。
 * @param {any} gpu
 * @param {number|null} originalW
 */
function restoreOps(gpu, originalW) {
  const ops = [[gpu.index, '-rgc', null]]
  if (gpu.maxMemClock) ops.push([gpu.index, '-rmc', null])
  const watts = originalW ?? gpu.defPowerW
  if (watts) ops.push([gpu.index, '-pl', String(Math.round(watts))])
  return ops
}

module.exports = { SMI_PATHS, QUERY, findSmi, parseQuery, queryGpus, buildOps, restoreOps }
