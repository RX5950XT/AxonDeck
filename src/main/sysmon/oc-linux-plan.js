'use strict'

/**
 * AxonDeck — Linux 效能調整：可調項（knob）定義、草稿夾值、套用計畫。純函式，不碰檔案。
 *
 * 草稿的值 `null`＝「不動，維持系統目前的值」。只有使用者動過的項目才會寫，
 * 所以按「套用」不會順手把沒碰過的東西改成某個預設值。
 *
 * 安全邊界：一律取 sysfs／驅動給的上下限（cpuinfo_min/max_freq、power1_cap_min/max、OD_RANGE、
 * constraint_N_max_power_uw、nvidia power.min/max_limit），再疊一層保守的絕對限制。
 */

const { topLevel } = require('./oc-linux-sysfs')

const AMD_PERF = [['auto', '自動（預設）'], ['high', '最高時脈'], ['low', '最低時脈（省電）']]
const TURBO_OPTIONS = [['on', '開'], ['off', '關']]
const OFFSET_ABS = { core: 500, mem: 1000 }
const VOLT_DEFAULT_RANGE = [-100, 0]
const RAPL_FLOOR_W = 5

const khzToMhz = (k) => Math.round(Number(k) / 1000)
const uwToW = (u) => Math.round(Number(u) / 1e6)

function clamp(n, lo, hi) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

/** RAPL 的 long_term／short_term 叫 PL1／PL2（Intel 文件與 BIOS 的叫法） */
function raplLabel(zone, c) {
  const kind = /long/i.test(c.name) ? 'PL1 長時間功耗牆' : /short/i.test(c.name) ? 'PL2 短時間功耗牆' : c.name
  return zone.name && zone.name !== 'package-0' ? `${zone.name} ${kind}` : kind
}

/**
 * CPU 的可調項。
 * @param {any} cpu scanCpu 的結果
 * @param {any} orig 這次開機第一次看到的原始值
 * @param {any} draft
 * @param {boolean} root
 */
function cpuKnobs(cpu, orig, draft, root) {
  const folds = []
  const p0 = cpu.policies[0]
  if (p0) {
    const minMhz = Math.min(...cpu.policies.map((p) => khzToMhz(p.minKhz)))
    const maxMhz = Math.max(...cpu.policies.map((p) => khzToMhz(p.maxKhz)))
    const knobs = [{
      key: 'maxFreqMhz', label: '時脈上限（所有核心）', kind: 'range', unit: ' MHz', step: 100,
      min: minMhz, max: maxMhz, current: khzToMhz(p0.scalingMaxKhz), writable: root || cpu.policies.every((p) => p.maxWritable)
    }]
    if (p0.governors.length) {
      knobs.push({
        key: 'governor', label: '調速器（governor）', kind: 'select', current: p0.governor,
        options: p0.governors.map((g) => [g, g]), writable: root || cpu.policies.every((p) => p.govWritable)
      })
    }
    if (p0.epps.length) {
      knobs.push({
        key: 'epp', label: '能源效能偏好（EPP）', kind: 'select', current: p0.epp,
        options: p0.epps.map((e) => [e, e]), writable: root || cpu.policies.every((p) => !p.eppFile || p.eppWritable)
      })
    }
    if (cpu.turbo) {
      knobs.push({
        key: 'turbo', label: cpu.turbo.kind === 'no_turbo' ? '加速（Turbo Boost）' : '加速（boost）', kind: 'select',
        current: cpu.turbo.on ? 'on' : 'off', options: TURBO_OPTIONS, writable: root || cpu.turbo.writable
      })
    }
    folds.push({ id: 'lx-cpu-clock', title: '時脈與加速', knobs })
  }
  const rapl = []
  for (const zone of cpu.rapl) {
    for (const c of zone.constraints) {
      const key = `rapl.${zone.zone}.${c.i}`
      const o = orig?.rapl?.[key] ?? c.uw
      const factoryW = Math.max(1, uwToW(o))
      const capW = c.maxUw && c.maxUw > 0 ? uwToW(c.maxUw) : Math.round(factoryW * 1.5)
      rapl.push({
        key, label: raplLabel(zone, c), kind: 'range', unit: ' W', step: 1,
        min: Math.max(RAPL_FLOOR_W, Math.round(factoryW * 0.5)), max: Math.max(RAPL_FLOOR_W + 1, Math.min(capW, Math.round(factoryW * 1.5))),
        current: uwToW(c.uw), factory: factoryW, writable: root || c.writable
      })
    }
  }
  if (rapl.length) folds.push({ id: 'lx-cpu-rapl', title: '功耗牆（RAPL）', knobs: rapl })
  return withValues(folds, draft)
}

/** 把草稿值填進 knob.value（沒草稿就顯示目前值） */
function withValues(folds, draft) {
  for (const fold of folds) {
    for (const k of fold.knobs) {
      const d = draft?.[k.key]
      k.value = d == null ? k.current : d
      k.changed = d != null
    }
  }
  return folds
}

/**
 * AMD 卡的可調項；OverDrive 沒開時只剩功耗牆與效能等級。
 * @param {any} gpu scanAmdGpus 的一張
 * @param {any} orig
 * @param {any} draft
 * @param {boolean} root
 */
function amdKnobs(gpu, orig, draft, root) {
  const folds = []
  const clock = []
  const power = gpu.power
  if (power) {
    const def = power.defUw || orig?.capUw || power.uw
    const lo = power.minUw ? Math.ceil(power.minUw / def * 100) : 50
    const hi = power.maxUw ? Math.floor(power.maxUw / def * 100) : 100
    clock.push({
      key: 'powerPct', label: `功耗上限（出廠 ${uwToW(def)} W）`, kind: 'range', unit: '%', step: 1,
      min: Math.max(10, lo), max: Math.max(Math.max(10, lo), hi), current: Math.round(power.uw / def * 100), writable: root || power.writable
    })
  }
  const odOk = gpu.od && gpu.odFile
  if (odOk) {
    const sclk = topLevel(gpu.od.sclk)
    const range = gpu.od.range
    const base = orig?.sclk ?? sclk?.mhz
    if (sclk && range.SCLK && base) {
      clock.push({
        key: 'coreMHz', label: `核心時脈上限偏移（出廠 ${base} MHz）`, kind: 'range', unit: ' MHz', step: 5, format: 'offset',
        min: Math.max(-OFFSET_ABS.core, range.SCLK[0] - base), max: Math.min(OFFSET_ABS.core, range.SCLK[1] - base),
        current: sclk.mhz - base, writable: root || gpu.odWritable
      })
    }
    const mclk = topLevel(gpu.od.mclk)
    const mbase = orig?.mclk ?? mclk?.mhz
    if (mclk && range.MCLK && mbase) {
      clock.push({
        key: 'memMHz', label: `記憶體時脈偏移（出廠 ${mbase} MHz）`, kind: 'range', unit: ' MHz', step: 5, format: 'offset',
        min: Math.max(-OFFSET_ABS.mem, range.MCLK[0] - mbase), max: Math.min(OFFSET_ABS.mem, range.MCLK[1] - mbase),
        current: mclk.mhz - mbase, writable: root || gpu.odWritable
      })
    }
  }
  if (clock.length) folds.push({ id: `lx-gpu-clock-${gpu.id}`, title: '時脈與功耗', knobs: clock })
  const volt = []
  if (odOk && gpu.od.vddgfxOffset !== null) {
    const r = gpu.od.range.VDDGFX_OFFSET || VOLT_DEFAULT_RANGE
    volt.push({
      key: 'voltMv', label: '核心電壓偏移（負值＝降壓）', kind: 'range', unit: ' mV', step: 5, format: 'offset',
      min: Math.max(-200, r[0]), max: Math.min(50, r[1]), current: gpu.od.vddgfxOffset, writable: root || gpu.odWritable
    })
  }
  volt.push({
    key: 'perfLevel', label: '效能等級（power_dpm_force_performance_level）', kind: 'select',
    current: gpu.perfLevel, options: AMD_PERF, writable: root || gpu.perfWritable
  })
  folds.push({ id: `lx-gpu-volt-${gpu.id}`, title: '電壓與效能等級', knobs: volt })
  return withValues(folds, draft)
}

/**
 * NVIDIA：只有牆與鎖頻（往下）。寫入走 pkexec，所以 writable 只看有沒有 nvidia-smi。
 * @param {any} gpu parseQuery 的一張
 * @param {any} orig
 * @param {any} draft
 */
function nvidiaKnobs(gpu, orig, draft) {
  const knobs = []
  const def = gpu.defPowerW
  if (def && gpu.minPowerW !== null && gpu.maxPowerW !== null) {
    knobs.push({
      key: 'powerPct', label: `功耗上限（出廠 ${Math.round(def)} W）`, kind: 'range', unit: '%', step: 1,
      min: Math.ceil(gpu.minPowerW / def * 100), max: Math.floor(gpu.maxPowerW / def * 100),
      current: Math.round((gpu.powerW ?? def) / def * 100), writable: true
    })
  }
  if (gpu.maxClock) {
    knobs.push({
      key: 'coreMHz', label: `核心時脈上限（出廠 ${gpu.maxClock} MHz，只能往下）`, kind: 'range', unit: ' MHz', step: 15, format: 'offset',
      min: -Math.min(OFFSET_ABS.core * 2, Math.max(0, gpu.maxClock - 300)), max: 0, current: orig?.coreMHz ?? 0, writable: true
    })
  }
  if (gpu.maxMemClock) {
    knobs.push({
      key: 'memMHz', label: `記憶體時脈上限（出廠 ${gpu.maxMemClock} MHz，只能往下）`, kind: 'range', unit: ' MHz', step: 50, format: 'offset',
      min: -Math.min(OFFSET_ABS.mem, Math.max(0, gpu.maxMemClock - 300)), max: 0, current: orig?.memMHz ?? 0, writable: true
    })
  }
  return withValues([{ id: `lx-gpu-clock-${gpu.id}`, title: '功耗與鎖頻', knobs }], draft)
}

/** 依 knob 定義夾一個草稿值；不認得的 key 回 undefined（呼叫端擋掉） */
function sanitizeKnobValue(knob, value) {
  if (!knob) return undefined
  if (value === null) return null
  if (knob.kind === 'range') return clamp(value, knob.min, knob.max)
  const text = String(value)
  return knob.options.some(([v]) => v === text) ? text : undefined
}

function findKnob(folds, key) {
  for (const fold of folds) {
    const hit = fold.knobs.find((k) => k.key === key)
    if (hit) return hit
  }
  return null
}

/**
 * 哪些變更算「有風險」要二次確認：拉高功耗牆、正的時脈偏移、任何電壓偏移。
 * 往下調（降頻、降牆、關加速）都不算。
 * @param {Array<{ device: string, folds: any[] }>} targets
 */
function riskyChanges(targets) {
  const out = []
  for (const t of targets) {
    for (const fold of t.folds) {
      for (const k of fold.knobs) {
        if (!k.changed) continue
        const v = Number(k.value)
        if (k.key === 'powerPct' && v > 100) out.push(`${t.device}：功耗上限 ${v}%（高於出廠）`)
        else if ((k.key === 'coreMHz' || k.key === 'memMHz') && v > 0) out.push(`${t.device}：${k.key === 'coreMHz' ? '核心' : '記憶體'}時脈 +${v} MHz`)
        else if (k.key === 'voltMv' && v !== 0) out.push(`${t.device}：核心電壓 ${v > 0 ? '+' : ''}${v} mV`)
        else if (k.key.startsWith('rapl.') && v > k.factory) out.push(`${t.device}：${k.label} ${v} W（出廠 ${k.factory} W）`)
      }
    }
  }
  return out
}

module.exports = {
  AMD_PERF,
  cpuKnobs,
  amdKnobs,
  nvidiaKnobs,
  sanitizeKnobValue,
  findKnob,
  riskyChanges,
  khzToMhz,
  uwToW,
  clamp
}
