#!/usr/bin/env node
'use strict'

/**
 * 檔案總管清單快取的路徑鍵：Linux 必須區分大小寫，Windows 仍不分。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const paths = require('../src/main/explorer/paths')
const files = require('../src/main/explorer/fs')

function unitKeys() {
  const unix = '/tmp/CaseDir/Foo'
  const lower = '/tmp/CaseDir/foo'
  assert.equal(paths.cacheKey(unix, 'linux'), unix)
  assert.equal(paths.cacheKey(lower, 'linux'), lower)
  assert.notEqual(paths.cacheKey(unix, 'linux'), paths.cacheKey(lower, 'linux'))
  assert.equal(paths.cacheKey(unix, 'win32'), unix.toLowerCase())
  assert.equal(paths.cacheKey(lower, 'win32'), lower.toLowerCase())
  assert.equal(paths.samePath(unix, lower, 'win32'), true)
  assert.equal(paths.samePath(unix, lower, 'linux'), false)
  assert.equal(paths.samePath(unix, unix, 'linux'), true)
  console.log('PASS cacheKey／samePath 在 Windows 合併大小寫，在 Linux 分開')
}

function posixListingSupported() {
  try {
    paths.resolveAbs('/tmp')
    return true
  } catch {
    return false
  }
}

async function listIsolation() {
  if (process.platform === 'win32') {
    console.log('SKIP Linux 大小寫並存清單（這台是 Windows）')
    return
  }
  if (!posixListingSupported()) {
    // master 的 resolveAbs 仍只收 Windows 路徑；這支測試在疊進 Linux 移植後才會走清單隔離。
    const fsSrc = fs.readFileSync(path.join(__dirname, '../src/main/explorer/fs.js'), 'utf8')
    assert.match(fsSrc, /paths\.cacheKey\(full\)/)
    assert.match(fsSrc, /listCacheKey/)
    console.log('SKIP listDir 隔離（此分支的路徑守衛還是 Windows 形狀）；已確認清單鍵改走 cacheKey')
    return
  }
  const root = tempDir('list-cache-case-')
  try {
    const upper = path.join(root, 'Foo')
    const lower = path.join(root, 'foo')
    fs.mkdirSync(upper)
    fs.mkdirSync(lower)
    fs.writeFileSync(path.join(upper, 'UPPER.txt'), 'U')
    fs.writeFileSync(path.join(lower, 'lower.txt'), 'l')
    const a = await files.listDir(upper, { showHidden: true, limit: 50 })
    const b = await files.listDir(lower, { showHidden: true, limit: 50 })
    assert.equal(a.path, upper)
    assert.equal(b.path, lower)
    assert.deepEqual(a.entries.map((e) => e.name).sort(), ['UPPER.txt'])
    assert.deepEqual(b.entries.map((e) => e.name).sort(), ['lower.txt'])
    fs.writeFileSync(path.join(upper, 'NEW.txt'), 'n')
    files.invalidateListCache(upper)
    const again = await files.listDir(upper, { showHidden: true, limit: 50 })
    assert.ok(again.entries.some((e) => e.name === 'NEW.txt'), '作廢快取後要重新讀到新檔')
    const still = await files.listDir(lower, { showHidden: true, limit: 50 })
    assert.deepEqual(still.entries.map((e) => e.name).sort(), ['lower.txt'], '作廢 Foo 不該清掉 foo 的快取')
    console.log('PASS Linux 清單快取把 Foo 與 foo 分開，作廢也只清對應路徑')
  } finally {
    removeTree(root)
  }
}

async function main() {
  unitKeys()
  await listIsolation()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
