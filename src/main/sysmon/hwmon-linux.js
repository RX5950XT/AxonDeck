'use strict'

/**
 * AxonDeck — Linux 感測器讀取（/sys/class/hwmon、/sys/class/thermal、RAPL、/proc/stat）。
 *
 * 純讀取，不需要 root。輸出格式刻意跟 Windows sidecar 的 `h`／`c` 一模一樣
 * （見 native/sysmon-sensors/Program.cs 的類別註解），風扇引擎與畫面一行都不用改：
 *   h: [{ n: 硬體名, t: 'Cpu'|'GpuAmd'|…, s: [{ n, t: 'Temperature'|'Fan'|…, v }] }]
 *   c: [{ id, n, hw, pwm, rpm, min, max, o }]
 *
 * 讀不到的值一律不放（不是 0），跟 sidecar 的「Value 為 null 就略過」同一條規則。
 * sysfs 全用 fs.promises：drivetemp／nvme 的讀取會等硬碟回應，同步讀會卡主程序。
 */

const fsp = require('fs').promises
const path = require('path')

/** hwmon 晶片名 → LHM 的 HardwareType（畫面與風扇來源靠它分組） */
const CHIP_TYPES = [
  [/^(k10temp|zenpower|coretemp|fam15h_power|cpu_thermal|via_cputemp|scpi_sensors)$/, 'Cpu'],
  [/^amdgpu$/, 'GpuAmd'],
  [/^(i915|xe)$/, 'GpuIntel'],
  [/^nouveau$/, 'GpuNvidia'],
  [/^(nvme|drivetemp)$/, 'Storage'],
  [/^(nct\d+|it\d+|it87|f71\d+|w83\w+|asus\w*|gigabyte_wmi|dell_smm|thinkpad|applesmc|asb100|lm\d+|sch\d+)$/i, 'SuperIO'],
  [/^(spd5118|jc42|ee1004)$/, 'Memory'],
  [/^(BAT\d*|battery|ucsi_source_psy\w*|AC\d*|ADP\d*)$/i, 'Battery'],
  [/^(iwlwifi\w*|mt7\w+|r8169\w*|ath\w+|e1000e\w*|igc\w*|bnxt\w*)$/i, 'Network'],
  [/^(acpitz|pch_\w+)$/, 'Motherboard']
]

/** thermal zone 的 type → HardwareType（同名 hwmon 已在就略過，避免 acpitz 出現兩次） */
const ZONE_TYPES = [
  [/^(x86_pkg_temp|cpu|soc_dts\d*|TCPU|cpu-thermal|cpu_thermal)$/i, 'Cpu'],
  [/^(iwlwifi\w*)$/i, 'Network']
]

/** amdgpu 的 label 換成 LHM 的叫法：風扇來源的 prefer 規則認的是 `GPU Core`／`Hot Spot` */
const AMDGPU_LABELS = { edge: 'GPU Core', junction: 'GPU Hot Spot', mem: 'GPU Memory', sclk: 'GPU Core', mclk: 'GPU Memory', PPT: 'GPU Package' }

/** 檔名前綴 → [感測器型別, 換算除數] */
const KINDS = {
  temp: ['Temperature', 1000],
  fan: ['Fan', 1],
  in: ['Voltage', 1000],
  curr: ['Current', 1000],
  power: ['Power', 1e6],
  freq: ['Clock', 1e6]
}

const INPUT_RE = /^(temp|fan|in|curr|power|freq)(\d+)_(input|average)$/
const ENERGY_RE = /^energy(\d+)_input$/
const PWM_RE = /^pwm(\d+)$/

function classify(table, name, fallback) {
  for (const [re, type] of table) if (re.test(String(name || ''))) return type
  return fallback
}

async function readText(file) {
  try {
    return (await fsp.readFile(file, 'utf8')).trim()
  } catch {
    return null
  }
}

async function readNum(file) {
  const text = await readText(file)
  if (text === null || text === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

async function listDir(dir) {
  try {
    return await fsp.readdir(dir)
  } catch {
    return []
  }
}

async function writable(file) {
  try {
    await fsp.access(file, require('fs').constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** 給 id 用：協定以空白分隔，識別碼裡不可以有空白 */
function safeId(text) {
  return String(text || '').replace(/[^A-Za-z0-9._:@/-]+/g, '_').slice(0, 96)
}

/** 硬體顯示名：CPU 用 /proc/cpuinfo 的型號，其餘用晶片名＋裝置位址 */
function chipDisplay(name, type, devId, cpuModel) {
  if (type === 'Cpu' && cpuModel) return cpuModel
  if (type === 'GpuAmd') return devId ? `AMD Radeon (${devId})` : 'AMD Radeon'
  if (type === 'GpuIntel') return devId ? `Intel Graphics (${devId})` : 'Intel Graphics'
  if (type === 'GpuNvidia') return devId ? `NVIDIA (nouveau ${devId})` : 'NVIDIA (nouveau)'
  return devId ? `${name} (${devId})` : name
}

/**
 * 掃一個 hwmon 目錄的「結構」（哪些檔、什麼標籤），值每一輪另外讀。
 * @param {string} dir @param {string} cpuModel
 */
async function scanChip(dir, cpuModel) {
  const name = (await readText(path.join(dir, 'name'))) || path.basename(dir)
  const type = classify(CHIP_TYPES, name, 'Motherboard')
  let devId = ''
  try {
    devId = path.basename(await fsp.realpath(path.join(dir, 'device')))
  } catch { /* 沒有 device 連結（虛擬晶片） */ }
  if (/^hwmon\d+$/.test(devId)) devId = ''
  const files = await listDir(dir)
  const chip = {
    dir, name, type, devId,
    key: safeId(`${name}@${devId || path.basename(dir)}`),
    display: chipDisplay(name, type, devId, cpuModel),
    inputs: [], energies: [], pwms: [], busyFile: ''
  }
  for (const file of files.sort()) {
    const m = INPUT_RE.exec(file)
    if (m) {
      // power 同時有 _input 與 _average 時只留一個
      if (m[3] === 'average' && files.includes(`${m[1]}${m[2]}_input`)) continue
      const raw = await readText(path.join(dir, `${m[1]}${m[2]}_label`))
      chip.inputs.push({ file, kind: m[1], index: Number(m[2]), label: labelFor(chip, m[1], Number(m[2]), raw) })
      continue
    }
    const e = ENERGY_RE.exec(file)
    if (e) {
      const raw = await readText(path.join(dir, `energy${e[1]}_label`))
      chip.energies.push({ file, index: Number(e[1]), label: labelFor(chip, 'power', Number(e[1]), raw) })
      continue
    }
    const p = PWM_RE.exec(file)
    if (p) chip.pwms.push(Number(p[1]))
  }
  if (type === 'GpuAmd') {
    const busy = path.join(dir, 'device', 'gpu_busy_percent')
    if ((await readNum(busy)) !== null) chip.busyFile = busy
  }
  return chip
}

function labelFor(chip, kind, index, raw) {
  const label = String(raw || '').trim()
  if (chip.type === 'GpuAmd' && AMDGPU_LABELS[label]) return AMDGPU_LABELS[label]
  if (label) return label
  if (chip.type === 'Storage' && kind === 'temp') return index === 1 ? 'Temperature' : `Temperature #${index}`
  if (kind === 'fan') return chip.type.startsWith('Gpu') ? 'GPU Fan' : `Fan #${index}`
  if (kind === 'temp') return index === 1 ? 'Temperature' : `Temperature #${index}`
  if (kind === 'in') return `Voltage #${index}`
  if (kind === 'power') return chip.type === 'Cpu' ? 'Package' : `Power #${index}`
  return `${kind}${index}`
}

/** 從 /proc/cpuinfo 拿 CPU 型號（只讀一次） */
async function readCpuModel(procRoot) {
  const text = (await readText(path.join(procRoot, 'cpuinfo'))) || ''
  const m = /^model name\s*:\s*(.+)$/m.exec(text) || /^Hardware\s*:\s*(.+)$/m.exec(text)
  return m ? m[1].trim() : 'CPU'
}

/**
 * 整機結構掃描：hwmon 晶片、沒有對應 hwmon 的 thermal zone、RAPL。
 * @param {{ sysfsRoot: string, procRoot: string }} roots
 */
async function scanSystem(roots) {
  const cpuModel = await readCpuModel(roots.procRoot)
  const hwmonDir = path.join(roots.sysfsRoot, 'class', 'hwmon')
  const chips = []
  for (const entry of (await listDir(hwmonDir)).sort(naturalCmp)) {
    chips.push(await scanChip(path.join(hwmonDir, entry), cpuModel))
  }
  const chipNames = new Set(chips.map((c) => c.name))
  const zones = []
  const thermalDir = path.join(roots.sysfsRoot, 'class', 'thermal')
  for (const entry of (await listDir(thermalDir)).sort(naturalCmp)) {
    if (!entry.startsWith('thermal_zone')) continue
    const type = (await readText(path.join(thermalDir, entry, 'type'))) || entry
    if (chipNames.has(type)) continue
    zones.push({ file: path.join(thermalDir, entry, 'temp'), type, hw: classify(ZONE_TYPES, type, 'Motherboard') })
  }
  const rapl = []
  const capDir = path.join(roots.sysfsRoot, 'class', 'powercap')
  for (const entry of (await listDir(capDir)).sort(naturalCmp)) {
    // 只取頂層 package（intel-rapl:0），子網域（:0:0 core）留給之後
    if (!/^intel-rapl:\d+$/.test(entry)) continue
    const file = path.join(capDir, entry, 'energy_uj')
    // 2020 年起多數發行版把 energy_uj 改成只有 root 讀得到（PLATYPUS），讀不到就不列
    if ((await readNum(file)) === null) continue
    const label = (await readText(path.join(capDir, entry, 'name'))) || entry
    rapl.push({ file, label: label === 'package-0' ? 'Package' : label })
  }
  return { cpuModel, chips, zones, rapl }
}

function naturalCmp(a, b) {
  return a.localeCompare(b, 'en', { numeric: true })
}

/** /proc/stat 第一行 → { busy, total }（jiffies） */
function parseCpuStat(text) {
  const line = String(text || '').split('\n').find((l) => l.startsWith('cpu '))
  if (!line) return null
  const f = line.trim().split(/\s+/).slice(1).map(Number)
  const idle = (f[3] || 0) + (f[4] || 0)
  const total = f.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  return { busy: total - idle, total }
}

/** 每核目前時脈（MHz），讀不到的核略過 */
async function readCoreClocks(sysfsRoot) {
  const base = path.join(sysfsRoot, 'devices', 'system', 'cpu')
  const cores = (await listDir(base)).filter((d) => /^cpu\d+$/.test(d)).sort(naturalCmp)
  const out = []
  for (const core of cores) {
    const khz = await readNum(path.join(base, core, 'cpufreq', 'scaling_cur_freq'))
    if (khz !== null && khz > 0) out.push({ n: `Core #${Number(core.slice(3)) + 1}`, t: 'Clock', v: Math.round(khz / 1000) })
  }
  return out
}

module.exports = {
  CHIP_TYPES, ZONE_TYPES, KINDS, AMDGPU_LABELS,
  classify, readText, readNum, listDir, writable, safeId,
  scanChip, scanSystem, labelFor, parseCpuStat, readCoreClocks, readCpuModel
}
