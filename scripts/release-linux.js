'use strict'

/**
 * 本機打 Linux AppImage／deb／rpm 並附加到同版號的 GitHub Release（與 .github/workflows/release-linux.yml 同一套規則）。
 * 只打本機架構（x64 或 arm64，不交叉編譯）；有 LINUX_SIGNING_KEY 環境變數就順便簽章。
 *
 *     npm run release:linux                 # 打包 → 附加到 v<package.json version>
 *     npm run release:linux -- --dry-run    # 只列出會做什麼，不打包、不上傳
 *     npm run release:linux -- --skip-build # 用 dist/ 現成產物（要和版號一致）
 *
 * 規則：只在 Linux 上跑；Release 必須已存在（照 AGENTS.md 發行流程先 `gh release create`），不自己建；
 * 只上傳這個架構的 `.AppImage`／`.deb`／`.rpm`、更新清單（x64 `latest-linux.yml`、arm64 `latest-linux-arm64.yml`）
 * 與簽章檔（有的話）；`--clobber` 只覆蓋同名檔，不碰 Windows 資產。上傳前跑 check-linux-artifacts.js。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const { packageNames, uploadList } = require('./lib/linux-artifacts')

const ROOT = path.join(__dirname, '..')

/**
 * 要上傳的檔：三個套件＋更新清單（固定前四個），之後是存在的簽章檔。
 * @param {string} version @param {string} [distDir] @param {'x64'|'arm64'} [arch]
 */
function linuxAssets(version, distDir = path.join(ROOT, 'dist'), arch = process.arch === 'arm64' ? 'arm64' : 'x64') {
  return uploadList(version, arch, distDir)
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
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error(`不支援 ${process.arch}（只有 x64、arm64）`)
  const version = require(path.join(ROOT, 'package.json')).version
  const tag = `v${version}`
  const arch = process.arch
  const manifestName = packageNames(version, arch).manifest

  const gh = spawnSync('gh', ['release', 'view', tag, '--json', 'tagName', '-q', '.tagName'], { cwd: ROOT, encoding: 'utf8', shell: false })
  if (gh.error) throw new Error('找不到 gh CLI；先安裝並 `gh auth login`')
  if (gh.status !== 0) throw new Error(`Release ${tag} 不存在；先照 AGENTS.md 發行流程 \`gh release create ${tag}\``)

  if (dryRun) {
    console.log(`[release-linux] dry-run：${skipBuild ? '略過打包' : 'npm run electron:build:linux'}（${arch}）`)
    console.log(`[release-linux] dry-run：node scripts/sign-linux-artifacts.js（${process.env.LINUX_SIGNING_KEY ? '有金鑰，會簽' : '沒有 LINUX_SIGNING_KEY，略過'}）`)
    console.log(`[release-linux] dry-run：gh ${uploadArgs(tag, linuxAssets(version, undefined, arch)).join(' ')}`)
    return
  }
  if (!skipBuild) run('npm', ['run', 'electron:build:linux'])
  const manifest = path.join(ROOT, 'dist', manifestName)
  if (!fs.existsSync(manifest)) throw new Error(`缺產物：dist/${manifestName}`)
  const got = manifestVersion(fs.readFileSync(manifest, 'utf8'))
  if (got !== version) throw new Error(`${manifestName} 是 ${got || '（讀不到）'}，package.json 是 ${version}；重打一次`)
  run(process.execPath, [path.join(__dirname, 'sign-linux-artifacts.js'), '--arch', arch, '--version', version])
  run(process.execPath, [path.join(__dirname, 'check-linux-artifacts.js'), '--arch', arch, '--version', version])
  const assets = linuxAssets(version, undefined, arch)
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
