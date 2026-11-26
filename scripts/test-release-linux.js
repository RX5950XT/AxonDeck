'use strict'

/**
 * Linux 發行流程的靜態檢查（不打包、不打 GitHub）：
 * - workflow 觸發條件、x64／arm64 原生 runner 矩陣、只上傳 Linux 檔（清單來自 check-linux-artifacts --list）、不建 Release、不 --draft
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

const job = wf.jobs.package

check('workflow：x64 在 ubuntu-22.04、arm64 在 ubuntu-24.04-arm（不交叉編譯）', () => {
  assert.deepStrictEqual(job.strategy.matrix.include, [
    { arch: 'x64', runner: 'ubuntu-22.04' },
    { arch: 'arm64', runner: 'ubuntu-24.04-arm' }
  ])
  assert.strictEqual(job.strategy['fail-fast'], false)
  assert.strictEqual(job['runs-on'], '${{ matrix.runner }}')
  const runs = job.steps.map((s) => s.run || '').join('\n')
  assert.doesNotMatch(runs, /--arm64|--x64|--arch\s+arm64|qemu/i, '不該帶交叉編譯旗標')
  assert.match(runs, /node -p process\.arch/)
})

check('workflow：contents: write、checkout 到 tag', () => {
  assert.strictEqual(wf.permissions.contents, 'write')
  const checkout = job.steps.find((s) => String(s.uses || '').startsWith('actions/checkout'))
  assert.strictEqual(checkout.with.ref, 'refs/tags/${{ env.TAG }}')
})

check('workflow：簽章→檢查→上傳（清單只來自 check-linux-artifacts --list）、不建／不改 Release', () => {
  const runs = job.steps.map((s) => s.run || '').join('\n')
  const uploads = runs.split('\n').filter((l) => /gh release upload/.test(l))
  assert.strictEqual(uploads.length, 1)
  assert.match(uploads[0], /gh release upload "\$TAG" "\$\{FILES\[@\]\}" --clobber/)
  assert.match(runs, /mapfile -t FILES < <\(node scripts\/check-linux-artifacts\.js --arch "\$ARCH" --version "\$\{TAG#v\}" --list\)/)
  const at = (re) => job.steps.findIndex((s) => re.test(s.run || ''))
  const build = at(/electron:build:linux/)
  const sign = at(/sign-linux-artifacts\.js/)
  const verify = at(/check-linux-artifacts\.js --arch "\$ARCH" --version "\$\{TAG#v\}"$/m)
  const upload = at(/gh release upload/)
  assert.ok(build >= 0 && build < sign && sign < verify && verify < upload, `順序不對 build=${build} sign=${sign} check=${verify} upload=${upload}`)
  const signStep = job.steps[sign]
  assert.strictEqual(signStep.env.LINUX_SIGNING_KEY, '${{ secrets.LINUX_SIGNING_KEY }}')
  assert.strictEqual(signStep.env.LINUX_SIGNING_PASSPHRASE, '${{ secrets.LINUX_SIGNING_PASSPHRASE }}')
  assert.ok(!job.env.LINUX_SIGNING_KEY, '私鑰只給簽章那一步')
  const commands = runs.split('\n').filter((l) => !/echo /.test(l)).join('\n')
  assert.doesNotMatch(commands, /gh release (create|edit|delete)|--draft|--prerelease/)
  assert.match(runs, /electron:build:linux/)
})

check('package.json：release:linux 與 electron:build:linux 存在、Linux 不自動發佈', () => {
  assert.strictEqual(pkg.scripts['release:linux'], 'node scripts/release-linux.js')
  assert.match(pkg.scripts['electron:build:linux'], /--publish never/)
  assert.deepStrictEqual(pkg.build.linux.target, ['AppImage', 'deb', 'rpm'])
  assert.match(pkg.scripts['electron:build:linux'], /--linux AppImage deb rpm/)
  assert.strictEqual(pkg.build.linux.artifactName, '${productName}-${version}-linux-${arch}.${ext}')
})

check('release-linux.js：資產清單與 gh 參數', () => {
  const base = (list) => list.map((p) => path.basename(p))
  assert.deepStrictEqual(base(linuxAssets('1.2.3', '/x/dist', 'x64')), ['AxonDeck-1.2.3-linux-x86_64.AppImage', 'AxonDeck-1.2.3-linux-amd64.deb', 'AxonDeck-1.2.3-linux-x86_64.rpm', 'latest-linux.yml'])
  assert.deepStrictEqual(base(linuxAssets('1.2.3', '/x/dist', 'arm64')), ['AxonDeck-1.2.3-linux-arm64.AppImage', 'AxonDeck-1.2.3-linux-arm64.deb', 'AxonDeck-1.2.3-linux-aarch64.rpm', 'latest-linux-arm64.yml'])
  assert.throws(() => linuxAssets('1.2.3', '/x/dist', 'ia32'), /不支援/)
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
