'use strict'

/**
 * Miroxen 引擎更新的真流量檢查：讀 GitHub latest release，確認兩個資產都在、digest 格式對，
 * 再驗版本比較。不下載、不碰 userData。
 *
 *     node scripts/probe-miroxen.js
 */

const assert = require('assert')
const runtime = require('../src/main/miroxen/runtime')

assert.equal(runtime.isNewer('v0.2.0', 'v0.1.9'), true)
assert.equal(runtime.isNewer('v0.1.10', 'v0.1.9'), true)
assert.equal(runtime.isNewer('v0.1.0', 'v0.1.0'), false)
assert.equal(runtime.isNewer('v0.1.0', ''), true)
assert.equal(runtime.isNewer('bad', 'v0.1.0'), false)
assert.throws(() => runtime.parseRelease({ tag_name: 'v1.0.0', assets: [] }))
assert.throws(() => runtime.parseRelease({ tag_name: 'v1.0.0', assets: [
  { name: 'miroxen-win-x64.zip', size: 1, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: 'https://evil.example/x.zip' },
  { name: 'miroxen-deps-win-x64.zip', size: 1, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `https://github.com/${runtime.REPO}/releases/download/v1.0.0/miroxen-deps-win-x64.zip` }
] }))

runtime.latestRelease({ force: true }).then((release) => {
  for (const [name, asset] of Object.entries(release.assets)) {
    console.log(`[probe-miroxen] ${release.tag} ${name} ${(asset.size / 1e6).toFixed(1)} MB sha256:${asset.sha256.slice(0, 12)}…`)
  }
  console.log('[probe-miroxen] 通過')
}).catch((error) => {
  console.error(`[probe-miroxen] 失敗：${error.message}`)
  process.exit(1)
})
