'use strict'

/**
 * AxonDeck — Linux 效能調整引擎。對外介面跟 Windows 的 oc.js 一樣（configure／status／setDraft／apply／reset／shutdown），
 * 多一個 authorize（一次性 pkexec 安裝 udev 規則）。Windows 不載入這支。
 *
 * 能調什麼（全部是核心／驅動公開的介面，不碰暫存器）：
 *   CPU：cpufreq 時脈上限／governor／EPP、加速開關（intel_pstate no_turbo 或 cpufreq boost）、RAPL PL1／PL2
 *   AMD：power1_cap、pp_od_clk_voltage（核心／記憶體上限、電壓偏移；要 ppfeaturemask 開 OverDrive）、效能等級
 *   NVIDIA：nvidia-smi -pl／-lgc／-lmc（解除用 -rgc／-rmc）
 *
 * 安全網（比照 Windows）：
 *   - 只寫使用者動過的項目；值一律夾在 sysfs／驅動給的上下限
 *   - 拉高功耗牆、正的時脈偏移、電壓偏移 → 先回 SYSMON_OC_CONFIRM，畫面二次確認後才寫
 *   - 每個檔案第一次寫之前記原始值（連同 boot_id 存起來，App 重開也還原得回去）；「還原」寫回原始值
 *   - 套用期間每秒看溫度，過熱或全部讀不到就還原；App 結束時還原
 *   - 不開機自動套用
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { execFile } = require('child_process')
const scan = require('./oc-linux-sysfs')
const nv = require('./oc-linux-nvidia')
const plan = require('./oc-linux-plan')
const { createOcAccess } = require('./oc-access-linux')
const { parseLive, isPanic, DEFAULT_PANIC_TEMP } = require('./oc')

const TICK_MS = 1000
const SCAN_MS = 2000
const NV_QUERY_MS = 5000
const STORE_KEY = 'ocControlLinux'

function ocError(code, userMessage, extra = {}) {
  const err = new Error(code)
  err.code = code
  err.userMessage = userMessage
  Object.assign(err, extra)
  return err
}

function hex(n) {
  return n === null || n === undefined ? '未知' : `0x${Number(n).toString(16)}`
}

function amdReason(gpu) {
  if (gpu.od && gpu.odFile) return ''
  const mask = gpu.ppfeaturemask
  return `OverDrive（時脈／電壓調整）沒開：目前 ppfeaturemask＝${hex(mask)}。開機參數加上 amdgpu.ppfeaturemask=${hex(((mask ?? 0xfff7bfff) | scan.PP_OVERDRIVE_MASK) >>> 0)} 後重開機才會出現 pp_od_clk_voltage；功耗上限與效能等級不受影響。`
}

/**
 * @param {{
 *   sensors: any, store?: any, sysfsRoot?: string, procRoot?: string, access?: any,
 *   smiPath?: string, execFileFn?: Function, readGpuCards?: () => any[], now?: () => number, tickMs?: number
 * }} deps
 */
function createLinuxOcEngine(deps = {}) {
  const sensors = deps.sensors
  const sysfsRoot = deps.sysfsRoot || '/sys'
  const procRoot = deps.procRoot || '/proc'
  const now = deps.now || Date.now
  const access = deps.access || createOcAccess({ spawnFn: deps.spawnFn })
  const smiPath = deps.smiPath ?? nv.findSmi()
  const execFileFn = deps.execFileFn || execFile
  const tickMs = deps.tickMs || TICK_MS
  let store = deps.store || null

  let devices = { cpu: { policies: [], turbo: null, rapl: [] }, amd: [], nvidia: [] }
  let scannedAt = 0
  let nvAt = 0
  let bootId = ''
  /** 草稿：{ cpu: { key: value|null }, gpus: { [id]: { key: value|null } } } */
  let config = { dirty: false, panicTemp: DEFAULT_PANIC_TEMP, cpu: {}, gpus: {} }
  /** 這次開機第一次看到的原始值（還原目標）＋ NVIDIA 目前套用的鎖頻 */
  let orig = { bootId: '', cpu: {}, gpus: {}, nvApplied: {} }
  let loaded = false
  let dirtyLastRun = false
  let applied = false
  let panic = false
  let lastError = ''
  let timer = null

  function persist() {
    if (!store) return
    try { store.set(STORE_KEY, { config, orig }) } catch { /* 存不進去不該讓還原失敗 */ }
  }

  async function load() {
    if (loaded) return
    loaded = true
    bootId = await scan.readBootId(procRoot)
    let raw = null
    let stale = false
    try { raw = store?.get?.(STORE_KEY) } catch { raw = null }
    if (raw && typeof raw === 'object') {
      if (raw.config && typeof raw.config === 'object') {
        config = {
          dirty: raw.config.dirty === true,
          panicTemp: plan.clamp(raw.config.panicTemp ?? DEFAULT_PANIC_TEMP, 70, 105),
          cpu: raw.config.cpu && typeof raw.config.cpu === 'object' ? raw.config.cpu : {},
          gpus: raw.config.gpus && typeof raw.config.gpus === 'object' ? raw.config.gpus : {}
        }
      }
      // 不同次開機：sysfs 的設定都回出廠了，舊的原始值沒有意義
      if (raw.orig && raw.orig.bootId === bootId && bootId) orig = raw.orig
      else {
        config.dirty = false
        stale = true
      }
    }
    orig.cpu = orig.cpu || {}
    orig.gpus = orig.gpus || {}
    orig.nvApplied = orig.nvApplied || {}
    dirtyLastRun = config.dirty && orig.bootId === bootId
    orig.bootId = bootId
    if (stale) persist()
  }

  /** 第一次看到某個值就記下來（之後的偏移都相對它、還原也寫回它） */
  function remember(bucket, key, value) {
    if (value === null || value === undefined) return
    if (!Object.hasOwn(bucket, key)) bucket[key] = value
  }

  function rememberAll() {
    const c = orig.cpu
    for (const p of devices.cpu.policies) {
      remember(c, `${p.name}.max`, p.scalingMaxKhz)
      remember(c, `${p.name}.gov`, p.governor)
      if (p.eppFile) remember(c, `${p.name}.epp`, p.epp)
    }
    if (devices.cpu.turbo) remember(c, 'turbo', devices.cpu.turbo.raw)
    c.rapl = c.rapl || {}
    for (const zone of devices.cpu.rapl) {
      for (const k of zone.constraints) remember(c.rapl, `rapl.${zone.zone}.${k.i}`, k.uw)
    }
    for (const g of devices.amd) {
      const o = orig.gpus[g.id] = orig.gpus[g.id] || {}
      remember(o, 'perf', g.perfLevel)
      if (g.power) remember(o, 'capUw', g.power.uw)
      if (g.od) {
        remember(o, 'sclk', scan.topLevel(g.od.sclk)?.mhz)
        remember(o, 'sclkI', scan.topLevel(g.od.sclk)?.i)
        remember(o, 'mclk', scan.topLevel(g.od.mclk)?.mhz)
        remember(o, 'mclkI', scan.topLevel(g.od.mclk)?.i)
        remember(o, 'vo', g.od.vddgfxOffset)
      }
    }
    for (const g of devices.nvidia) {
      const o = orig.gpus[g.id] = orig.gpus[g.id] || {}
      remember(o, 'powerW', g.powerW)
    }
  }

  async function refresh(force) {
    await load()
    if (!force && now() - scannedAt < SCAN_MS) return
    const [cpu, amd] = await Promise.all([scan.scanCpu(sysfsRoot), scan.scanAmdGpus(sysfsRoot)])
    devices.cpu = cpu
    devices.amd = amd
    if (force || now() - nvAt >= NV_QUERY_MS) {
      devices.nvidia = await nv.queryGpus({ smiPath, execFileFn })
      nvAt = now()
    }
    scannedAt = now()
    // 還沒套用過才記原始值：套用中的值不是「原始」
    if (!applied && !config.dirty) rememberAll()
    else rememberMissingOnly()
  }

  /** 套用中新出現的裝置（熱插拔）一樣要有原始值 */
  function rememberMissingOnly() {
    for (const g of [...devices.amd, ...devices.nvidia]) {
      if (!orig.gpus[g.id]) rememberAll()
    }
  }

  function targets() {
    const root = access.isRoot()
    const out = []
    const cpuName = sensors?.read?.()?.oc?.c?.n || '處理器'
    out.push({ id: 'cpu', device: cpuName, folds: plan.cpuKnobs(devices.cpu, orig.cpu, config.cpu, root) })
    for (const g of devices.amd) {
      out.push({ id: g.id, gpu: g, device: g.name, folds: plan.amdKnobs(g, orig.gpus[g.id], config.gpus[g.id], root), reason: amdReason(g) })
    }
    for (const g of devices.nvidia) {
      const applied = orig.nvApplied?.[g.id] || {}
      out.push({ id: g.id, gpu: g, device: g.name, folds: plan.nvidiaKnobs(g, applied, config.gpus[g.id]) })
    }
    return out
  }

  function authInfo(ts) {
    const root = access.isRoot()
    const sysfsKnobs = ts.filter((t) => t.id === 'cpu' || t.gpu?.kind === 'amd').flatMap((t) => t.folds.flatMap((f) => f.knobs))
    const locked = sysfsKnobs.filter((k) => !k.writable).length
    const installed = access.installed()
    return {
      root,
      installed,
      hasPkexec: access.hasPkexec(),
      locked,
      canInstall: !root && locked > 0 && access.hasPkexec(),
      label: '授權效能調整（pkexec）',
      hint: root ? '' : locked
        ? (installed
          ? `已安裝授權規則，但仍有 ${locked} 項寫不進去（可能要重新登入讓群組生效，或驅動不允許）。`
          : `有 ${locked} 項需要一次系統授權才能寫入（安裝 udev 規則，只放寬效能調整用的那幾個 sysfs 檔案）。讀取不需要授權。`)
        : ''
    }
  }

  function liveRaw(ts) {
    const bridge = sensors?.read?.()?.oc?.c || {}
    const cards = typeof deps.readGpuCards === 'function' ? deps.readGpuCards() || [] : []
    const cpuT = ts[0]
    const cpuKnobs = cpuT.folds.flatMap((f) => f.knobs)
    const gs = ts.slice(1).map((t, i) => {
      const g = t.gpu
      const knobs = t.folds.flatMap((f) => f.knobs)
      const power = knobs.find((k) => k.key === 'powerPct')
      if (g.kind === 'amd') {
        const l = g.live || {}
        return {
          i, w: knobs.length ? 1 : 0, n: g.name, r: t.reason,
          t: l.temp == null ? null : l.temp / 1000, h: l.hotspot == null ? null : l.hotspot / 1000,
          k: l.clock == null ? null : Math.round(l.clock / 1e6), u: l.load, pd: l.powerUw == null ? null : Math.round(l.powerUw / 1e6),
          pw: power ? power.current : null
        }
      }
      const card = cards.find((c) => Number(c.index) === g.index) || {}
      return {
        i, w: knobs.length ? 1 : 0, n: g.name, r: '',
        // 常駐的 nvidia-smi 取樣（每秒）比我們 5 秒一次的查詢新，優先用它
        t: card.temperature ?? g.live.temp ?? null, k: card.clockSm ?? g.live.clock ?? null,
        u: card.utilization ?? g.live.load ?? null, pd: card.power ?? g.live.powerW ?? null, pw: power ? power.current : null
      }
    })
    return {
      c: { ...bridge, w: cpuKnobs.length ? 1 : 0, r: cpuKnobs.length ? '' : '這台機器沒有公開 cpufreq／RAPL 可調介面（虛擬機與容器常見）。' },
      g: gs[0] || { i: 0, w: 0, n: '', r: '' },
      gs
    }
  }

  function linuxView(ts) {
    return {
      cpu: { name: ts[0].device, folds: ts[0].folds, reason: ts[0].folds.length ? '' : '這台機器沒有公開 cpufreq／RAPL 可調介面（虛擬機與容器常見）。' },
      gpus: ts.slice(1).map((t) => ({
        id: t.id, kind: t.gpu.kind, name: t.device, folds: t.folds, reason: t.reason || '',
        note: t.gpu.kind === 'nvidia' ? 'NVIDIA 在 Linux 只能調功耗牆與鎖頻上限（沒有時脈偏移／電壓）；每次套用與還原會跳一次系統密碼視窗。' : ''
      }))
    }
  }

  async function snapshot() {
    await refresh(false)
    const ts = targets()
    const data = sensors?.read?.() || {}
    return {
      platform: 'linux',
      available: data.available === true,
      applied,
      panic,
      dirtyLastRun,
      panicTemp: config.panicTemp,
      lastError,
      limits: {},
      draft: { cpu: config.cpu, gpus: config.gpus },
      live: parseLive(liveRaw(ts)),
      linux: { ...linuxView(ts), auth: authInfo(ts) }
    }
  }

  /** sysfs 寫入；測試注入假核心（pp_od_clk_voltage 要逐行解讀，普通檔案模擬不出來） */
  const writeAsync = deps.writeFile || ((file, text) => fsp.writeFile(file, text))
  const writeSync = deps.writeFileSync || ((file, text) => fs.writeFileSync(file, text))

  async function writeFile(file, value) {
    await writeAsync(file, String(value))
  }

  /** 計畫：[{ label, run: async () => void }]；只收使用者動過的項目 */
  function buildSteps(ts) {
    const steps = []
    const nvOps = []
    const nvNext = {}
    for (const t of ts) {
      const changed = Object.fromEntries(t.folds.flatMap((f) => f.knobs).filter((k) => k.changed).map((k) => [k.key, k]))
      if (t.id === 'cpu') cpuSteps(changed, steps)
      else if (t.gpu.kind === 'amd') amdSteps(t.gpu, changed, steps)
      else nvidiaOps(t.gpu, changed, nvOps, nvNext)
    }
    return { steps, nvOps, nvNext }
  }

  function cpuSteps(changed, steps) {
    const pol = devices.cpu.policies
    if (changed.governor) {
      for (const p of pol) steps.push({ label: '調速器', run: () => writeFile(p.govFile, changed.governor.value) })
    }
    if (changed.epp) {
      for (const p of pol) if (p.eppFile) steps.push({ label: 'EPP', run: () => writeFile(p.eppFile, changed.epp.value) })
    }
    if (changed.turbo && devices.cpu.turbo) {
      const on = changed.turbo.value === 'on'
      const t = devices.cpu.turbo
      steps.push({ label: '加速', run: () => writeFile(t.file, t.kind === 'no_turbo' ? (on ? 0 : 1) : (on ? 1 : 0)) })
    }
    if (changed.maxFreqMhz) {
      for (const p of pol) {
        const khz = Math.min(p.maxKhz, Math.max(p.minKhz, Number(changed.maxFreqMhz.value) * 1000))
        steps.push({ label: '時脈上限', run: () => writeFile(p.maxFile, khz) })
      }
    }
    for (const zone of devices.cpu.rapl) {
      for (const c of zone.constraints) {
        const k = changed[`rapl.${zone.zone}.${c.i}`]
        if (k) steps.push({ label: k.label, run: () => writeFile(c.file, Number(k.value) * 1e6) })
      }
    }
  }

  function amdSteps(g, changed, steps) {
    const o = orig.gpus[g.id] || {}
    if (changed.perfLevel) steps.push({ label: '效能等級', run: () => writeFile(g.perfFile, changed.perfLevel.value) })
    if (changed.powerPct && g.power) {
      const def = g.power.defUw || o.capUw || g.power.uw
      const lo = g.power.minUw || 0
      const hi = g.power.maxUw || def
      const uw = Math.min(hi, Math.max(lo, Math.round(def * Number(changed.powerPct.value) / 100)))
      steps.push({ label: '功耗上限', run: () => writeFile(g.power.file, uw) })
    }
    const od = []
    if (changed.coreMHz && o.sclk) od.push(`s ${o.sclkI ?? 1} ${o.sclk + Number(changed.coreMHz.value)}`)
    if (changed.memMHz && o.mclk) od.push(`m ${o.mclkI ?? 1} ${o.mclk + Number(changed.memMHz.value)}`)
    if (changed.voltMv && g.od?.vddgfxOffset !== null) od.push(`vo ${Number(changed.voltMv.value)}`)
    if (od.length && g.odFile) {
      steps.push({
        label: 'OverDrive',
        run: async () => {
          for (const line of od) await writeFile(g.odFile, line)
          await writeFile(g.odFile, 'c')
        }
      })
    }
  }

  function nvidiaOps(g, changed, ops, next) {
    if (!Object.keys(changed).length) return
    const applied = orig.nvApplied[g.id] || {}
    const draft = {
      powerPct: changed.powerPct ? Number(changed.powerPct.value) : Math.round((g.powerW ?? g.defPowerW) / g.defPowerW * 100),
      coreMHz: changed.coreMHz ? Number(changed.coreMHz.value) : applied.coreMHz || 0,
      memMHz: changed.memMHz ? Number(changed.memMHz.value) : applied.memMHz || 0
    }
    for (const op of nv.buildOps(g, draft)) {
      if (op[1] === '-pl' && !changed.powerPct) continue
      if ((op[1] === '-lgc' || op[1] === '-rgc') && !changed.coreMHz) continue
      if ((op[1] === '-lmc' || op[1] === '-rmc') && !changed.memMHz) continue
      ops.push(op)
    }
    next[g.id] = { coreMHz: draft.coreMHz, memMHz: draft.memMHz }
  }

  function execRoot(file, args) {
    return new Promise((resolve, reject) => {
      execFileFn(file, args, { timeout: 15000 }, (err) => (err ? reject(ocError('SYSMON_OC_NVIDIA', 'nvidia-smi 回報失敗。')) : resolve()))
    })
  }

  async function runSteps(steps) {
    const failed = []
    for (const step of steps) {
      try {
        await step.run()
      } catch (err) {
        failed.push(`${step.label}（${err?.code === 'EACCES' || err?.code === 'EPERM' ? '沒有寫入權限' : err?.code === 'EINVAL' ? '驅動不接受這個值' : '寫入失敗'}）`)
      }
    }
    return failed
  }

  /** 還原步驟：寫回原始值（非同步版，逐檔寫；順序見 restoreWrites） */
  function restoreSteps() {
    return restoreWrites().map((w) => ({ label: w.label, run: () => writeFile(w.file, w.value) }))
  }

  function nvidiaRestoreOps() {
    const ops = []
    for (const g of devices.nvidia) {
      const a = orig.nvApplied[g.id]
      const o = orig.gpus[g.id] || {}
      const powerChanged = o.powerW != null && g.powerW != null && Math.round(o.powerW) !== Math.round(g.powerW)
      if (!a && !powerChanged) continue
      ops.push(...nv.restoreOps(g, o.powerW ?? null))
    }
    return ops
  }

  async function panicTick() {
    if (!applied) return
    await refresh(false)
    const live = parseLive(liveRaw(targets()))
    if (!isPanic(live.cpu.temp, live.gpus.map((g) => g.temp), config.panicTemp)) {
      panic = false
      return
    }
    panic = true
    const failed = await runSteps(restoreSteps())
    applied = false
    stopTimer()
    const nvPending = nvidiaRestoreOps().length > 0
    lastError = '過熱或讀不到溫度，已還原原始值'
      + (failed.length ? `；${failed.join('、')} 沒還原成功` : '')
      + (nvPending ? '；NVIDIA 設定還原需要授權，請按「還原原始值」' : '')
    if (!failed.length && !nvPending) clearDirty()
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => { panicTick().catch(() => undefined) }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function clearDirty() {
    config.dirty = false
    persist()
  }

  return {
    configure(options = {}) {
      if (options.store) store = options.store
    },

    status: () => snapshot(),

    /**
     * 只改草稿。patch：{ linux: { target: 'cpu'|'<gpu id>', key, value } } 或 { panicTemp }。
     * @param {any} patch
     */
    async setDraft(patch) {
      await refresh(false)
      const src = patch && typeof patch === 'object' ? patch : {}
      if (src.panicTemp != null) config.panicTemp = plan.clamp(src.panicTemp, 70, 105)
      const lx = src.linux && typeof src.linux === 'object' ? src.linux : null
      if (lx) {
        const target = targets().find((t) => t.id === String(lx.target))
        const knob = target && plan.findKnob(target.folds, String(lx.key))
        const value = plan.sanitizeKnobValue(knob, lx.value)
        if (value === undefined) throw ocError('SYSMON_OC_BAD_KNOB', '這個項目不能調。')
        const bucket = target.id === 'cpu' ? config.cpu : (config.gpus[target.id] = config.gpus[target.id] || {})
        // 調回目前值＝不動
        if (value === null || value === knob.current) delete bucket[knob.key]
        else bucket[knob.key] = value
        if (target.id !== 'cpu' && !Object.keys(bucket).length) delete config.gpus[target.id]
      }
      persist()
      return snapshot()
    },

    /** @param {{ confirmed?: boolean }} [opts] */
    async apply(opts = {}) {
      await refresh(true)
      lastError = ''
      panic = false
      const ts = targets()
      const { steps, nvOps, nvNext } = buildSteps(ts)
      if (!steps.length && !nvOps.length) throw ocError('SYSMON_OC_NOTHING', '沒有變更：先調整滑桿再套用。')
      const risks = plan.riskyChanges(ts)
      if (risks.length && opts.confirmed !== true) {
        throw ocError('SYSMON_OC_CONFIRM', `下列變更可能讓系統不穩或過熱：${risks.join('；')}。過熱（${config.panicTemp} °C）或讀不到溫度會自動還原。確定套用？`, { risks })
      }
      const live = parseLive(liveRaw(ts))
      if (isPanic(live.cpu.temp, live.gpus.map((g) => g.temp), config.panicTemp)) {
        throw ocError('SYSMON_OC_NO_TEMP', '讀不到任何溫度（或已經過熱），沒有過熱保護就不套用。')
      }
      config.dirty = true
      persist()
      const failed = await runSteps(steps)
      if (nvOps.length) {
        try {
          await access.runNvidia(smiPath, nvOps, execRoot)
          Object.assign(orig.nvApplied, nvNext)
        } catch (err) {
          failed.push(`NVIDIA（${err?.userMessage || '失敗'}）`)
        }
      }
      persist()
      const total = steps.length + (nvOps.length ? 1 : 0)
      if (failed.length === total) {
        clearDirty()
        throw ocError('SYSMON_OC_WRITE', `沒有任何設定寫進去：${failed.join('、')}。`)
      }
      if (failed.length) lastError = `部分沒套用：${failed.join('、')}`
      applied = true
      startTimer()
      await refresh(true)
      return snapshot()
    },

    async reset() {
      await refresh(true)
      lastError = ''
      panic = false
      dirtyLastRun = false
      stopTimer()
      applied = false
      const failed = await runSteps(restoreSteps())
      const ops = nvidiaRestoreOps()
      if (ops.length) {
        try {
          await access.runNvidia(smiPath, ops, execRoot)
          orig.nvApplied = {}
        } catch (err) {
          failed.push(`NVIDIA（${err?.userMessage || '失敗'}）`)
        }
      }
      config.cpu = {}
      config.gpus = {}
      if (failed.length) lastError = `沒還原成功：${failed.join('、')}`
      else config.dirty = false
      persist()
      await refresh(true)
      return snapshot()
    },

    /** 一次性授權：pkexec 安裝 udev 規則 */
    async authorize() {
      const result = await access.install()
      await refresh(true)
      return { ...result, status: await snapshot() }
    },

    /** App 結束：sysfs 同步寫回（NVIDIA 要授權，不在這裡跳視窗；重開機即回出廠） */
    shutdown() {
      stopTimer()
      if (!applied && !config.dirty) return
      let ok = true
      for (const step of restoreWrites()) {
        try { writeSync(step.file, String(step.value)) } catch { ok = false }
      }
      applied = false
      if (ok && !nvidiaRestoreOps().length) config.dirty = false
      persist()
    },

    _devices: () => devices,
    _orig: () => orig,
    _tick: () => panicTick()
  }

  /**
   * 還原要寫的檔案與值。CPU 先 governor 再上限；AMD OD 逐行寫回原本最高級再 `c` 提交。
   * shutdown 用同步寫、reset／過熱用非同步寫，共用這一份。
   */
  function restoreWrites() {
    const out = []
    const c = orig.cpu
    for (const p of devices.cpu.policies) {
      if (c[`${p.name}.gov`] && c[`${p.name}.gov`] !== p.governor) out.push({ label: '調速器', file: p.govFile, value: c[`${p.name}.gov`] })
      if (p.eppFile && c[`${p.name}.epp`] && c[`${p.name}.epp`] !== p.epp) out.push({ label: 'EPP', file: p.eppFile, value: c[`${p.name}.epp`] })
      if (c[`${p.name}.max`] && c[`${p.name}.max`] !== p.scalingMaxKhz) out.push({ label: '時脈上限', file: p.maxFile, value: c[`${p.name}.max`] })
    }
    const t = devices.cpu.turbo
    if (t && c.turbo !== undefined && c.turbo !== t.raw) out.push({ label: '加速', file: t.file, value: c.turbo })
    for (const zone of devices.cpu.rapl) {
      for (const k of zone.constraints) {
        const v = c.rapl?.[`rapl.${zone.zone}.${k.i}`]
        if (v !== undefined && v !== k.uw) out.push({ label: 'RAPL', file: k.file, value: v })
      }
    }
    for (const g of devices.amd) {
      const o = orig.gpus[g.id] || {}
      if (o.perf && o.perf !== g.perfLevel) out.push({ label: '效能等級', file: g.perfFile, value: o.perf })
      if (g.power && o.capUw !== undefined && o.capUw !== g.power.uw) out.push({ label: '功耗上限', file: g.power.file, value: o.capUw })
      if (g.odFile && g.od) {
        const lines = []
        if (o.sclk && scan.topLevel(g.od.sclk)?.mhz !== o.sclk) lines.push(`s ${o.sclkI ?? 1} ${o.sclk}`)
        if (o.mclk && scan.topLevel(g.od.mclk)?.mhz !== o.mclk) lines.push(`m ${o.mclkI ?? 1} ${o.mclk}`)
        if (o.vo !== undefined && g.od.vddgfxOffset !== null && g.od.vddgfxOffset !== o.vo) lines.push(`vo ${o.vo}`)
        if (lines.length) for (const line of [...lines, 'c']) out.push({ label: 'OverDrive', file: g.odFile, value: line })
      }
    }
    return out
  }
}

module.exports = { createLinuxOcEngine, STORE_KEY, amdReason }
