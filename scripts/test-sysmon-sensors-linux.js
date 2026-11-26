'use strict'

/**
 * Linux 感測器橋接（hwmon／thermal／RAPL）＋風扇寫入＋授權流程。
 * 用假的 sysfs 樹跑，不碰真的 /sys（這台測試機本來就沒有 hwmon）。
 * 用法：node scripts/test-sysmon-sensors-linux.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { tempDir } = require('./lib/test-temp')
const hw = require('../src/main/sysmon/hwmon-linux')
const { createLinuxSensorBridge, OC_REASON } = require('../src/main/sysmon/sensors-linux')
const { createFanAccess, ruleText } = require('../src/main/sysmon/fan-access-linux')
const { createFanEngine, readSource } = require('../src/main/sysmon/fans')

function put(root, rel, text, mode) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, String(text))
  if (mode) fs.chmodSync(file, mode)
  return file
}

/** 一台「桌機」：k10temp、nct6798（兩條 PWM，一條唯讀）、amdgpu、nvme、x86_pkg_temp、RAPL */
function buildFakeSys(writablePwm = true) {
  const sys = tempDir('sysfs-')
  const proc = tempDir('proc-')
  put(proc, 'cpuinfo', 'processor\t: 0\nmodel name\t: AMD Ryzen 7 5700X 8-Core Processor\n')
  put(proc, 'stat', 'cpu  100 0 100 800 0 0 0 0 0 0\n')
  // CPU
  put(sys, 'class/hwmon/hwmon0/name', 'k10temp\n')
  put(sys, 'class/hwmon/hwmon0/temp1_input', '52250\n')
  put(sys, 'class/hwmon/hwmon0/temp1_label', 'Tctl\n')
  put(sys, 'class/hwmon/hwmon0/temp3_input', '48000\n')
  put(sys, 'class/hwmon/hwmon0/temp3_label', 'Tccd1\n')
  // SuperIO：pwm1 可寫、pwm2 唯讀（模擬沒授權）
  put(sys, 'class/hwmon/hwmon1/name', 'nct6798\n')
  put(sys, 'class/hwmon/hwmon1/fan1_input', '1180\n')
  put(sys, 'class/hwmon/hwmon1/fan2_input', '760\n')
  put(sys, 'class/hwmon/hwmon1/in0_input', '1104\n')
  put(sys, 'class/hwmon/hwmon1/temp1_input', '36000\n')
  put(sys, 'class/hwmon/hwmon1/temp1_label', 'SYSTIN\n')
  put(sys, 'class/hwmon/hwmon1/pwm1', '128\n', writablePwm ? 0o644 : 0o444)
  put(sys, 'class/hwmon/hwmon1/pwm1_enable', '5\n', writablePwm ? 0o644 : 0o444)
  put(sys, 'class/hwmon/hwmon1/pwm2', '100\n', 0o444)
  put(sys, 'class/hwmon/hwmon1/pwm2_enable', '2\n', 0o444)
  // AMD GPU
  put(sys, 'class/hwmon/hwmon2/name', 'amdgpu\n')
  put(sys, 'class/hwmon/hwmon2/temp1_input', '61000\n')
  put(sys, 'class/hwmon/hwmon2/temp1_label', 'edge\n')
  put(sys, 'class/hwmon/hwmon2/temp2_input', '70000\n')
  put(sys, 'class/hwmon/hwmon2/temp2_label', 'junction\n')
  put(sys, 'class/hwmon/hwmon2/power1_average', '145000000\n')
  put(sys, 'class/hwmon/hwmon2/freq1_input', '2400000000\n')
  put(sys, 'class/hwmon/hwmon2/freq1_label', 'sclk\n')
  put(sys, 'class/hwmon/hwmon2/fan1_input', '1500\n')
  put(sys, 'class/hwmon/hwmon2/pwm1', '90\n', writablePwm ? 0o644 : 0o444)
  put(sys, 'class/hwmon/hwmon2/pwm1_enable', '2\n', writablePwm ? 0o644 : 0o444)
  put(sys, 'devices/pci0000:00/0000:03:00.0/gpu_busy_percent', '37\n')
  fs.symlinkSync(path.join(sys, 'devices/pci0000:00/0000:03:00.0'), path.join(sys, 'class/hwmon/hwmon2/device'))
  // NVMe
  put(sys, 'class/hwmon/hwmon3/name', 'nvme\n')
  put(sys, 'class/hwmon/hwmon3/temp1_input', '41850\n')
  put(sys, 'class/hwmon/hwmon3/temp1_label', 'Composite\n')
  // thermal：x86_pkg_temp 進 CPU；acpitz 已有同名 hwmon → 不重複
  put(sys, 'class/hwmon/hwmon4/name', 'acpitz\n')
  put(sys, 'class/hwmon/hwmon4/temp1_input', '27800\n')
  put(sys, 'class/thermal/thermal_zone0/type', 'acpitz\n')
  put(sys, 'class/thermal/thermal_zone0/temp', '27800\n')
  put(sys, 'class/thermal/thermal_zone1/type', 'x86_pkg_temp\n')
  put(sys, 'class/thermal/thermal_zone1/temp', '55000\n')
  // RAPL 計數器（微焦耳）
  put(sys, 'class/powercap/intel-rapl:0/name', 'package-0\n')
  put(sys, 'class/powercap/intel-rapl:0/energy_uj', '1000000\n')
  // 每核時脈
  put(sys, 'devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', '3400000\n')
  put(sys, 'devices/system/cpu/cpu1/cpufreq/scaling_cur_freq', '4650000\n')
  return { sys, proc }
}

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

const noAccess = { status: () => ({ manual: true, installed: false, canInstall: false }), install: async () => ({}), remove: async () => ({}) }

async function testClassifyAndLabels() {
  assert.equal(hw.classify(hw.CHIP_TYPES, 'k10temp', 'x'), 'Cpu')
  assert.equal(hw.classify(hw.CHIP_TYPES, 'coretemp', 'x'), 'Cpu')
  assert.equal(hw.classify(hw.CHIP_TYPES, 'amdgpu', 'x'), 'GpuAmd')
  assert.equal(hw.classify(hw.CHIP_TYPES, 'nvme', 'x'), 'Storage')
  assert.equal(hw.classify(hw.CHIP_TYPES, 'nct6798', 'x'), 'SuperIO')
  assert.equal(hw.classify(hw.CHIP_TYPES, 'it8688', 'x'), 'SuperIO')
  assert.equal(hw.classify(hw.CHIP_TYPES, 'BAT0', 'x'), 'Battery')
  assert.equal(hw.classify(hw.CHIP_TYPES, 'mystery', 'Motherboard'), 'Motherboard')
  const st = hw.parseCpuStat('cpu  10 0 10 80 0 0 0 0\ncpu0 1 1 1 1')
  assert.deepEqual(st, { busy: 20, total: 100 })
  assert.equal(hw.safeId('nct 6798@hwmon1'), 'nct_6798@hwmon1')
  console.log('ok classify／labels／parseCpuStat')
}

async function testReadFrame() {
  const { sys, proc } = buildFakeSys(true)
  const clock = fakeClock()
  const bridge = createLinuxSensorBridge({ sysfsRoot: sys, procRoot: proc, now: clock.now, tickMs: 60_000, access: noAccess })
  const res = await bridge.enable()
  assert.equal(res.state, 'on')
  // 第二輪：/proc/stat 與 RAPL 有差值才算得出使用率與功耗
  put(proc, 'stat', 'cpu  150 0 150 900 0 0 0 0 0 0\n')
  put(sys, 'class/powercap/intel-rapl:0/energy_uj', '66000000\n') // 65 J／1 s ＝ 65 W
  clock.advance(1000)
  await bridge._tick()
  const data = bridge.read()
  assert.equal(data.available, true)
  const cpu = data.groups.find((g) => g.t === 'Cpu')
  assert.equal(cpu.n, 'AMD Ryzen 7 5700X 8-Core Processor')
  const find = (g, t, n) => g.s.find((s) => s.t === t && s.n === n)?.v
  assert.equal(find(cpu, 'Temperature', 'Tctl'), 52.25)
  assert.equal(find(cpu, 'Temperature', 'Package'), 55, 'x86_pkg_temp 併進 CPU')
  assert.equal(find(cpu, 'Load', 'CPU Total'), 50, '(100 busy / 200 total)')
  assert.equal(find(cpu, 'Power', 'Package'), 65, 'RAPL 微焦耳差值換算瓦')
  assert.equal(find(cpu, 'Clock', 'Core #2'), 4650)
  const gpu = data.groups.find((g) => g.t === 'GpuAmd')
  assert.match(gpu.n, /AMD Radeon \(0000:03:00\.0\)/)
  assert.equal(find(gpu, 'Temperature', 'GPU Core'), 61)
  assert.equal(find(gpu, 'Temperature', 'GPU Hot Spot'), 70)
  assert.equal(find(gpu, 'Power', 'Power #1'), 145)
  assert.equal(find(gpu, 'Clock', 'GPU Core'), 2400)
  assert.equal(find(gpu, 'Load', 'GPU Core'), 37)
  assert.equal(find(gpu, 'Fan', 'GPU Fan'), 1500)
  const sio = data.groups.find((g) => g.t === 'SuperIO')
  assert.equal(find(sio, 'Fan', 'Fan #1'), 1180)
  assert.equal(find(sio, 'Voltage', 'Voltage #0'), 1.104)
  const nvme = data.groups.find((g) => g.t === 'Storage')
  assert.equal(find(nvme, 'Temperature', 'Composite'), 41.85)
  assert.equal(data.groups.filter((g) => /acpitz/.test(g.n) && g.t === 'Motherboard').length, 1)
  // 風扇引擎的來源：cpu-temp 挑 Tctl、gpu-temp 挑 GPU Core、nvme-temp、board-temp
  assert.equal(readSource(data.groups, 'cpu-temp'), 52.25)
  assert.equal(readSource(data.groups, 'cpu-load'), 50)
  assert.equal(readSource(data.groups, 'gpu-temp'), 61)
  assert.equal(readSource(data.groups, 'nvme-temp'), 41.85)
  assert.equal(readSource(data.groups, 'board-temp'), 36)
  // 可控通道：只列可寫的（pwm2 唯讀不列）
  assert.deepEqual(data.controls.map((c) => c.id).sort(), ['amdgpu@0000:03:00.0/pwm1', 'nct6798@hwmon1/pwm1'])
  const sioCtl = data.controls.find((c) => c.id === 'nct6798@hwmon1/pwm1')
  assert.equal(sioCtl.rpm, 1180)
  assert.equal(Math.round(sioCtl.pwm), 50)
  // 效能調整：只讀＋原因
  assert.equal(data.oc.c.w, 0)
  assert.equal(data.oc.c.r, OC_REASON)
  assert.equal(data.oc.gs[0].t, 61)
  // 不支援的指令不假裝送出去
  assert.equal(bridge.send('G 100 0 100'), false)
  assert.equal(bridge.send('X'), false)
  await bridge.stop()
  assert.equal(bridge.read().available, false)
  console.log('ok 讀數：CPU／GPU／SuperIO／NVMe／thermal／RAPL＋風扇來源＋只讀超頻')
}

async function testWriteRestoreWatchdog() {
  const { sys, proc } = buildFakeSys(true)
  const clock = fakeClock()
  const bridge = createLinuxSensorBridge({ sysfsRoot: sys, procRoot: proc, now: clock.now, tickMs: 60_000, watchdogMs: 5000, access: noAccess })
  await bridge.enable()
  const pwm = path.join(sys, 'class/hwmon/hwmon1/pwm1')
  const en = `${pwm}_enable`
  const id = 'nct6798@hwmon1/pwm1'
  assert.equal(bridge.send(`S ${id} 40`), true)
  await bridge._flush()
  assert.equal(fs.readFileSync(en, 'utf8').trim(), '1', '接管＝pwm_enable 1（手動）')
  assert.equal(fs.readFileSync(pwm, 'utf8').trim(), String(Math.round(0.4 * 255)))
  await bridge._tick()
  assert.equal(bridge.read().controls.find((c) => c.id === id).o, true)
  // 唯讀通道：送不出去（root 跑測試時 0444 照樣寫得進去，略過這一條）
  if (process.getuid?.() !== 0) {
    assert.equal(bridge.send('S nct6798@hwmon1/pwm2 60'), false)
    assert.equal(fs.readFileSync(path.join(sys, 'class/hwmon/hwmon1/pwm2'), 'utf8').trim(), '100')
  }
  // D：寫回接管前的 enable（5＝SmartFan）
  assert.equal(bridge.send(`D ${id}`), true)
  await bridge._flush()
  assert.equal(fs.readFileSync(en, 'utf8').trim(), '5')
  // 看門狗：接管後 5 秒沒有任何指令 → 全部交還
  bridge.send(`S ${id} 80`)
  await bridge._flush()
  assert.equal(fs.readFileSync(en, 'utf8').trim(), '1')
  clock.advance(4000)
  await bridge._tick()
  assert.equal(fs.readFileSync(en, 'utf8').trim(), '1', '4 秒內不交還')
  clock.advance(2000)
  await bridge._tick()
  assert.equal(fs.readFileSync(en, 'utf8').trim(), '5', '超過 5 秒沒指令就交還')
  // stop() 也要交還
  bridge.send(`S ${id} 70`)
  await bridge._flush()
  await bridge.stop()
  assert.equal(fs.readFileSync(en, 'utf8').trim(), '5')
  console.log('ok 寫入 PWM／D 交還／5 秒看門狗／stop 交還')
}

async function testFanEngineEndToEnd() {
  const { sys, proc } = buildFakeSys(true)
  const clock = fakeClock()
  const bridge = createLinuxSensorBridge({ sysfsRoot: sys, procRoot: proc, now: clock.now, tickMs: 60_000, access: noAccess })
  await bridge.enable()
  const mem = new Map()
  const store = { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) }
  const fans = createFanEngine({ sensors: bridge, store })
  fans.configure({ store })
  const id = 'amdgpu@0000:03:00.0/pwm1'
  fans.setChannel(id, { mode: 'fixed', fixed: 60 })
  await fans.setEnabled(true)
  await bridge._flush()
  const pwm = path.join(sys, 'class/hwmon/hwmon2/pwm1')
  assert.equal(fs.readFileSync(pwm, 'utf8').trim(), String(Math.round(0.6 * 255)))
  assert.equal(fs.readFileSync(`${pwm}_enable`, 'utf8').trim(), '1')
  const list = fans.list()
  assert.equal(list.channels.length, 2)
  assert.equal(list.channels.find((c) => c.id === id).name, 'GPU Fan')
  fans.shutdown()
  await bridge._flush()
  assert.equal(fs.readFileSync(`${pwm}_enable`, 'utf8').trim(), '2', '關閉風扇控制交還 amdgpu 自動')
  await bridge.stop()
  console.log('ok 風扇引擎 → Linux 橋接 → sysfs 寫入與交還')
}

async function testReadOnlyAndEmpty() {
  const { sys, proc } = buildFakeSys(false)
  const bridge = createLinuxSensorBridge({ sysfsRoot: sys, procRoot: proc, tickMs: 60_000, access: noAccess })
  await bridge.enable()
  const data = bridge.read()
  assert.equal(data.available, true, '沒有寫入權限也照樣讀得到')
  assert.equal(data.controls.length, 0)
  assert.ok(data.groups.find((g) => g.t === 'Cpu'))
  await bridge.stop()
  // 完全沒有 hwmon（本測試機就是）：仍 on，附說明，不是整頁空白
  const empty = tempDir('sysfs-empty-')
  const bare = createLinuxSensorBridge({ sysfsRoot: empty, procRoot: proc, tickMs: 60_000, access: noAccess })
  await bare.enable()
  assert.equal(bare.status().state, 'on')
  assert.match(bare.status().message, /沒有公開任何溫度感測器/)
  await bare.stop()
  console.log('ok 唯讀模式／完全沒有 hwmon')
}

function fakeSpawn(code, calls) {
  return (file, args) => {
    calls.push([file, ...args])
    const child = new EventEmitter()
    setImmediate(() => child.emit('close', code))
    return child
  }
}

async function testAccess() {
  const rule = ruleText(1000)
  assert.match(rule, /SUBSYSTEM=="hwmon"/)
  assert.match(rule, /chgrp 1000 \$\$f && chmod g\+w \$\$f/)
  assert.ok(!/sudo/.test(rule))
  assert.throws(() => ruleText('1000; rm -rf /'))
  const channels = [{ writable: false }, { writable: true }]
  // 沒有 pkexec：不能裝、給手動說明
  const noPk = createFanAccess({ exists: () => false, gid: () => 1000, uid: () => 1000 })
  const s0 = noPk.status(channels)
  assert.equal(s0.manual, true)
  assert.equal(s0.canInstall, false)
  assert.match(s0.reason, /docs\/linux-sensors\.md/)
  await assert.rejects(noPk.install(), { code: 'SYSMON_FAN_NO_PKEXEC' })
  // 有 pkexec：只有按按鈕（install）才 spawn，參數是固定腳本＋規則
  const calls = []
  const has = (p) => p === '/usr/bin/pkexec'
  const ok = createFanAccess({ exists: has, gid: () => 1000, uid: () => 1000, spawnFn: fakeSpawn(0, calls) })
  const s1 = ok.status(channels)
  assert.equal(s1.canInstall, true)
  assert.equal(s1.installed, false)
  assert.equal(calls.length, 0, 'status 不碰 pkexec')
  await ok.install()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/usr/bin/pkexec')
  assert.equal(calls[0][1], '/bin/sh')
  assert.match(calls[0][3], /udevadm trigger --subsystem-match=hwmon/)
  assert.equal(calls[0][5], ruleText(1000))
  // 使用者在密碼框按取消 → 126
  const declined = createFanAccess({ exists: has, gid: () => 1000, uid: () => 1000, spawnFn: fakeSpawn(126, []) })
  await assert.rejects(declined.install(), { code: 'SYSMON_FAN_ACCESS_DECLINED' })
  // root 執行：不需要授權
  const root = createFanAccess({ exists: has, gid: () => 0, uid: () => 0, spawnFn: fakeSpawn(0, calls) })
  assert.equal(root.status(channels).canInstall, false)
  assert.deepEqual(await root.install(), { installed: true, already: true })
  // 全部可寫：視同已授權
  assert.equal(ok.status([{ writable: true }]).installed, true)
  console.log('ok 授權：pkexec 只在 install 時呼叫／取消／無 pkexec／root')
}

async function testServiceWiring() {
  if (process.platform !== 'linux') return
  const { sys, proc } = buildFakeSys(true)
  const { createSysmonService } = require('../src/main/sysmon')
  const svc = createSysmonService({
    sensorDeps: { sysfsRoot: sys, procRoot: proc, tickMs: 60_000, access: noAccess },
    ocDeps: { smiPath: '' },
    diskTreeExe: '',
    gpuDeps: { spawnFn: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {}; return c } }
  })
  const status = await svc.enableSensors()
  assert.equal(status.state, 'on')
  assert.equal(status.platform, 'linux')
  const fanList = svc.fanList()
  assert.equal(fanList.channels.length, 2)
  // 效能調整改由 oc-linux 引擎接手（細節見 test-sysmon-oc-linux.js）；這台假機器沒有 cpufreq policy／RAPL 牆／drm
  const oc = await svc.ocStatus()
  assert.equal(oc.platform, 'linux')
  assert.equal(oc.available, true)
  assert.equal(oc.live.cpu.writable, false)
  assert.match(oc.linux.cpu.reason, /cpufreq/)
  await assert.rejects(svc.ocApply(), (err) => err.code === 'SYSMON_OC_NOTHING')
  const task = svc.fanTaskStatus()
  assert.equal(task.manual, true)
  await svc.shutdown()
  console.log('ok sysmon 服務在 Linux 改用 hwmon 橋接（風扇／效能調整／授權狀態）')
}

;(async () => {
  await testClassifyAndLabels()
  await testReadFrame()
  await testWriteRestoreWatchdog()
  await testFanEngineEndToEnd()
  await testReadOnlyAndEmpty()
  await testAccess()
  await testServiceWiring()
  console.log('test-sysmon-sensors-linux: all passed')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
