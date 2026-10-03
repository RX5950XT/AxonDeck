'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const search = require('../src/main/workspace/search')
const mib = (bytes) => Math.round(bytes / 1048576 * 10) / 10

async function measure(root, query) {
  global.gc()
  const before = process.memoryUsage()
  const started = Date.now()
  let peak = before.rss
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
  const rows = []
  try {
    for (let i = 0; i < 3; i++) {
      const result = await search.search(root, query, false)
      rows.push({ scanned: result.scanned, hits: result.hits.length, truncated: result.truncated })
      peak = Math.max(peak, process.memoryUsage().rss)
    }
  } finally { clearInterval(timer) }
  const after = process.memoryUsage()
  global.gc()
  const released = process.memoryUsage()
  console.log(JSON.stringify({ scenario: process.argv[4], ms: Date.now() - started, rows,
    baselineRssMiB: mib(before.rss), peakRssMiB: mib(peak), highWaterRssMiB: mib(process.resourceUsage().maxRSS * 1024),
    beforeHeapMiB: mib(before.heapUsed), afterHeapMiB: mib(after.heapUsed), afterGcHeapMiB: mib(released.heapUsed) }))
}

if (process.argv[2]) {
  measure(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const fixture = tempDir('search-memory-')
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(fixture, `${i}.txt`), 'needle-only-first-line\n' + 'x\n'.repeat(450000))
  for (const [root, query, scenario] of [
    [path.join(__dirname, '..'), 'unlikely-probe-needle-917219', '本專案無命中'],
    [fixture, 'needle-only-first-line', '20 個接近 1MB／45 萬行檔案']
  ]) {
    const res = spawnSync(process.execPath, ['--expose-gc', __filename, root, query, scenario], { encoding: 'utf8', windowsHide: true })
    process.stdout.write(res.stdout); process.stderr.write(res.stderr)
    if (res.status) process.exitCode = res.status
  }
}
