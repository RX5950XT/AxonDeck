'use strict'

/**
 * Linux 發行流程的靜態檢查（不打包、不打 GitHub）：
 * - workflow 觸發條件、只上傳 Linux 兩個檔、不建 Release、不 --draft
 * - scripts/release-linux.js 的資產清單／gh 參數／latest-linux.yml 版號解析
 *
 * 用法：node scripts/test-release-linux.js
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { linuxAssets, uploadArgs, manifestVersion } = require('./release-linux')

const ROOT = path.join(__dirname, '..')
let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}

const wfText = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-linux.yml'), 'utf8')
const wf = yaml.load(wfText)
const pkg = require(path.join(ROOT, 'package.json'))

check('workflow：release published＋workflow_dispatch（要 tag 輸入）', () => {
  assert.deepStrictEqual(wf.on.release.types, ['published'])
  assert.strictEqual(wf.on.workflow_dispatch.inputs.tag.required, true)
  assert.ok(!wf.on.push, 'tag push 時 Release 還不存在，不該用 push 觸發')
})

check('workflow：ubuntu、contents: write、checkout 到 tag', () => {
  const job = wf.jobs.appimage
  assert.match(job['runs-on'], /^ubuntu-/)
  assert.strictEqual(wf.permissions.contents, 'write')
  const checkout = job.steps.find((s) => String(s.uses || '').startsWith('actions/checkout'))
  assert.strictEqual(checkout.with.ref, 'refs/tags/${{ env.TAG }}')
})

check('workflow：只上傳 AppImage＋latest-linux.yml、不建／不改 Release', () => {
  const runs = wf.jobs.appimage.steps.map((s) => s.run || '').join('\n')
  const uploads = runs.split('\n').filter((l) => /gh release upload/.test(l))
  assert.strictEqual(uploads.length, 1)
  const block = runs.slice(runs.indexOf('gh release upload'), runs.indexOf('--clobber') + 9)
  assert.match(block, /linux-x86_64\.AppImage/)
  assert.match(block, /latest-linux\.yml/)
  assert.doesNotMatch(block, /\.exe|latest\.yml\b(?!-)/)
  const commands = runs.split('\n').filter((l) => !/echo /.test(l)).join('\n')
  assert.doesNotMatch(commands, /gh release (create|edit|delete)|--draft|--prerelease/)
  assert.match(runs, /electron:build:linux/)
})

check('package.json：release:linux 與 electron:build:linux 存在、Linux 不自動發佈', () => {
  assert.strictEqual(pkg.scripts['release:linux'], 'node scripts/release-linux.js')
  assert.match(pkg.scripts['electron:build:linux'], /--publish never/)
  assert.ok(pkg.build.linux.target.includes('AppImage'))
  assert.strictEqual(pkg.build.linux.artifactName, '${productName}-${version}-linux-${arch}.${ext}')
})

check('release-linux.js：資產清單與 gh 參數', () => {
  const assets = linuxAssets('1.2.3', '/x/dist')
  assert.deepStrictEqual(assets.map((p) => path.basename(p)), ['AxonDeck-1.2.3-linux-x86_64.AppImage', 'latest-linux.yml'])
  assert.deepStrictEqual(uploadArgs('v1.2.3', ['a', 'b']), ['release', 'upload', 'v1.2.3', 'a', 'b', '--clobber'])
})

check('release-linux.js：latest-linux.yml 版號解析', () => {
  assert.strictEqual(manifestVersion("version: 1.42.0\nfiles:\n"), '1.42.0')
  assert.strictEqual(manifestVersion("version: '1.43.0-beta.1'\n"), '1.43.0-beta.1')
  assert.strictEqual(manifestVersion('files: []\n'), '')
})

if (failed) {
  console.log(`\n${failed} 項失敗`)
  process.exit(1)
}
console.log('\n全部通過')
