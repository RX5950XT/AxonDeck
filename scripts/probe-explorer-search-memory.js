'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const uffs = require('../src/main/explorer/uffs')

function memory() {
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-Process uffsd -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true }).trim()
  const rows = raw ? JSON.parse(raw) : []
  return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.Id,
    rssMiB: Math.round(row.WorkingSet64 / 1048576), privateMiB: Math.round(row.PrivateMemorySize64 / 1048576) }))
}

async function settledMemory(loaded) {
  let rows = memory()
  for (let i = 0; i < 35 && rows[0].privateMiB >= loaded[0].privateMiB / 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    rows = memory()
  }
  return rows
}

async function main() {
  uffs.configure(process.env.AXONDECK_USER_DATA || path.join(process.env.APPDATA, 'voiceink'))
  const initial = await uffs.status()
  assert(initial.installed && initial.broker.installed, '需要已安裝 UFFS／broker，探針不裝工具或跳 UAC')
  assert(!initial.daemon.running, '現有 daemon 正在使用，不碰；待其自行結束再驗')
  const started = Date.now()
  let peakRssMiB = 0
  const timer = setInterval(() => {
    for (const row of memory()) peakRssMiB = Math.max(peakRssMiB, row.rssMiB)
  }, 1000)
  try {
    const first = await uffs.search('test-sysmon-hotfix-date.js')
    assert(first.hits.length > 0 && !first.warming)
    const loaded = memory()
    await uffs.releaseMemory()
    const sleeping = await settledMemory(loaded)
    const second = await uffs.search('test-sysmon-hotfix-date.js')
    assert.deepEqual(second.hits.map(hit => hit.path).sort(), first.hits.map(hit => hit.path).sort())
    const reloaded = memory()
    await uffs.shutdown()
    const final = await settledMemory(reloaded)
    console.log(JSON.stringify({ ms: Date.now() - started, peakRssMiB, loaded, sleeping, reloaded, final, hits: second.hits.length }))
    assert(sleeping[0].privateMiB < loaded[0].privateMiB / 2 && final[0].privateMiB < reloaded[0].privateMiB / 2,
      '休眠後須真正釋放索引，不只把工作集移到磁碟')
    console.log('PASS: 真 MFT 搜尋 → 索引休眠釋放 RAM → 原快取恢復搜尋且命中一致')
  } finally { clearInterval(timer) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
