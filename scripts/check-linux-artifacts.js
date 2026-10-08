#!/usr/bin/env node
'use strict'

/**
 * Linux 發行產物檢查（CI 上傳前、本機 release:linux 都跑）：
 * - AppImage／deb／rpm／更新清單都在，檔名照 electron-builder 的架構命名
 * - 更新清單的 version 等於版號，三個檔的 size／sha512 跟實際檔案一致（簽章改過 rpm 也要對得上）
 * - deb 的 Architecture、rpm 的 ARCH 是目標架構（有 dpkg-deb／rpm 才查）
 * - unpacked 主程式與 asar.unpacked 的原生模組（node-pty、uiohook-napi、sherpa-onnx、reflink）都是目標架構
 * - app.asar 沒打壞（package.json 版號、main 進入點、每個 .json 都能 parse）
 * - AppImage 裡不能混進 deb／rpm 的 `package-type`（會被 electron-updater 當成 deb 更新）
 *
 *   node scripts/check-linux-artifacts.js --arch x64 --version 1.43.0 [--dist dist] [--list]
 *   --list：只印要上傳的檔案（一行一個），給 workflow 用
 */

const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { removeTreeSync } = require('../src/main/safe-rm')
const lib = require('./lib/linux-artifacts')

function args(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  return {
    arch: get('--arch', process.arch),
    version: get('--version', require('../package.json').version),
    dist: path.resolve(get('--dist', path.join(__dirname, '..', 'dist'))),
    list: argv.includes('--list'),
    skipAppImage: argv.includes('--skip-appimage-extract')
  }
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('base64')))
  })
}

function tool(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', shell: false })
  return r.error || r.status !== 0 ? null : String(r.stdout).trim()
}

async function checkManifest(opts, names, errors) {
  const manifest = path.join(opts.dist, names.manifest)
  const text = fs.readFileSync(manifest, 'utf8')
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1]
  if (version !== opts.version) errors.push(`${names.manifest} 的 version 是 ${version}，要 ${opts.version}`)
  for (const file of [names.appImage, names.deb, names.rpm]) {
    const entry = lib.manifestEntry(text, file)
    if (!entry) { errors.push(`${names.manifest} 沒列 ${file}`); continue }
    const full = path.join(opts.dist, file)
    const size = fs.statSync(full).size
    if (entry.size !== size) errors.push(`${names.manifest} 裡 ${file} 的 size ${entry.size} ≠ 實際 ${size}`)
    if (entry.sha512 !== await sha512(full)) errors.push(`${names.manifest} 裡 ${file} 的 sha512 跟實際檔案不符`)
  }
}

function checkPackages(opts, names, errors, notes) {
  const want = lib.packageArch(opts.arch)
  const debArch = tool('dpkg-deb', ['-f', path.join(opts.dist, names.deb), 'Architecture'])
  if (debArch === null) notes.push('沒有 dpkg-deb，略過 deb 架構檢查')
  else if (debArch !== want.deb) errors.push(`deb 的 Architecture 是 ${debArch}，要 ${want.deb}`)
  const rpmArch = tool('rpm', ['-qp', '--nosignature', '--qf', '%{ARCH}', path.join(opts.dist, names.rpm)])
  if (rpmArch === null) notes.push('沒有 rpm，略過 rpm 架構檢查')
  else if (rpmArch !== want.rpm) errors.push(`rpm 的 ARCH 是 ${rpmArch}，要 ${want.rpm}`)
}

/** AppImage 只能在同架構上解開；解到 dist 底下的暫存資料夾，看 resources/package-type 在不在 */
function checkAppImage(opts, names, errors, notes) {
  if (opts.skipAppImage || opts.arch !== process.arch) { notes.push('略過 AppImage 內容檢查（跨架構或指定略過）'); return }
  const work = path.join(opts.dist, `.check-appimage-${process.pid}`)
  fs.mkdirSync(work, { recursive: true })
  try {
    const r = spawnSync(path.join(opts.dist, names.appImage), ['--appimage-extract', 'resources/*'], { cwd: work, stdio: 'ignore', shell: false })
    const resources = path.join(work, 'squashfs-root', 'resources')
    if (r.status !== 0 || !fs.existsSync(resources)) { errors.push('AppImage 解不開（--appimage-extract）'); return }
    if (!fs.existsSync(path.join(resources, 'app-update.yml'))) errors.push('AppImage 裡沒有 app-update.yml（自動更新會說沒有更新資訊）')
    if (fs.existsSync(path.join(resources, 'package-type'))) errors.push('AppImage 裡混進了 package-type（會被當成 deb／rpm 更新）')
  } finally {
    removeTreeSync(work)
  }
}

async function main() {
  const opts = args(process.argv.slice(2))
  const names = lib.packageNames(opts.version, opts.arch)
  if (opts.list) {
    for (const file of lib.uploadList(opts.version, opts.arch, opts.dist)) console.log(file)
    return
  }
  const errors = []
  const notes = []
  for (const file of [names.appImage, names.deb, names.rpm, names.manifest]) {
    if (!fs.existsSync(path.join(opts.dist, file))) errors.push(`缺產物 ${file}`)
  }
  if (!errors.length) {
    await checkManifest(opts, names, errors)
    checkPackages(opts, names, errors, notes)
    checkAppImage(opts, names, errors, notes)
  }
  const native = lib.checkNativeArch(lib.unpackedDir(opts.dist, opts.arch), opts.arch)
  errors.push(...native.errors)
  const asar = lib.checkAsar(lib.unpackedDir(opts.dist, opts.arch), opts.version)
  errors.push(...asar.errors)
  if (!asar.errors.length) notes.push(`app.asar：package.json＋${asar.files} 個 JSON 檔可解析`)
  for (const note of notes) console.log(`[check-linux] ${note}`)
  for (const warning of native.warnings) console.log(`[check-linux] 警告：${warning}`)
  console.log(`[check-linux] 原生模組（${opts.arch}）：${native.checked.join('、') || '無'}`)
  if (errors.length) {
    for (const error of errors) console.error(`[check-linux] ✗ ${error}`)
    process.exit(1)
  }
  console.log(`[check-linux] ✓ ${opts.arch} ${opts.version}：${[names.appImage, names.deb, names.rpm, names.manifest].join('、')}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[check-linux] ${error.message}`)
    process.exit(1)
  })
}

module.exports = { main }
