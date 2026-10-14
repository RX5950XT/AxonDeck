#!/usr/bin/env node

'use strict'

// 清單的資料夾大小：scan 算子資料夾、listDir 帶 dirSizes 才套進 size 並照大小排序
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const dirSizes = require(path.join(ROOT, 'src/main/explorer/dir-sizes.js'))
const files = require(path.join(ROOT, 'src/main/explorer/fs.js'))

async function main() {
  const root = tempDir('vi-ex-dir-sizes-')
  try {
    for (const [name, bytes] of [['small', 10], ['big', 5000], ['mid', 300]]) {
      fs.mkdirSync(path.join(root, name, 'deep'), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'deep', 'a.bin'), Buffer.alloc(bytes))
    }
    fs.writeFileSync(path.join(root, 'file.bin'), Buffer.alloc(1))

    const events = []
    const result = await dirSizes.scan(root, 'main', { onProgress: (info) => events.push(info) })
    assert.equal(result.cancelled, false)
    assert.equal(events.filter((e) => !e.done).length, 3, '三個子資料夾各報一次')
    assert.equal(events.at(-1).done, true)

    const plain = await files.listDir(root, { sort: 'size', desc: true })
    assert.ok(plain.entries.filter((e) => e.dir).every((e) => e.size === 0), '沒帶 dirSizes 不套')

    const sized = await files.listDir(root, { sort: 'size', desc: true, dirSizes: true })
    assert.deepEqual(sized.entries.map((e) => e.name), ['big', 'mid', 'small', 'file.bin'])
    assert.equal(sized.entries[0].size, 5000)
    assert.equal(sized.entries[0].sizeIncomplete, false)

    const cancelled = dirSizes.scan(root, 'second', { onProgress: () => {} })
    dirSizes.cancel('second')
    assert.equal((await cancelled).cancelled, true, 'cancel 要停掉那條 lane')
  } finally {
    removeTree(root)
  }
  console.log('PASS explorer folder sizes scan and sort')
}

main().catch((error) => {
  console.error(`FAIL ${error.stack || error.message}`)
  process.exitCode = 1
})
