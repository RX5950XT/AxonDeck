'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const search = require('../src/main/workspace/search')
const { tempDir, removeTree } = require('./lib/test-temp')

async function main() {
  const root = tempDir('search-cancel-')
  try {
    fs.writeFileSync(path.join(root, 'lines.txt'), 'First NEEDLE\r\nsecond needle\n最後 needle')
    const outdated = search.search(root, 'first')
    const latest = search.search(root, 'needle')
    const [old, found] = await Promise.all([outdated, latest])
    assert.equal(old.cancelled, true, '新版查詢須停止舊搜尋，不繼續讀檔')
    assert.equal(old.scanned, 0)
    assert.deepEqual(found.hits.map(hit => [hit.line, hit.text]), [
      [1, 'First NEEDLE'], [2, 'second needle'], [3, '最後 needle']
    ])
    const cased = await search.search(root, 'NEEDLE', true)
    assert.equal(cased.hits.length, 1)
    fs.writeFileSync(path.join(root, 'boundary.txt'), 'x'.repeat(65535) + '中needle\n' + 'tail NEEDLE')
    fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.concat([
      Buffer.from('needle\n' + 'x'.repeat(70000)), Buffer.from([0])
    ]))
    const boundary = await search.search(root, '中needle')
    assert.equal(boundary.hits[0].line, 1)
    assert(boundary.hits[0].text.includes('中needle'), '跨讀取區塊的中文不可切壞')
    const binary = await search.search(root, 'needle')
    assert(!binary.hits.some(hit => hit.rel === 'binary.dat'), '後面才出現 NUL 的二進位檔也不能列前面的命中')
    console.log('PASS: 舊查詢停止讀檔、逐行比對保留大小寫／CRLF／末行')
  } finally { removeTree(root) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
