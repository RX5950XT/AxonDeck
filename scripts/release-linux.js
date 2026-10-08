'use strict'

/**
 * 本機打 Linux AppImage 並附加到同版號的 GitHub Release（與 ci/github-workflows/release-linux.yml 同一套規則）。
 *
 *     npm run release:linux                 # 打包 → 附加到 v<package.json version>
 *     npm run release:linux -- --dry-run    # 只列出會做什麼，不打包、不上傳
 *     npm run release:linux -- --skip-build # 用 dist/ 現成產物（要和版號一致）
 *
 * 規則：只在 Linux 上跑；Release 必須已存在（照 AGENTS.md 發行流程先 `gh release create`），不自己建；
 * 只上傳 `.AppImage` 與 `latest-linux.yml`（`--clobber` 只覆蓋同名檔），不碰 Windows 資產。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

/** @param {string} version */
function linuxAssets(version, distDir = path.join(ROOT, 'dist')) {
  return [
    path.join(distDir, `AxonDeck-${version}-linux-x86_64.AppImage`),
    path.join(distDir, 'latest-linux.yml')
  ]
}

/** @param {string} tag @param {string[]} assets */
function uploadArgs(tag, assets) {
  return ['release', 'upload', tag, ...assets, '--clobber']
}

/** latest-linux.yml 的 version 要等於要發的版號（避免把舊產物傳上去） */
function manifestVersion(ymlText) {
  const match = /^version:\s*['"]?([^'"\s]+)/m.exec(ymlText)
  return match ? match[1] : ''
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts })
  if (result.error) throw new Error(`${cmd} 無法執行：${result.error.code || result.error.message}`)
  if (result.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} 失敗（exit ${result.status}）`)
}

function main(argv) {
  const dryRun = argv.includes('--dry-run')
  const skipBuild = argv.includes('--skip-build')
  if (process.platform !== 'linux') throw new Error('release:linux 只能在 Linux 上跑（Windows 發行照 AGENTS.md 用 electron:build）')
  const version = require(path.join(ROOT, 'package.json')).version
  const tag = `v${version}`
  const assets = linuxAssets(version)

  const gh = spawnSync('gh', ['release', 'view', tag, '--json', 'tagName', '-q', '.tagName'], { cwd: ROOT, encoding: 'utf8', shell: false })
  if (gh.error) throw new Error('找不到 gh CLI；先安裝並 `gh auth login`')
  if (gh.status !== 0) throw new Error(`Release ${tag} 不存在；先照 AGENTS.md 發行流程 \`gh release create ${tag}\``)

  if (dryRun) {
    console.log(`[release-linux] dry-run：${skipBuild ? '略過打包' : 'npm run electron:build:linux'}`)
    console.log(`[release-linux] dry-run：gh ${uploadArgs(tag, assets).join(' ')}`)
    return
  }
  if (!skipBuild) run('npm', ['run', 'electron:build:linux'])
  for (const file of assets) if (!fs.existsSync(file)) throw new Error(`缺產物：${path.relative(ROOT, file)}`)
  const got = manifestVersion(fs.readFileSync(assets[1], 'utf8'))
  if (got !== version) throw new Error(`latest-linux.yml 是 ${got || '（讀不到）'}，package.json 是 ${version}；重打一次`)
  run('gh', uploadArgs(tag, assets))
  console.log(`[release-linux] 已附加到 ${tag}：${assets.map((f) => path.basename(f)).join('、')}`)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`[release-linux] ${err.message}`)
    process.exit(1)
  }
}

module.exports = { linuxAssets, uploadArgs, manifestVersion }
