'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const shellLinux = require('../src/main/explorer/shell-linux')
const { tempDir, removeTree } = require('./lib/test-temp')

async function main() {
  const dir = tempDir('axondeck-shell-linux-')
  const file = path.join(dir, 'sample.txt')
  fs.writeFileSync(file, 'ok')

  const empty = await shellLinux.menu({ paths: [] })
  assert.equal(empty.token, 0)
  assert.deepEqual(empty.items, [])

  const menu = await shellLinux.menu({ paths: [file] })
  assert.ok(menu.token > 0)
  assert.ok(menu.items.some((i) => i.verb === 'defaultapp'))
  assert.ok(menu.items.some((i) => i.verb === 'reveal'))
  // 避開 App 已過濾的「開啟」標籤
  assert.ok(!menu.items.some((i) => i.label === '開啟'))

  await shellLinux.release(menu.token)
  shellLinux.shutdown()

  // facade：Linux 應走 shell-linux，不碰 COM
  const shell = require('../src/main/explorer/shell')
  const via = await shell.menu({ paths: [file] })
  assert.ok(via.token > 0)
  assert.ok(via.items.length >= 1)
  await shell.release(via.token)
  shell.shutdown()

  removeTree(dir)
  console.log('PASS: Linux 最小殼層選單')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
