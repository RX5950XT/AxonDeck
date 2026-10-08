'use strict'

/**
 * AxonDeck — Linux 效能調整：sysfs 探測與解析（只讀，不寫）。
 *
 * AMD 顯示卡（amdgpu）：
 *   device/pp_od_clk_voltage           OD_SCLK／OD_MCLK／OD_VDDGFX_OFFSET＋OD_RANGE；寫 `s 1 <MHz>`／`m 1 <MHz>`／`vo <mV>` 再 `c` 提交、`r` 回出廠
 *   device/power_dpm_force_performance_level  auto／low／high／manual／profile_*
 *   device/hwmon/hwmonN/power1_cap(_min／_max／_default)  微瓦
 *   /sys/module/amdgpu/parameters/ppfeaturemask  第 14 位（0x4000）＝overdrive；沒開 pp_od_clk_voltage 根本不存在或寫不進去
 * CPU：
 *   cpufreq/policyN/{scaling_max_freq, cpuinfo_min_freq, cpuinfo_max_freq, scaling_governor, scaling_available_governors,
 *                    energy_performance_preference, energy_performance_available_preferences}（kHz）
 *   intel_pstate/no_turbo（1＝關加速）、cpufreq/boost（1＝開加速；acpi-cpufreq／amd-pstate）
 *   /sys/class/powercap/intel-rapl:N/constraint_M_{name, power_limit_uw, max_power_uw}
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const PP_OVERDRIVE_MASK = 0x4000
const PERF_LEVELS = ['auto', 'low', 'high', 'manual', 'profile_standard', 'profile_min_sclk', 'profile_min_mclk', 'profile_peak']

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

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function canWrite(file) {
  try {
    await fsp.access(file, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function naturalCmp(a, b) {
  return a.localeCompare(b, 'en', { numeric: true })
}

/**
 * pp_od_clk_voltage 的文字。各代格式不同，只認我們會寫的那幾段：
 *   OD_SCLK: / OD_MCLK:  `0: 500Mhz`
 *   OD_VDDGFX_OFFSET:    `0mV`
 *   OD_RANGE:            `SCLK:     500Mhz       3000Mhz`、`VDDGFX_OFFSET: -200mv 0mv`
 * @param {string} text
 */
function parseOdTable(text) {
  const out = { sclk: [], mclk: [], vddgfxOffset: null, range: {} }
  let section = ''
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const head = /^(OD_[A-Z_]+):\s*(.*)$/.exec(line)
    if (head) {
      section = head[1]
      if (section === 'OD_VDDGFX_OFFSET' && head[2]) {
        const mv = /^(-?\d+)\s*mv$/i.exec(head[2])
        if (mv) out.vddgfxOffset = Number(mv[1])
      }
      continue
    }
    if (section === 'OD_SCLK' || section === 'OD_MCLK') {
      const m = /^(\d+):\s*(\d+)\s*mhz/i.exec(line)
      if (m) out[section === 'OD_SCLK' ? 'sclk' : 'mclk'].push({ i: Number(m[1]), mhz: Number(m[2]) })
    } else if (section === 'OD_VDDGFX_OFFSET') {
      const mv = /^(-?\d+)\s*mv$/i.exec(line)
      if (mv) out.vddgfxOffset = Number(mv[1])
    } else if (section === 'OD_RANGE') {
      const m = /^([A-Z_]+):\s*(-?\d+)\s*(?:mhz|mv)\s+(-?\d+)\s*(?:mhz|mv)$/i.exec(line)
      if (m) out.range[m[1].toUpperCase()] = [Number(m[2]), Number(m[3])]
    }
  }
  return out
}

/** 最高那一級（`s 1`／`m 1` 寫的就是它） */
function topLevel(levels) {
  if (!levels.length) return null
  return levels.reduce((a, b) => (b.i > a.i ? b : a))
}

async function readPpFeatureMask(sysfsRoot) {
  const text = await readText(path.join(sysfsRoot, 'module', 'amdgpu', 'parameters', 'ppfeaturemask'))
  if (text === null) return null
  const n = text.startsWith('0x') ? parseInt(text, 16) : Number(text)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {string} sysfsRoot
 * @returns {Promise<Array<any>>}
 */
async function scanAmdGpus(sysfsRoot) {
  const drm = path.join(sysfsRoot, 'class', 'drm')
  const mask = await readPpFeatureMask(sysfsRoot)
  const cards = (await listDir(drm)).filter((n) => /^card\d+$/.test(n)).sort(naturalCmp)
  const out = []
  const seen = new Set()
  for (const card of cards) {
    const dev = path.join(drm, card, 'device')
    const vendor = await readText(path.join(dev, 'vendor'))
    if (vendor !== '0x1002') continue
    const perfFile = path.join(dev, 'power_dpm_force_performance_level')
    if (!(await exists(perfFile))) continue
    let real = dev
    try { real = await fsp.realpath(dev) } catch { /* 假 sysfs 可能不是連結 */ }
    if (seen.has(real)) continue
    seen.add(real)
    const pci = path.basename(real)
    const hwmonName = (await listDir(path.join(dev, 'hwmon'))).sort(naturalCmp)[0]
    const hwmon = hwmonName ? path.join(dev, 'hwmon', hwmonName) : null
    const odFile = path.join(dev, 'pp_od_clk_voltage')
    const odText = await readText(odFile)
    const od = odText === null ? null : parseOdTable(odText)
    const capFile = hwmon ? path.join(hwmon, 'power1_cap') : null
    const cap = capFile ? await readNum(capFile) : null
    const productName = await readText(path.join(dev, 'product_name'))
    out.push({
      kind: 'amd',
      id: `amd:${pci}`,
      pci,
      name: productName || `AMD Radeon（${pci}）`,
      dev,
      hwmon,
      perfFile,
      perfLevel: await readText(perfFile),
      odFile: od ? odFile : null,
      od,
      odWritable: od ? await canWrite(odFile) : false,
      perfWritable: await canWrite(perfFile),
      odMaskOn: mask === null ? null : (mask & PP_OVERDRIVE_MASK) !== 0,
      ppfeaturemask: mask,
      power: cap === null ? null : {
        file: capFile,
        uw: cap,
        minUw: await readNum(path.join(hwmon, 'power1_cap_min')),
        maxUw: await readNum(path.join(hwmon, 'power1_cap_max')),
        defUw: await readNum(path.join(hwmon, 'power1_cap_default')),
        writable: await canWrite(capFile)
      },
      live: hwmon ? {
        temp: await readNum(path.join(hwmon, 'temp1_input')),
        hotspot: await readNum(path.join(hwmon, 'temp2_input')),
        clock: await readNum(path.join(hwmon, 'freq1_input')),
        powerUw: (await readNum(path.join(hwmon, 'power1_average'))) ?? (await readNum(path.join(hwmon, 'power1_input'))),
        load: await readNum(path.join(dev, 'gpu_busy_percent'))
      } : {}
    })
  }
  return out
}

async function scanPolicy(dir) {
  const read = (name) => readText(path.join(dir, name))
  const num = (name) => readNum(path.join(dir, name))
  const list = async (name) => ((await read(name)) || '').split(/\s+/).filter(Boolean)
  const maxFile = path.join(dir, 'scaling_max_freq')
  const govFile = path.join(dir, 'scaling_governor')
  const eppFile = path.join(dir, 'energy_performance_preference')
  const epp = await read('energy_performance_preference')
  return {
    dir,
    name: path.basename(dir),
    minKhz: await num('cpuinfo_min_freq'),
    maxKhz: await num('cpuinfo_max_freq'),
    scalingMaxKhz: await num('scaling_max_freq'),
    governor: await read('scaling_governor'),
    governors: await list('scaling_available_governors'),
    epp,
    epps: epp === null ? [] : await list('energy_performance_available_preferences'),
    maxFile,
    govFile,
    eppFile: epp === null ? null : eppFile,
    maxWritable: await canWrite(maxFile),
    govWritable: await canWrite(govFile),
    eppWritable: epp === null ? false : await canWrite(eppFile)
  }
}

async function scanRapl(sysfsRoot) {
  const base = path.join(sysfsRoot, 'class', 'powercap')
  const zones = (await listDir(base)).filter((n) => /^intel-rapl:\d+$/.test(n)).sort(naturalCmp)
  const out = []
  for (const zone of zones) {
    const dir = path.join(base, zone)
    const zoneName = await readText(path.join(dir, 'name'))
    const constraints = []
    for (let i = 0; i < 4; i += 1) {
      const file = path.join(dir, `constraint_${i}_power_limit_uw`)
      const uw = await readNum(file)
      if (uw === null) continue
      constraints.push({
        i,
        file,
        name: (await readText(path.join(dir, `constraint_${i}_name`))) || `constraint_${i}`,
        uw,
        maxUw: await readNum(path.join(dir, `constraint_${i}_max_power_uw`)),
        writable: await canWrite(file)
      })
    }
    if (constraints.length) out.push({ zone, name: zoneName || zone, dir, constraints })
  }
  return out
}

/**
 * @param {string} sysfsRoot
 */
async function scanCpu(sysfsRoot) {
  const cpufreq = path.join(sysfsRoot, 'devices', 'system', 'cpu', 'cpufreq')
  const names = (await listDir(cpufreq)).filter((n) => /^policy\d+$/.test(n)).sort(naturalCmp)
  const policies = []
  for (const name of names) policies.push(await scanPolicy(path.join(cpufreq, name)))
  const noTurboFile = path.join(sysfsRoot, 'devices', 'system', 'cpu', 'intel_pstate', 'no_turbo')
  const boostFile = path.join(cpufreq, 'boost')
  const noTurbo = await readNum(noTurboFile)
  const boost = await readNum(boostFile)
  return {
    driver: policies.length ? await readText(path.join(policies[0].dir, 'scaling_driver')) : null,
    policies: policies.filter((p) => p.maxKhz !== null),
    turbo: noTurbo !== null
      ? { kind: 'no_turbo', file: noTurboFile, on: noTurbo === 0, raw: noTurbo, writable: await canWrite(noTurboFile) }
      : boost !== null
        ? { kind: 'boost', file: boostFile, on: boost === 1, raw: boost, writable: await canWrite(boostFile) }
        : null,
    rapl: await scanRapl(sysfsRoot)
  }
}

async function readBootId(procRoot) {
  return (await readText(path.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'))) || ''
}

module.exports = {
  PP_OVERDRIVE_MASK,
  PERF_LEVELS,
  parseOdTable,
  topLevel,
  scanAmdGpus,
  scanCpu,
  readPpFeatureMask,
  readBootId,
  readText,
  readNum,
  canWrite
}
