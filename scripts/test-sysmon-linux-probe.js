'use strict'

const assert = require('node:assert/strict')
const metrics = require('../src/main/sysmon/metrics')
const probe = require('../src/main/sysmon/linux-probe')
const { tempDir } = require('./lib/test-temp')

if (process.platform !== 'linux') {
  console.log('SKIP sysmon linux-probe（非 Linux）')
  process.exit(0)
}

{
  const st = probe.parseProcStat('1 (systemd) S 0 1 1 0 -1 4194560 1 0 0 0 10 20 0 0 20 0 1 0 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')
  assert.equal(st.pid, 1)
  assert.equal(st.name, 'systemd')
  assert.equal(st.utime, 10)
  assert.equal(st.stime, 20)
}

{
  const rows = probe.collectTickRows()
  assert.ok(rows.some((r) => r.startsWith('T|')))
  assert.ok(rows.some((r) => r.startsWith('M|')))
  assert.ok(rows.some((r) => r.startsWith('P|')))
  const tick = metrics.parseTick(rows)
  assert.ok(tick.tMs > 0)
  assert.ok(tick.memory.available > 0)
  assert.ok(tick.procs.length > 0)
  // 第二輪差值：CPU% 應可算
  const again = metrics.parseTick(probe.collectTickRows())
  const diff = metrics.diffSamples(tick, again, require('os').cpus().length)
  assert.ok(Array.isArray(diff.processes))
  assert.ok(diff.memory)
  assert.ok(tick.disks.length >= 1 && /^\d+ /.test(tick.disks[0].name), '磁碟名應為「序號 裝置」')
  assert.ok(diff.disks.every((d) => Number.isFinite(d.busy)), 'io_ticks 應能算出 busy%')
  assert.ok(tick.nets.length >= 1)
}

{
  const rows = probe.collectStaticRows()
  const st = metrics.parseStatic(rows)
  assert.ok(st.cpus.length >= 1)
  assert.ok(st.os?.caption)
  assert.ok(st.system?.hostname || st.system?.totalMemory >= 0)
  assert.ok(st.physicalDisks.length >= 1, '應有 PDISK')
  assert.ok(/^\d+$/.test(st.physicalDisks[0].id))
  assert.ok(st.nics.some((n) => n.name), 'NIC 應有 name 欄')
}

{
  const out = probe.handleCommand('static 7')
  assert.match(out, /#B static 7/)
  assert.match(out, /#E static 7/)
  assert.match(out, /^CPU\|/m)
}

{
  const child = probe.createLinuxProbeChild()
  let buf = ''
  child.stdout.on('data', (c) => { buf += c })
  // READY 是 queueMicrotask
  setTimeout(() => {
    assert.match(buf, /#READY/)
    child.stdin.write('tick 3\n')
    setTimeout(() => {
      assert.match(buf, /#B tick 3/)
      assert.match(buf, /#E tick 3/)
      child.kill()
      console.log('PASS linux-probe tick／static／假 child 協定')
    }, 50)
  }, 20)
}

{
  // GPU：這台可能沒有顯示卡，但靜態清單必須結束（platform=linux），不能讓 UI 永遠「偵測中」
  const st = metrics.parseStatic(probe.collectStaticRows())
  assert.equal(st.platform, 'linux')
  assert.ok(Array.isArray(st.gpus))
  // 假 PCI 樹：一張 Intel VGA
  const tmp = tempDir('axd-gpu-')
  const slot = '0000:00:02.0'
  const pci = require('path').join(tmp, 'sys/bus/pci/devices', slot)
  const drm = require('path').join(tmp, 'sys/class/drm/card0')
  require('fs').mkdirSync(pci, { recursive: true })
  require('fs').mkdirSync(drm, { recursive: true })
  require('fs').writeFileSync(require('path').join(pci, 'class'), '0x030000\n')
  require('fs').writeFileSync(require('path').join(pci, 'vendor'), '0x8086\n')
  require('fs').writeFileSync(require('path').join(pci, 'device'), '0x46a6\n')
  require('fs').symlinkSync(pci, require('path').join(drm, 'device'))
  const fakeExec = (cmd, args) => {
    if (cmd === 'lspci') return '"VGA compatible controller [0300]" "Intel Corporation [8086]" "Alder Lake-P GT2 [46a6]" "-"\n'
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const rows = probe.drmGpuRows({ root: tmp, execFn: fakeExec })
  assert.equal(rows.length, 1)
  assert.match(rows[0], /^GPU\|Intel Corporation Alder Lake-P GT2\|/)
  assert.match(rows[0], /sysfs（\/sys\/class\/drm）＋lspci$/)
  const parsed = metrics.parseStatic(rows)
  assert.equal(parsed.gpus[0].source.includes('sysfs'), true)
  assert.equal(parsed.gpus[0].mode, 'card0')
  
  console.log('PASS GPU：platform=linux、sysfs／lspci 假樹可解析、無顯示卡時 gpus=[]（UI 顯示「未偵測到」）')
}
