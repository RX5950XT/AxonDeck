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

{
  // 主機板：假 /sys/class/dmi/id；序號檔讀不到（要 root）要明講，不是空白
  const fs = require('fs')
  const path = require('path')
  const tmp = tempDir('axd-dmi-')
  const id = path.join(tmp, 'sys/class/dmi/id')
  fs.mkdirSync(id, { recursive: true })
  const vals = { board_vendor: 'ASUSTeK COMPUTER INC.', board_name: 'ROG STRIX B650-A', board_version: 'Rev 1.xx', bios_vendor: 'American Megatrends Inc.', bios_version: '3201', bios_date: '01/15/2024', sys_vendor: 'ASUS', product_name: 'System Product Name' }
  for (const [k, v] of Object.entries(vals)) fs.writeFileSync(path.join(id, k), `${v}\n`)
  fs.writeFileSync(path.join(id, 'board_serial'), 'SECRET\n', { mode: 0o000 })
  const dmi = probe.dmiRows(tmp)
  const st = metrics.parseStatic(dmi.rows)
  assert.equal(st.board.vendor, 'ASUSTeK COMPUTER INC.')
  assert.equal(st.board.product, 'ROG STRIX B650-A')
  assert.equal(st.bios.version, '3201')
  assert.equal(st.bios.releaseDate, '01/15/2024')
  assert.equal(dmi.product, 'System Product Name')
  if (process.getuid && process.getuid() !== 0) assert.equal(st.board.serial, '需要 root 權限')
  // 沒有 DMI 目錄：不丟錯、沒有 BOARD／BIOS 列（UI 走「無法讀取 DMI」終態）
  const none = probe.dmiRows(path.join(tmp, 'nope'))
  assert.deepEqual(none.rows, [])
  assert.equal(none.hasDmi, false)
  console.log('PASS 主機板：DMI 板子／BIOS／系統、root 限定欄位標示、沒有 DMI 也有終態')
}

{
  // 系統卡：Linux 的 OS／主機名稱／時區欄位要有值（renderer 改列發行版、核心，不列 Windows 目錄）
  const st = metrics.parseStatic(probe.collectStaticRows())
  assert.ok(st.os.caption)
  assert.equal(st.os.build, require('os').release(), 'build＝核心版本')
  assert.ok(st.os.systemDrive.startsWith('/'), '根目錄')
  assert.equal(st.os.windowsDir, '')
  assert.equal(st.system.hostname, require('os').hostname())
  assert.ok(st.timeZone?.caption, '時區')
  console.log(`PASS 系統：${st.os.caption}、核心 ${st.os.build}、${st.system.hostname}、${st.timeZone.caption}`)
}
