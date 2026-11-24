#!/usr/bin/env node
'use strict'

/** Linux：工作區「本機埠」改讀 /proc/net/tcp*＋/proc/<pid>/fd（不跑 netstat.exe／tasklist.exe）。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const ports = require('../src/main/workspace/ports')

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const row = (sl, local, st, inode) => `   ${sl}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`

async function main() {
  // 0x1435=5173 本機 0.0.0.0、0x0BB8=3000 127.0.0.1、0x1F90=8080 只聽區網位址、0x22B8=8888 不是 LISTEN
  const tcp = [HEAD,
    row(0, '00000000:1435', '0A', '111'),
    row(1, '0100007F:0BB8', '0A', '222'),
    row(2, '0A01A8C0:1F90', '0A', '333'),
    row(3, '0100007F:22B8', '01', '444')].join('\n')
  const tcp6 = [HEAD,
    row(0, '00000000000000000000000001000000:0BB8', '0A', '555'),
    row(1, '00000000000000000000000000000000:2328', '0A', '666')].join('\n')

  const parsed = ports.parseProcNet(tcp)
  assert.deepEqual([...parsed.entries()], [[5173, '111'], [3000, '222']], '只留本機位址的 LISTEN')
  assert.deepEqual([...ports.parseProcNet(tcp6).keys()], [3000, 9000], 'IPv6 :: 與 ::1')

  const root = tempDir('ports-linux-')
  try {
    fs.mkdirSync(path.join(root, 'net'), { recursive: true })
    fs.writeFileSync(path.join(root, 'net/tcp'), tcp)
    fs.writeFileSync(path.join(root, 'net/tcp6'), tcp6)
    const proc = (pid, comm, links) => {
      fs.mkdirSync(path.join(root, String(pid), 'fd'), { recursive: true })
      fs.writeFileSync(path.join(root, String(pid), 'comm'), `${comm}\n`)
      links.forEach((link, i) => fs.symlinkSync(link, path.join(root, String(pid), 'fd', String(i + 3))))
    }
    proc(4100, 'node', ['socket:[111]', '/dev/null'])
    proc(4200, 'python3', ['pipe:[9]', 'socket:[222]'])
    // 666 沒有對應程序（別的使用者的）：照樣列出，PID 0
    const { ports: found, names } = await ports.linuxListening(root)
    assert.deepEqual([...found.entries()].sort((a, b) => a[0] - b[0]), [[3000, 4200], [5173, 4100], [9000, 0]])
    assert.equal(names.get(4100), 'node')
    assert.equal(names.get(4200), 'python3')
    // 沒有 /proc（容器或權限）就回空，不丟例外
    const empty = await ports.linuxListening(path.join(root, 'missing'))
    assert.equal(empty.ports.size, 0)
  } finally {
    removeTree(root)
  }
  console.log('test-workspace-ports-linux: all passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
