'use strict'

const assert = require('node:assert/strict')
const metrics = require('../src/main/sysmon/metrics')
const probe = require('../src/main/sysmon/linux-probe')

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
