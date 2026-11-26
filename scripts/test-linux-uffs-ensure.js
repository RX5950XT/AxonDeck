#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const uffs = require('../src/main/explorer/uffs')

const dir = tempDir('linux-uffs-ensure-')
;(async () => {
  try {
    uffs.configure(dir)
    const st = await uffs.status()
    assert.equal(st.mode, 'folder')
    assert.equal(st.unsupported, false)
    assert.doesNotMatch(String(st.message || ''), /僅支援 Windows/)

    const downloaded = await uffs.download()
    assert.equal(downloaded.unsupported, false)
    assert.doesNotMatch(String(downloaded.message || ''), /僅支援 Windows/)

    const ensured = await uffs.ensureReady({ auto: false })
    assert.equal(ensured.unsupported, false)
    assert.doesNotMatch(String(ensured.message || ''), /僅支援 Windows|資料夾內篩選/)

    const src = fs.readFileSync(path.join(__dirname, '../src/main/explorer/uffs.js'), 'utf8')
    assert.match(src, /if \(platform\.isLinux\) \{\n    if \(inTempUserData\(\)\) return status\(\)\n    return linuxMachine\(\)\.ensure/s)
    assert.match(src, /async function download\(onProgress\) \{\n  if \(platform\.isLinux\)/s)
    assert.match(src, /async function installBroker\(\) \{\n  if \(platform\.isLinux\) return/)
    assert.doesNotMatch(src, /目前僅支援 Windows；Linux 請用資料夾內篩選/)

    const page = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/explorer-page.js'), 'utf8')
    assert.doesNotMatch(page, /整機搜尋僅支援 Windows/)
    assert.match(page, /整機搜尋尚未就緒/)
    console.log('PASS Linux UFFS install／ensure 走整機索引路徑，不再丟 Windows 錯誤')
  } finally {
    removeTree(dir)
  }
})().catch((err) => {
  removeTree(dir)
  console.error(err)
  process.exit(1)
})
