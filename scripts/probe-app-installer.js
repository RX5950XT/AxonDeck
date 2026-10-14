'use strict'
// 真實唯讀探針：不安裝、不更新、不解除安裝。
const assert = require('assert/strict')
const { createInstaller } = require('../src/main/app-installer')
const { tempDir } = require('./lib/test-temp')
async function main() {
  const service = createInstaller({ cacheDir: tempDir('installer-probe-'), iconPaths: async () => () => [] })
  const snapshot = await service.refresh()
  assert.ok(snapshot.checkedAt)
  assert.equal(snapshot.catalog.length, 20)
  assert.ok(snapshot.installed.every((row) => row.id && row.name && row.version))
  assert.equal(new Set(snapshot.installed.map((row) => row.key)).size, snapshot.installed.length)
  console.log(JSON.stringify({ installed: snapshot.installed.length, updates: snapshot.installed.filter((row) => row.canUpgrade).length,
    catalog: snapshot.catalog.map((row) => ({ name: row.name, installed: row.installedKeys.length, latest: row.latest, error: row.sourceError })) }, null, 2))
}
main().catch((error) => { console.error(error.userMessage || error.message); process.exitCode = 1 })
