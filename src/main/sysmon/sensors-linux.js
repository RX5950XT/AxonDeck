'use strict'

/**
 * AxonDeck — Linux 版感測器橋接。介面跟 `sensors.js`（Windows sidecar）一模一樣：
 * status／read／send／enable／stop／configure／taskStatus／taskInstall／taskRemove。
 *
 * 跟 Windows 最大的不同：**讀取不需要任何權限**（hwmon 檔案預設 0444），
 * 所以沒有 sidecar、沒有管道、也沒有「第一次要授權」——啟用＝開一個 1 秒的讀取迴圈。
 *
 * 風扇寫入（pwmN／pwmN_enable）預設只有 root 能寫。我們**不偷偷提權**：
 *   - 檔案寫得進去（root 執行，或使用者已照 docs/linux-sensors.md 裝好 udev 規則）就列成可控通道
 *   - 寫不進去就不列；風扇頁顯示「授權風扇控制」按鈕，按下才走一次 pkexec 安裝 udev 規則
 *     （見 fan-access-linux.js，規則內容固定、只放寬 pwm 兩種檔案）
 *
 * 安全網跟 sidecar 同一套：S／D／R／P 指令、5 秒沒有任何指令就全部交還（看門狗）、
 * 交還＝把 pwmN_enable 寫回接管前的值（通常是 2／5＝晶片自動），不是寫死某個數字。
 *
 * 效能調整不走這裡：橋接的 `oc` 只提供 CPU 即時讀數（writable=false），可調項與寫入由 oc-linux.js 負責。
 */

const fsp = require('fs').promises
const path = require('path')
const hw = require('./hwmon-linux')
const { createFanAccess } = require('./fan-access-linux')

const TICK_MS = 1000
/** 結構（有哪些晶片、哪些檔）多久重掃一次：熱插拔 GPU／USB 水冷頭才看得到 */
const RESCAN_MS = 30_000
const STALE_MS = 20_000
/** 跟 sidecar 的 WatchdogMs 一樣：主程式 5 秒沒送任何指令就全部交還 */
const WATCHDOG_MS = 5_000
const OC_REASON = 'Linux 版不支援效能調整（超頻）：Windows 版靠 PawnIO／NVAPI 寫 SMU 與顯示卡暫存器，Linux 沒有對應且安全的免驅動介面。'

function createLinuxSensorBridge(deps = {}) {
  const roots = {
    sysfsRoot: deps.sysfsRoot || '/sys',
    procRoot: deps.procRoot || '/proc'
  }
  const tickMs = Number(deps.tickMs) > 0 ? Number(deps.tickMs) : TICK_MS
  const watchdogMs = Number(deps.watchdogMs) > 0 ? Number(deps.watchdogMs) : WATCHDOG_MS
  const readGpuCards = typeof deps.readGpuCards === 'function' ? deps.readGpuCards : () => []
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  let access = deps.access || createFanAccess({ spawnFn: deps.spawnFn, sysfsRoot: roots.sysfsRoot })

  /** @type {'off'|'starting'|'on'|'missing'} */
  let state = 'off'
  let message = ''
  let layout = null
  let scannedAt = 0
  let timer = null
  let busy = null
  let groups = []
  let controls = []
  let lastAt = 0
  let lastCmdAt = 0
  let prevCpu = null
  /** energy 計數器上一輪的值：Map<file, { uj, t }> */
  const prevEnergy = new Map()
  /** id → { dir, n, enable0, pwm0 }（enable0／pwm0＝接管前的值，交還時寫回） */
  const overridden = new Map()
  /** id → { dir, index, hw, n, writable } 最近一次掃到的 pwm 通道（含不可寫的，給授權提示用） */
  let pwmIndex = new Map()

  async function ensureLayout(force) {
    if (!force && layout && now() - scannedAt < RESCAN_MS) return layout
    layout = await hw.scanSystem(roots)
    scannedAt = now()
    return layout
  }

  async function readChip(chip, t) {
    const sensors = []
    for (const input of chip.inputs) {
      const raw = await hw.readNum(path.join(chip.dir, input.file))
      if (raw === null) continue
      const [type, div] = hw.KINDS[input.kind]
      sensors.push({ n: input.label, t: type, v: round(raw / div) })
    }
    for (const energy of chip.energies) {
      const watts = await energyWatts(path.join(chip.dir, energy.file), t)
      if (watts !== null) sensors.push({ n: energy.label, t: 'Power', v: watts })
    }
    if (chip.busyFile) {
      const load = await hw.readNum(chip.busyFile)
      if (load !== null) sensors.push({ n: 'GPU Core', t: 'Load', v: load })
    }
    for (const index of chip.pwms) {
      const raw = await hw.readNum(path.join(chip.dir, `pwm${index}`))
      if (raw !== null) sensors.push({ n: pwmName(chip, index), t: 'Control', v: round((raw / 255) * 100) })
    }
    return sensors
  }

  /** energy*_input／RAPL energy_uj 是累計微焦耳，兩輪相減除以時間才是瓦 */
  async function energyWatts(file, t) {
    const uj = await hw.readNum(file)
    if (uj === null) return null
    const prev = prevEnergy.get(file)
    prevEnergy.set(file, { uj, t })
    if (!prev || t <= prev.t || uj < prev.uj) return null
    return round((uj - prev.uj) / ((t - prev.t) * 1000))
  }

  function pwmName(chip, index) {
    return chip.type.startsWith('Gpu') ? (index === 1 ? 'GPU Fan' : `GPU Fan #${index}`) : `Fan #${index}`
  }

  async function readCpuLoad() {
    const cur = hw.parseCpuStat(await hw.readText(path.join(roots.procRoot, 'stat')))
    const prev = prevCpu
    prevCpu = cur
    if (!cur || !prev || cur.total <= prev.total) return null
    return round(((cur.busy - prev.busy) / (cur.total - prev.total)) * 100)
  }

  /** nvidia-smi 已經由 gpu.js 常駐在讀；直接借它的數字，不另外 spawn 一顆 */
  function nvidiaGroups() {
    let cards = []
    try { cards = readGpuCards() || [] } catch { cards = [] }
    return cards.map((card) => {
      const s = []
      if (Number.isFinite(card.temperature)) s.push({ n: 'GPU Core', t: 'Temperature', v: card.temperature })
      if (Number.isFinite(card.utilization)) s.push({ n: 'GPU Core', t: 'Load', v: card.utilization })
      if (Number.isFinite(card.power)) s.push({ n: 'GPU Package', t: 'Power', v: card.power })
      if (Number.isFinite(card.clockSm)) s.push({ n: 'GPU Core', t: 'Clock', v: card.clockSm })
      if (Number.isFinite(card.clockMem)) s.push({ n: 'GPU Memory', t: 'Clock', v: card.clockMem })
      // nvidia-smi 的 fan.speed 是百分比，不是 RPM
      if (Number.isFinite(card.fan)) s.push({ n: 'GPU Fan', t: 'Control', v: card.fan })
      return { n: card.name || 'NVIDIA GPU', t: 'GpuNvidia', s }
    }).filter((g) => g.s.length)
  }

  async function readFrame() {
    const lay = await ensureLayout(false)
    const t = now()
    const out = []
    const cpuExtra = []
    const load = await readCpuLoad()
    if (load !== null) cpuExtra.push({ n: 'CPU Total', t: 'Load', v: load })
    cpuExtra.push(...await hw.readCoreClocks(roots.sysfsRoot))
    for (const zone of lay.zones) {
      const v = await hw.readNum(zone.file)
      if (v === null) continue
      const label = zone.type === 'x86_pkg_temp' ? 'Package' : zone.type
      const entry = { n: label, t: 'Temperature', v: round(v / 1000) }
      if (zone.hw === 'Cpu') cpuExtra.push(entry)
      else out.push({ n: zone.type, t: zone.hw, s: [entry] })
    }
    for (const rapl of lay.rapl) {
      const watts = await energyWatts(rapl.file, t)
      if (watts !== null) cpuExtra.push({ n: rapl.label, t: 'Power', v: watts })
    }
    const cpuChips = []
    for (const chip of lay.chips) {
      const s = await readChip(chip, t)
      if (!s.length) continue
      if (chip.type === 'Cpu') cpuChips.push(...s)
      else out.push({ n: chip.display, t: chip.type, s })
    }
    // 多顆 k10temp（雙路）或 coretemp＋RAPL 併成同一個 Cpu 硬體：畫面的 CPU 那一塊只認一個
    const cpu = [...cpuChips, ...cpuExtra]
    if (cpu.length) out.unshift({ n: lay.cpuModel, t: 'Cpu', s: cpu })
    out.push(...nvidiaGroups())
    return { groups: out, t }
  }

  async function readControls() {
    const lay = layout
    const next = new Map()
    const list = []
    for (const chip of lay?.chips || []) {
      const rpmByIndex = new Map(chip.inputs.filter((i) => i.kind === 'fan').map((i) => [i.index, i]))
      for (const index of chip.pwms) {
        const id = `${chip.key}/pwm${index}`
        const pwmFile = path.join(chip.dir, `pwm${index}`)
        const enableFile = `${pwmFile}_enable`
        const hasEnable = (await hw.readNum(enableFile)) !== null
        const ok = await hw.writable(pwmFile) && (!hasEnable || await hw.writable(enableFile))
        const n = pwmName(chip, index)
        next.set(id, { dir: chip.dir, index, hw: chip.display, n, writable: ok, hasEnable })
        if (!ok) continue
        const raw = await hw.readNum(pwmFile)
        const fan = rpmByIndex.get(index)
        const rpm = fan ? await hw.readNum(path.join(chip.dir, fan.file)) : null
        list.push({
          id, n, hw: chip.display,
          pwm: raw === null ? null : round((raw / 255) * 100),
          rpm, min: 0, max: 100, o: overridden.has(id)
        })
      }
    }
    pwmIndex = next
    return list
  }

  async function tick() {
    if (busy) return busy
    busy = (async () => {
      try {
        const frame = await readFrame()
        groups = frame.groups
        controls = await readControls()
        lastAt = now()
        state = 'on'
        message = describe()
        if (overridden.size && now() - lastCmdAt > watchdogMs) await restoreAll()
      } catch {
        // 單輪讀失敗不該讓迴圈停掉；STALE_MS 之後 read() 自然回 available=false
      } finally {
        busy = null
      }
    })()
    return busy
  }

  function describe() {
    const hasTemp = groups.some((g) => g.s.some((s) => s.t === 'Temperature'))
    if (!hasTemp) return '這台機器沒有公開任何溫度感測器（/sys/class/hwmon、thermal 都是空的；虛擬機與容器常見），其餘頁面數值（CPU、記憶體、磁碟、網路）不受影響。'
    return ''
  }

  async function writeControl(id, value) {
    const ch = pwmIndex.get(id)
    if (!ch || !ch.writable) return false
    const pwmFile = path.join(ch.dir, `pwm${ch.index}`)
    const enableFile = `${pwmFile}_enable`
    try {
      if (!overridden.has(id)) {
        const enable0 = ch.hasEnable ? await hw.readNum(enableFile) : null
        const pwm0 = await hw.readNum(pwmFile)
        overridden.set(id, { pwmFile, enableFile, enable0, pwm0, hasEnable: ch.hasEnable })
      }
      if (ch.hasEnable) await fsp.writeFile(enableFile, '1')
      const v = Math.max(0, Math.min(100, Number(value)))
      await fsp.writeFile(pwmFile, String(Math.round((v / 100) * 255)))
      return true
    } catch {
      return false
    }
  }

  /** 交還：寫回接管前的 enable 值；接管前本來就是手動（1）才連 pwm 一起寫回 */
  async function restoreOne(id) {
    const saved = overridden.get(id)
    if (!saved) return
    overridden.delete(id)
    try {
      if (saved.hasEnable && saved.enable0 !== null && saved.enable0 !== 1) {
        await fsp.writeFile(saved.enableFile, String(saved.enable0))
        return
      }
      if (saved.pwm0 !== null) await fsp.writeFile(saved.pwmFile, String(saved.pwm0))
      // 原本是 0（全速）或讀不到 enable：至少交回自動，沒有自動模式的晶片會拒絕，那就保留 pwm0
      if (saved.hasEnable && saved.enable0 === null) await fsp.writeFile(saved.enableFile, '2').catch(() => undefined)
    } catch { /* 盡力而為；看門狗下一輪不會再碰這條 */ }
  }

  async function restoreAll() {
    for (const id of [...overridden.keys()]) await restoreOne(id)
  }

  /** 指令排隊：S 與 D 必須照順序落到檔案上 */
  let queue = Promise.resolve()
  function enqueue(fn) {
    queue = queue.then(fn, fn)
    return queue
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => { tick() }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function round(n) {
    return Math.round(n * 1000) / 1000
  }

  return {
    status() {
      return {
        state, message,
        available: state === 'on' && (now() - lastAt) < STALE_MS,
        installed: true,
        needsPawnIo: false,
        pawnIoUrl: '',
        platform: 'linux'
      }
    },

    read() {
      if (state !== 'on' || (now() - lastAt) >= STALE_MS) {
        return { available: false, groups: [], controls: [], oc: null, processNetwork: null }
      }
      return { available: true, groups, controls, oc: ocPayload(groups), processNetwork: null }
    },

    /**
     * 同 sidecar 協定。回傳「有沒有送出去」：通道不可寫就回 false，
     * 風扇引擎據此不把它記成已接管。
     * @param {string} line
     */
    send(line) {
      if (state !== 'on') return false
      const parts = String(line || '').trim().split(/\s+/)
      lastCmdAt = now()
      switch (parts[0]) {
        case 'P': return true
        case 'S': {
          const ch = pwmIndex.get(parts[1])
          const value = Number(parts[2])
          if (!ch || !ch.writable || !Number.isFinite(value)) return false
          enqueue(() => writeControl(parts[1], value))
          return true
        }
        case 'D':
          enqueue(() => restoreOne(parts[1]))
          return true
        case 'R':
          enqueue(restoreAll)
          return true
        default:
          // G／C／K／X：效能調整，Linux 不支援
          return false
      }
    },

    async enable() {
      if (state === 'on') return { state, message }
      state = 'starting'
      await ensureLayout(true)
      await tick()
      startTimer()
      return { state, message }
    },

    /** 收掉前先交還所有風扇（同 sidecar 的 R → {"reset":1}） */
    async stop() {
      if (timer) { clearInterval(timer); timer = null }
      await queue.catch(() => undefined)
      await restoreAll()
      state = 'off'
      message = ''
      groups = []
      controls = []
      lastAt = 0
    },

    configure(options = {}) {
      if (options.access) access = options.access
    },

    /** 「授權風扇控制」：只在使用者按按鈕時跑（`manual: true` 讓自動啟用那條略過） */
    taskStatus: () => access.status([...pwmIndex.values()]),
    taskInstall: async () => {
      const result = await access.install()
      await ensureLayout(true)
      await tick()
      return { ...access.status([...pwmIndex.values()]), ...result }
    },
    taskRemove: async () => {
      await enqueue(restoreAll)
      return access.remove()
    },
    launchedByTask: () => false,

    /** 測試用：手動跑一輪 */
    _tick: tick,
    _flush: () => queue
  }
}

/** 效能調整面板要的 o：只給讀數，writable 一律 false 並附原因 */
function ocPayload(groups) {
  const cpu = groups.find((g) => g.t === 'Cpu')
  const pick = (g, t, re) => g?.s.find((s) => s.t === t && (!re || re.test(s.n)))?.v ?? null
  const gpus = groups.filter((g) => g.t.startsWith('Gpu')).map((g, i) => ({
    i, w: 0, n: g.n, r: OC_REASON,
    t: pick(g, 'Temperature', /Core/), h: pick(g, 'Temperature', /Hot/),
    k: pick(g, 'Clock', /Core/), u: pick(g, 'Load'), pd: pick(g, 'Power')
  }))
  return {
    c: {
      w: 0, n: cpu?.n || '', r: OC_REASON,
      t: pick(cpu, 'Temperature', /Tctl|Package/) ?? pick(cpu, 'Temperature'),
      k: pick(cpu, 'Clock'), p: pick(cpu, 'Power'), u: pick(cpu, 'Load')
    },
    g: gpus[0] || { i: 0, w: 0, n: '', r: OC_REASON },
    gs: gpus
  }
}

module.exports = { createLinuxSensorBridge, OC_REASON, WATCHDOG_MS, TICK_MS }
