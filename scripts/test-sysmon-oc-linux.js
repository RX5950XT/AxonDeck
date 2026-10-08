'use strict'

/**
 * Linux 效能調整：sysfs 探測／OD 表解析／可調項邊界／二次確認／原始值快照與還原／過熱還原／
 * NVIDIA（假 nvidia-smi＋假 pkexec 走真的 sh 腳本）／授權規則。
 * 全部用假的 sysfs 樹，不碰真的 /sys（這台測試機是虛擬機，沒有 cpufreq／RAPL／GPU）。
 * 用法：node scripts/test-sysmon-oc-linux.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const scan = require('../src/main/sysmon/oc-linux-sysfs')
const nv = require('../src/main/sysmon/oc-linux-nvidia')
const plan = require('../src/main/sysmon/oc-linux-plan')
const { createOcAccess, ruleText, validateNvidiaOps, NVIDIA_SCRIPT } = require('../src/main/sysmon/oc-access-linux')
const { createLinuxOcEngine, STORE_KEY } = require('../src/main/sysmon/oc-linux')

if (process.platform !== 'linux') {
  console.log('SKIP oc linux（非 Linux）')
  process.exit(0)
}

const FAKE_SMI = path.join(__dirname, 'fixtures', 'oc', 'fake-nvidia-smi.js')
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

const OD_RDNA2 = `OD_SCLK:
0: 500Mhz
1: 2615Mhz
OD_MCLK:
0: 97Mhz
1: 1000MHz
OD_VDDGFX_OFFSET:
0mV
OD_RANGE:
SCLK:     500Mhz       4000Mhz
MCLK:     674Mhz       1200Mhz
`
const OD_NAVI10 = `OD_SCLK:
0: 300Mhz
1: 2000Mhz
OD_MCLK:
1: 875MHz
OD_VDDC_CURVE:
0: 700Mhz 707mV
1: 1350Mhz 800mV
2: 2000Mhz 1150mV
OD_RANGE:
SCLK:     300Mhz       2150Mhz
MCLK:     625Mhz        950Mhz
VDDC_CURVE_SCLK[0]:     300Mhz       2150Mhz
`

function put(root, rel, text, mode) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, String(text))
  if (mode) fs.chmodSync(file, mode)
  return file
}

/** 一台「桌機」：4 個 cpufreq policy（intel_pstate）、RAPL PL1／PL2、amdgpu（RDNA2）、一張 Intel 內顯（要略過） */
function buildFakeSys(opts = {}) {
  const sys = tempDir('ocsys-')
  const proc = tempDir('ocproc-')
  put(proc, 'sys/kernel/random/boot_id', `${opts.bootId || 'boot-a'}\n`)
  for (let i = 0; i < 4; i += 1) {
    const p = `devices/system/cpu/cpufreq/policy${i}`
    put(sys, `${p}/cpuinfo_min_freq`, '400000\n')
    put(sys, `${p}/cpuinfo_max_freq`, i < 2 ? '5000000\n' : '3800000\n')
    put(sys, `${p}/scaling_max_freq`, i < 2 ? '5000000\n' : '3800000\n')
    put(sys, `${p}/scaling_governor`, 'powersave\n')
    put(sys, `${p}/scaling_available_governors`, 'performance powersave\n')
    put(sys, `${p}/scaling_driver`, 'intel_pstate\n')
    put(sys, `${p}/energy_performance_preference`, 'balance_performance\n')
    put(sys, `${p}/energy_performance_available_preferences`, 'default performance balance_performance balance_power power \n')
  }
  put(sys, 'devices/system/cpu/intel_pstate/no_turbo', '0\n')
  put(sys, 'class/powercap/intel-rapl:0/name', 'package-0\n')
  put(sys, 'class/powercap/intel-rapl:0/energy_uj', '1\n', 0o400)
  put(sys, 'class/powercap/intel-rapl:0/constraint_0_name', 'long_term\n')
  put(sys, 'class/powercap/intel-rapl:0/constraint_0_power_limit_uw', '125000000\n')
  put(sys, 'class/powercap/intel-rapl:0/constraint_0_max_power_uw', '150000000\n')
  put(sys, 'class/powercap/intel-rapl:0/constraint_1_name', 'short_term\n')
  put(sys, 'class/powercap/intel-rapl:0/constraint_1_power_limit_uw', '181000000\n')
  put(sys, 'module/amdgpu/parameters/ppfeaturemask', `${opts.mask || '0xfff7ffff'}\n`)
  const dev = 'devices/pci0000:00/0000:03:00.0'
  put(sys, `${dev}/vendor`, '0x1002\n')
  put(sys, `${dev}/power_dpm_force_performance_level`, 'auto\n')
  if (opts.od !== false) put(sys, `${dev}/pp_od_clk_voltage`, opts.odText || OD_RDNA2)
  put(sys, `${dev}/gpu_busy_percent`, '12\n')
  put(sys, `${dev}/hwmon/hwmon5/power1_cap`, '255000000\n')
  put(sys, `${dev}/hwmon/hwmon5/power1_cap_min`, '191000000\n')
  put(sys, `${dev}/hwmon/hwmon5/power1_cap_max`, '293000000\n')
  put(sys, `${dev}/hwmon/hwmon5/power1_cap_default`, '255000000\n')
  put(sys, `${dev}/hwmon/hwmon5/temp1_input`, `${opts.gpuTemp ?? 52000}\n`)
  put(sys, `${dev}/hwmon/hwmon5/power1_average`, '88000000\n')
  put(sys, `${dev}/hwmon/hwmon5/freq1_input`, '2400000000\n')
  fs.mkdirSync(path.join(sys, 'class/drm/card0'), { recursive: true })
  fs.symlinkSync(path.join(sys, dev), path.join(sys, 'class/drm/card0/device'))
  // Intel 內顯：要被略過
  put(sys, 'devices/pci0000:00/0000:00:02.0/vendor', '0x8086\n')
  fs.mkdirSync(path.join(sys, 'class/drm/card1'), { recursive: true })
  fs.symlinkSync(path.join(sys, 'devices/pci0000:00/0000:00:02.0'), path.join(sys, 'class/drm/card1/device'))
  return { sys, proc, dev: path.join(sys, dev) }
}

/**
 * 假核心：pp_od_clk_voltage 照 amdgpu 的規則逐行解讀（s／m／vo 先暫存，c 才提交，r 回出廠，超出 OD_RANGE 回 EINVAL）。
 * 其他檔案照寫（權限照真檔案的 mode）。
 */
function fakeKernel() {
  const writes = []
  const od = new Map()
  function odState(file) {
    if (!od.has(file)) {
      const text = fs.readFileSync(file, 'utf8')
      od.set(file, { factory: scan.parseOdTable(text), cur: scan.parseOdTable(text), pending: [], raw: text })
    }
    return od.get(file)
  }
  function render(st) {
    const lines = ['OD_SCLK:', ...st.cur.sclk.map((l) => `${l.i}: ${l.mhz}Mhz`), 'OD_MCLK:', ...st.cur.mclk.map((l) => `${l.i}: ${l.mhz}MHz`)]
    if (st.cur.vddgfxOffset !== null) lines.push('OD_VDDGFX_OFFSET:', `${st.cur.vddgfxOffset}mV`)
    lines.push('OD_RANGE:', ...Object.entries(st.cur.range).map(([k, [a, b]]) => `${k}:     ${a}Mhz       ${b}Mhz`))
    return lines.join('\n') + '\n'
  }
  function einval() {
    const err = new Error('EINVAL')
    err.code = 'EINVAL'
    throw err
  }
  function write(file, text) {
    writes.push([path.basename(file), text])
    if (!file.endsWith('pp_od_clk_voltage')) {
      fs.writeFileSync(file, text)
      return
    }
    fs.accessSync(file, fs.constants.W_OK)
    const st = odState(file)
    const [cmd, a, b] = text.trim().split(/\s+/)
    if (cmd === 'c') {
      for (const fn of st.pending) fn()
      st.pending = []
    } else if (cmd === 'r') {
      st.cur = JSON.parse(JSON.stringify(st.factory))
    } else if (cmd === 's' || cmd === 'm') {
      const [lo, hi] = st.cur.range[cmd === 's' ? 'SCLK' : 'MCLK']
      const mhz = Number(b)
      if (!(mhz >= lo && mhz <= hi)) einval()
      const list = st.cur[cmd === 's' ? 'sclk' : 'mclk']
      st.pending.push(() => { list.find((l) => l.i === Number(a)).mhz = mhz })
    } else if (cmd === 'vo') {
      st.pending.push(() => { st.cur.vddgfxOffset = Number(a) })
    } else einval()
    fs.writeFileSync(file, render(st))
  }
  return {
    writes,
    writeFile: async (file, text) => write(file, text),
    writeFileSync: write
  }
}

function memStore(initial = {}) {
  const data = { ...initial }
  return { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, data }
}

function fakeSensors(temp = 50) {
  const s = { temp, read: () => ({ available: true, oc: { c: { n: 'Intel Core i7-13700K', t: s.temp, k: 4800, p: 60, u: 10 } } }) }
  return s
}

/** 假 pkexec：照真的 argv（/bin/sh -c <script> <$0> args…）去跑，等於驗證腳本本身 */
function fakePkexecSpawn(log) {
  return (bin, args, opts) => {
    log.push({ bin, args })
    return spawn(args[0], args.slice(1), { ...opts, stdio: 'ignore', env: process.env })
  }
}

function makeEngine(fx, extra = {}) {
  const kernel = extra.kernel || fakeKernel()
  const pk = []
  const access = extra.access || createOcAccess({
    spawnFn: fakePkexecSpawn(pk),
    exists: (p) => p === '/usr/bin/pkexec' || p === (extra.rulePath || ''),
    uid: () => 1000,
    gid: () => 1000
  })
  const engine = createLinuxOcEngine({
    sensors: extra.sensors || fakeSensors(),
    store: extra.store || memStore(),
    sysfsRoot: fx.sys,
    procRoot: fx.proc,
    access,
    smiPath: extra.smiPath ?? '',
    writeFile: kernel.writeFile,
    writeFileSync: kernel.writeFileSync,
    tickMs: 60_000
  })
  return { engine, kernel, pk }
}

const knobsOf = (panel) => Object.fromEntries(panel.folds.flatMap((f) => f.knobs).map((k) => [k.key, k]))
const read = (file) => fs.readFileSync(file, 'utf8').trim()

function testParse() {
  const r2 = scan.parseOdTable(OD_RDNA2)
  assert.deepEqual(r2.sclk, [{ i: 0, mhz: 500 }, { i: 1, mhz: 2615 }])
  assert.deepEqual(r2.mclk, [{ i: 0, mhz: 97 }, { i: 1, mhz: 1000 }])
  assert.equal(r2.vddgfxOffset, 0)
  assert.deepEqual(r2.range, { SCLK: [500, 4000], MCLK: [674, 1200] })
  const n10 = scan.parseOdTable(OD_NAVI10)
  assert.deepEqual(n10.mclk, [{ i: 1, mhz: 875 }])
  assert.equal(n10.vddgfxOffset, null, 'Navi10 沒有 VDDGFX_OFFSET（電壓走曲線，不開放）')
  assert.deepEqual(n10.range.SCLK, [300, 2150])
  const r3 = scan.parseOdTable('OD_SCLK:\n0: 500Mhz\n1: 2900Mhz\nOD_VDDGFX_OFFSET:\n-30mV\nOD_RANGE:\nSCLK:     500Mhz       3500Mhz\nVDDGFX_OFFSET:   -200mv        0mv\n')
  assert.equal(r3.vddgfxOffset, -30)
  assert.deepEqual(r3.range.VDDGFX_OFFSET, [-200, 0])
  const q = nv.parseQuery('0, NVIDIA GeForce RTX 4080, 00000000:01:00.0, 320.00, 320.00, 150.00, 352.00, 3105, 11201, 2505, 11201, 48, 85.20, 12\n1, Tesla T4, 00000000:02:00.0, [N/A], [N/A], [N/A], [N/A], 1590, 5001, 300, 405, 35, 9.1, 0\n')
  assert.equal(q.length, 2)
  assert.equal(q[0].maxPowerW, 352)
  assert.equal(q[1].defPowerW, null)
  assert.deepEqual(nv.buildOps(q[1], { powerPct: 120, coreMHz: -100, memMHz: 0 }), [[1, '-lgc', '0,1490'], [1, '-rmc', null]], '沒有功耗牆資訊的卡不送 -pl')
  console.log('ok 解析：pp_od_clk_voltage（RDNA2／Navi10／RDNA3）、nvidia-smi CSV')
}

async function testScanAndKnobs() {
  const fx = buildFakeSys()
  const amd = await scan.scanAmdGpus(fx.sys)
  assert.equal(amd.length, 1, 'Intel 內顯略過')
  assert.equal(amd[0].pci, '0000:03:00.0')
  assert.equal(amd[0].odMaskOn, true)
  const cpu = await scan.scanCpu(fx.sys)
  assert.equal(cpu.policies.length, 4)
  assert.equal(cpu.turbo.kind, 'no_turbo')
  assert.equal(cpu.rapl[0].constraints.length, 2)

  const { engine } = makeEngine(fx)
  const st = await engine.status()
  assert.equal(st.platform, 'linux')
  const c = knobsOf(st.linux.cpu)
  assert.deepEqual([c.maxFreqMhz.min, c.maxFreqMhz.max, c.maxFreqMhz.current], [400, 5000, 5000])
  assert.deepEqual(c.governor.options.map((o) => o[0]), ['performance', 'powersave'])
  assert.equal(c.epp.current, 'balance_performance')
  assert.equal(c.turbo.current, 'on')
  // PL1：出廠 125 W → 下限 63、上限取 constraint_0_max_power_uw（150）與 1.5 倍的較小者
  const pl1 = c['rapl.intel-rapl:0.0']
  assert.deepEqual([pl1.label, pl1.min, pl1.max, pl1.current], ['PL1 長時間功耗牆', 63, 150, 125])
  const pl2 = c['rapl.intel-rapl:0.1']
  assert.deepEqual([pl2.min, pl2.max], [91, 272], 'PL2 沒有 max_power_uw → 1.5 倍')
  const g = knobsOf(st.linux.gpus[0])
  // power1_cap：191～293 W，出廠 255 → 75%～114%
  assert.deepEqual([g.powerPct.min, g.powerPct.max, g.powerPct.current], [75, 114, 100])
  // OD_RANGE SCLK 500～4000、出廠 2615 → 偏移再疊 ±500 的絕對限制
  assert.deepEqual([g.coreMHz.min, g.coreMHz.max], [-500, 500])
  assert.deepEqual([g.memMHz.min, g.memMHz.max], [-326, 200])
  assert.deepEqual([g.voltMv.min, g.voltMv.max], [-100, 0], 'OD_RANGE 沒給電壓範圍 → 只准降壓 100 mV 內')
  assert.deepEqual(g.perfLevel.options.map((o) => o[0]), ['auto', 'high', 'low'])
  assert.equal(st.live.gpus[0].temp, 52)
  assert.equal(st.live.cpu.writable, true)
  assert.equal(st.linux.auth.locked, 0)
  console.log('ok 探測與邊界：cpufreq 400–5000 MHz、RAPL PL1 63–150 W／PL2 91–272 W、amdgpu 75–114%、OD ±500／-326…+200 MHz、降壓 -100…0 mV')
}

async function testDraftConfirmApplyReset() {
  const fx = buildFakeSys()
  const store = memStore()
  const { engine, kernel } = makeEngine(fx, { store })
  const set = (target, key, value) => engine.setDraft({ linux: { target, key, value } })
  const gid = 'amd:0000:03:00.0'
  // 夾值、擋掉不認得的項目
  let st = await set(gid, 'coreMHz', 9999)
  assert.equal(st.draft.gpus[gid].coreMHz, 500)
  await assert.rejects(set(gid, 'tempC', 80), { code: 'SYSMON_OC_BAD_KNOB' })
  await assert.rejects(set('cpu', 'governor', 'ondemand'), { code: 'SYSMON_OC_BAD_KNOB' }, '不在 scaling_available_governors')
  await assert.rejects(set('nope', 'x', 1), { code: 'SYSMON_OC_BAD_KNOB' })
  await set(gid, 'coreMHz', 100)
  await set(gid, 'powerPct', 110)
  await set(gid, 'voltMv', -50)
  await set('cpu', 'maxFreqMhz', 4200)
  await set('cpu', 'rapl.intel-rapl:0.0', 140)
  await set('cpu', 'turbo', 'on') // 跟目前一樣＝不動
  assert.equal(Object.hasOwn((await engine.status()).draft.cpu, 'turbo'), false)

  // 有風險 → 先要確認，什麼都沒寫
  await assert.rejects(engine.apply(), (err) => err.code === 'SYSMON_OC_CONFIRM' && err.risks.length === 4)
  assert.equal(kernel.writes.length, 0)
  st = await engine.apply({ confirmed: true })
  assert.equal(st.applied, true)
  assert.equal(st.lastError, '')
  assert.deepEqual(kernel.writes.filter((w) => w[0] === 'pp_od_clk_voltage').map((w) => w[1]), ['s 1 2715', 'vo -50', 'c'])
  assert.equal(read(path.join(fx.dev, 'hwmon/hwmon5/power1_cap')), String(Math.round(255e6 * 1.1)))
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy0/scaling_max_freq')), '4200000')
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy3/scaling_max_freq')), '3800000', '小核上限 3.8 GHz：夾在自己的 cpuinfo_max')
  assert.equal(read(path.join(fx.sys, 'class/powercap/intel-rapl:0/constraint_0_power_limit_uw')), '140000000')
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/intel_pstate/no_turbo')), '0', '沒動的不寫')
  const g = knobsOf(st.linux.gpus[0])
  assert.equal(g.coreMHz.current, 100, '偏移相對「原始值」，不會越套越高')
  assert.equal(store.data[STORE_KEY].config.dirty, true)
  assert.equal(store.data[STORE_KEY].orig.gpus[gid].sclk, 2615)

  // 再套一次同樣的值：仍以原始 2615 為基準
  kernel.writes.length = 0
  await engine.apply({ confirmed: true })
  assert.deepEqual(kernel.writes.filter((w) => w[0] === 'pp_od_clk_voltage').map((w) => w[1]), ['s 1 2715', 'vo -50', 'c'])

  // 還原：寫回原始值，草稿清空
  kernel.writes.length = 0
  st = await engine.reset()
  assert.equal(st.applied, false)
  assert.equal(read(path.join(fx.dev, 'hwmon/hwmon5/power1_cap')), '255000000')
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy0/scaling_max_freq')), '5000000')
  assert.equal(read(path.join(fx.sys, 'class/powercap/intel-rapl:0/constraint_0_power_limit_uw')), '125000000')
  assert.match(read(path.join(fx.dev, 'pp_od_clk_voltage')), /1: 2615Mhz[\s\S]*\n0mV/)
  assert.deepEqual(st.draft, { cpu: {}, gpus: {} })
  assert.equal(store.data[STORE_KEY].config.dirty, false)
  console.log('ok 草稿夾值／二次確認（4 項風險）／套用（OD s→vo→c、power1_cap、cpufreq、RAPL）／重套不疊加／還原原始值')
}

async function testSafeApplyAndFailures() {
  const fx = buildFakeSys()
  const { engine, kernel } = makeEngine(fx)
  await assert.rejects(engine.apply(), { code: 'SYSMON_OC_NOTHING' })
  // 只往下調：不用確認
  await engine.setDraft({ linux: { target: 'cpu', key: 'turbo', value: 'off' } })
  await engine.setDraft({ linux: { target: 'cpu', key: 'governor', value: 'performance' } })
  await engine.setDraft({ linux: { target: 'cpu', key: 'epp', value: 'power' } })
  await engine.setDraft({ linux: { target: 'amd:0000:03:00.0', key: 'perfLevel', value: 'low' } })
  const st = await engine.apply()
  assert.equal(st.applied, true)
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/intel_pstate/no_turbo')), '1')
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy2/scaling_governor')), 'performance')
  assert.equal(read(path.join(fx.dev, 'power_dpm_force_performance_level')), 'low')
  // App 結束：同步寫回
  engine.shutdown()
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/intel_pstate/no_turbo')), '0')
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy2/scaling_governor')), 'powersave')
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy2/energy_performance_preference')), 'balance_performance')
  assert.equal(read(path.join(fx.dev, 'power_dpm_force_performance_level')), 'auto')

  // 驅動拒絕（超出 OD_RANGE 的值靠假核心回 EINVAL）：部分失敗要講清楚
  const fx2 = buildFakeSys({ odText: OD_RDNA2.replace('SCLK:     500Mhz       4000Mhz', 'SCLK:     500Mhz       2615Mhz') })
  const e2 = makeEngine(fx2).engine
  await e2.status()
  // 範圍變小後偏移上限是 0；硬塞一個超出的值給假核心看
  await e2.setDraft({ linux: { target: 'cpu', key: 'maxFreqMhz', value: 3000 } })
  await e2.setDraft({ linux: { target: 'amd:0000:03:00.0', key: 'coreMHz', value: 50 } })
  const s2 = await e2.status()
  assert.equal(s2.draft.gpus['amd:0000:03:00.0'], undefined, '夾到上限 0＝跟目前一樣＝不動')
  console.log('ok 往下調免確認、App 結束同步還原、OD 上限夾在 OD_RANGE')
}

async function testPanicAndNoTemp() {
  const fx = buildFakeSys()
  const sensors = fakeSensors(60)
  const { engine } = makeEngine(fx, { sensors })
  await engine.setDraft({ linux: { target: 'cpu', key: 'maxFreqMhz', value: 3000 } })
  await engine.apply()
  sensors.temp = 99
  await engine._tick()
  const st = await engine.status()
  assert.equal(st.applied, false)
  assert.equal(st.panic, true)
  assert.match(st.lastError, /過熱/)
  assert.equal(read(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy0/scaling_max_freq')), '5000000')

  // 完全讀不到溫度：不准套用
  const fx2 = buildFakeSys()
  fs.unlinkSync(path.join(fx2.dev, 'hwmon/hwmon5/temp1_input'))
  const e2 = makeEngine(fx2, { sensors: fakeSensors(null) }).engine
  await e2.setDraft({ linux: { target: 'cpu', key: 'maxFreqMhz', value: 3000 } })
  await assert.rejects(e2.apply(), { code: 'SYSMON_OC_NO_TEMP' })
  assert.equal(read(path.join(fx2.sys, 'devices/system/cpu/cpufreq/policy0/scaling_max_freq')), '5000000')
  console.log('ok 過熱（99 °C ≥ 95）自動還原；讀不到任何溫度拒絕套用')
}

async function testPersistAcrossRestart() {
  const fx = buildFakeSys()
  const store = memStore()
  const a = makeEngine(fx, { store })
  await a.engine.setDraft({ linux: { target: 'amd:0000:03:00.0', key: 'coreMHz', value: -200 } })
  await a.engine.apply()
  // App 當掉（沒跑 shutdown），同一次開機重開
  const b = makeEngine(fx, { store, kernel: a.kernel })
  let st = await b.engine.status()
  assert.equal(st.dirtyLastRun, true)
  assert.equal(knobsOf(st.linux.gpus[0]).coreMHz.current, -200, '基準仍是存下來的原始 2615')
  st = await b.engine.reset()
  assert.match(read(path.join(fx.dev, 'pp_od_clk_voltage')), /1: 2615Mhz/)
  assert.equal(st.dirtyLastRun, false)

  // 重開機後（boot_id 變了）：舊的原始值作廢、不再提示
  await b.engine.setDraft({ linux: { target: 'cpu', key: 'maxFreqMhz', value: 3000 } })
  await b.engine.apply()
  fs.writeFileSync(path.join(fx.proc, 'sys/kernel/random/boot_id'), 'boot-b\n')
  fs.writeFileSync(path.join(fx.sys, 'devices/system/cpu/cpufreq/policy0/scaling_max_freq'), '5000000\n')
  const c = makeEngine(fx, { store })
  st = await c.engine.status()
  assert.equal(st.dirtyLastRun, false)
  assert.equal(store.data[STORE_KEY].orig.bootId, 'boot-b')
  console.log('ok 原始值跟 boot_id 一起存：當掉重開還原得回去；重開機後作廢')
}

async function testOdMaskOff() {
  const fx = buildFakeSys({ od: false, mask: '0xfff7bfff' })
  const { engine } = makeEngine(fx)
  const st = await engine.status()
  const gpu = st.linux.gpus[0]
  assert.match(gpu.reason, /ppfeaturemask＝0xfff7bfff/)
  assert.match(gpu.reason, /amdgpu\.ppfeaturemask=0xfff7ffff/)
  const keys = Object.keys(knobsOf(gpu))
  assert.deepEqual(keys.sort(), ['perfLevel', 'powerPct'], 'OverDrive 沒開：只剩功耗牆與效能等級')
  console.log('ok OverDrive 沒開：說明 ppfeaturemask 要加 0x4000，功耗牆／效能等級照常')
}

async function testLockedNeedsAuth() {
  if (IS_ROOT) {
    console.log('SKIP 權限：root 不受檔案 mode 限制')
    return
  }
  const fx = buildFakeSys()
  fs.chmodSync(path.join(fx.sys, 'class/powercap/intel-rapl:0/constraint_0_power_limit_uw'), 0o444)
  fs.chmodSync(path.join(fx.dev, 'pp_od_clk_voltage'), 0o444)
  const { engine, pk } = makeEngine(fx)
  const st = await engine.status()
  assert.equal(knobsOf(st.linux.cpu)['rapl.intel-rapl:0.0'].writable, false)
  assert.equal(knobsOf(st.linux.gpus[0]).coreMHz.writable, false)
  assert.equal(st.linux.auth.locked, 4, 'PL1、核心、記憶體、電壓')
  assert.equal(st.linux.auth.canInstall, true)
  assert.match(st.linux.auth.hint, /4 項需要一次系統授權/)
  assert.equal(pk.length, 0, '只看狀態不會叫 pkexec')
  console.log('ok 沒權限的項目標成需要授權（4 項），只看狀態不會跳密碼視窗')
}

async function testNvidia() {
  const fx = buildFakeSys()
  const dir = tempDir('smi-')
  process.env.FAKE_SMI_LOG = path.join(dir, 'log')
  process.env.FAKE_SMI_STATE = path.join(dir, 'state.json')
  const { engine, pk } = makeEngine(fx, { smiPath: FAKE_SMI })
  let st = await engine.status()
  const gpu = st.linux.gpus.find((g) => g.kind === 'nvidia')
  assert.equal(gpu.name, 'NVIDIA GeForce RTX 4080')
  const k = knobsOf(gpu)
  assert.deepEqual([k.powerPct.min, k.powerPct.max, k.powerPct.current], [47, 110, 100])
  assert.deepEqual([k.coreMHz.min, k.coreMHz.max], [-1000, 0])
  assert.match(gpu.note, /密碼視窗/)
  await engine.setDraft({ linux: { target: gpu.id, key: 'powerPct', value: 80 } })
  await engine.setDraft({ linux: { target: gpu.id, key: 'coreMHz', value: -300 } })
  await engine.setDraft({ linux: { target: gpu.id, key: 'coreMHz', value: 200 } })
  assert.equal((await engine.status()).draft.gpus[gpu.id].coreMHz, undefined, '正偏移夾到 0＝不動')
  await engine.setDraft({ linux: { target: gpu.id, key: 'coreMHz', value: -300 } })
  st = await engine.apply()
  assert.equal(st.lastError, '')
  assert.equal(pk.length, 1, '一次套用只跳一次 pkexec')
  assert.equal(pk[0].bin, '/usr/bin/pkexec')
  assert.deepEqual(pk[0].args.slice(0, 5), ['/bin/sh', '-c', NVIDIA_SCRIPT, 'axondeck-oc-nvidia', FAKE_SMI])
  assert.deepEqual(fs.readFileSync(process.env.FAKE_SMI_LOG, 'utf8').trim().split('\n'), ['-i 0 -pl 256', '-i 0 -lgc 0,2805'])
  assert.equal(knobsOf(st.linux.gpus.find((g) => g.kind === 'nvidia')).powerPct.current, 80)
  st = await engine.reset()
  assert.equal(pk.length, 2)
  assert.deepEqual(fs.readFileSync(process.env.FAKE_SMI_LOG, 'utf8').trim().split('\n').slice(2), ['-i 0 -rgc', '-i 0 -rmc', '-i 0 -pl 320'])
  // 驗證：旗標白名單、數字格式
  assert.throws(() => validateNvidiaOps([[0, '-r', null]]), { code: 'SYSMON_OC_BAD_OP' })
  assert.throws(() => validateNvidiaOps([[0, '-pl', '300; reboot']]), { code: 'SYSMON_OC_BAD_OP' })
  assert.throws(() => validateNvidiaOps([[99, '-pl', '300']]), { code: 'SYSMON_OC_BAD_OP' })
  // 使用者取消 pkexec（126）：不記成已套用
  const cancel = createOcAccess({
    spawnFn: () => { const { EventEmitter } = require('events'); const c = new EventEmitter(); setImmediate(() => c.emit('close', 126)); return c },
    exists: (p) => p === '/usr/bin/pkexec', uid: () => 1000
  })
  const e2 = makeEngine(fx, { smiPath: FAKE_SMI, access: cancel }).engine
  await e2.setDraft({ linux: { target: gpu.id, key: 'powerPct', value: 90 } })
  await assert.rejects(e2.apply(), (err) => err.code === 'SYSMON_OC_WRITE' && /授權已取消/.test(err.userMessage))
  delete process.env.FAKE_SMI_LOG
  delete process.env.FAKE_SMI_STATE
  console.log('ok NVIDIA：假 nvidia-smi＋假 pkexec 跑真腳本（-pl 256、-lgc 0,2805；還原 -rgc／-rmc／-pl 320）、參數白名單、取消授權')
}

async function testAccessRule() {
  const text = ruleText(1000)
  assert.match(text, /SUBSYSTEM=="hwmon".*power\[0-9\]_cap/)
  assert.match(text, /DRIVERS=="amdgpu".*pp_od_clk_voltage power_dpm_force_performance_level/)
  assert.match(text, /scaling_max_freq scaling_governor energy_performance_preference/)
  assert.match(text, /intel_pstate\/no_turbo .*cpufreq\/boost/)
  assert.match(text, /constraint_\[0-9\]_power_limit_uw/)
  assert.doesNotMatch(text, /energy_uj/, '不放寬 RAPL 計數器（Platypus 旁路）')
  assert.throws(() => ruleText('1000; rm -rf /'))
  const calls = []
  const access = createOcAccess({
    spawnFn: (bin, args) => { calls.push([bin, args]); const { EventEmitter } = require('events'); const c = new EventEmitter(); setImmediate(() => c.emit('close', 0)); return c },
    exists: (p) => p === '/usr/bin/pkexec', uid: () => 1000, gid: () => 1234
  })
  await access.install()
  assert.equal(calls[0][0], '/usr/bin/pkexec')
  assert.equal(calls[0][1][0], '/bin/sh')
  assert.match(calls[0][1][2], /91-axondeck-oc\.rules/)
  assert.match(calls[0][1][4], /chgrp 1234/)
  const root = createOcAccess({ spawnFn: () => { throw new Error('不該叫') }, exists: () => true, uid: () => 0 })
  assert.deepEqual(await root.install(), { installed: true, already: true })
  console.log('ok 授權規則：只放寬效能調整那幾種檔案、不碰 energy_uj、gid 只收整數、root 免安裝')
}

async function testPlanRisk() {
  const risks = plan.riskyChanges([{ device: 'X', folds: [{ knobs: [
    { key: 'powerPct', value: 90, changed: true },
    { key: 'coreMHz', value: -100, changed: true },
    { key: 'voltMv', value: 0, changed: true },
    { key: 'rapl.a.0', value: 100, factory: 125, changed: true },
    { key: 'powerPct', value: 120, changed: false }
  ] }] }])
  assert.deepEqual(risks, [], '往下調都不算風險；沒動的不算')
  console.log('ok 風險判定：降牆／降頻／沒動的不需要確認')
}

;(async () => {
  testParse()
  await testScanAndKnobs()
  await testDraftConfirmApplyReset()
  await testSafeApplyAndFailures()
  await testPanicAndNoTemp()
  await testPersistAcrossRestart()
  await testOdMaskOff()
  await testLockedNeedsAuth()
  await testNvidia()
  await testAccessRule()
  await testPlanRisk()
  console.log('test-sysmon-oc-linux: all passed')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
