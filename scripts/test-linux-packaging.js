'use strict'

/**
 * Linux deb／rpm／arm64 打包的回歸（不打包、不連網、不需要 Electron）：
 * - updater-linux.js：安裝方式判斷、能不能自動套用、類別挑選、下載頁網址、檔名
 * - updater.js 整合：假的 electron-updater（有 DebUpdater／RpmUpdater／AppImageUpdater）＋假 PATH（dpkg、pkexec）
 *   → deb＋pkexec 用 DebUpdater 自動下載；deb 沒 pkexec／目錄版變手動、按鈕開下載頁、結束時不裝
 * - package.json：deb／rpm 相依、desktop entry、圖示；win／nsis 設定跟 linux-port-mvp 一模一樣
 * - scripts/lib/linux-artifacts.js：各架構檔名、ELF 架構、更新清單 sha512／size 改寫
 * - sign-linux-artifacts.js：沒金鑰就略過、不碰任何檔；壞金鑰會失敗且清掉暫存 GNUPGHOME（不產生任何金鑰）
 *
 * 用法：node scripts/test-linux-packaging.js
 */

const assert = require('assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const Module = require('module')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const linux = require('../src/main/updater-linux')
const lib = require('./lib/linux-artifacts')
const pkg = require('../package.json')

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`)
  }
}

/** 假 PATH：只放指定的可執行檔 */
function fakePath(names) {
  const dir = tempDir('axd-pkg-path-')
  for (const name of names) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
}

function resourcesWith(kind) {
  const dir = tempDir('axd-pkg-res-')
  fs.writeFileSync(path.join(dir, 'app-update.yml'), 'provider: github\nowner: RX5950XT\nrepo: AxonDeck\n')
  if (kind) fs.writeFileSync(path.join(dir, 'package-type'), `${kind}\n`)
  return dir
}

// ---- updater.js 整合用的假模組 ----
const stubs = { electron: null, 'electron-updater': null }
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, ...rest)
}

function makeFakeClass(kind, created) {
  return class {
    constructor() {
      this.kind = kind
      this.autoDownload = true
      this.handlers = {}
      this.installCalls = []
      this.downloadCount = 0
      created.push(this)
    }
    on(name, fn) { this.handlers[name] = fn }
    fire(name, payload) { this.handlers[name]?.(payload) }
    async checkForUpdates() { return null }
    async downloadUpdate() { this.downloadCount += 1; return [] }
    install(silent, runAfter) { this.installCalls.push([silent, runAfter]); return true }
    quitAndInstall() {}
  }
}

/** 乾淨載入 updater.js；回傳模組、建立的假實例、openExternal 收到的網址 */
function loadUpdater({ kind, pathDirs, appImage = false }) {
  const created = []
  const opened = []
  const saved = { PATH: process.env.PATH, APPIMAGE: process.env.APPIMAGE, resources: process.resourcesPath }
  process.resourcesPath = resourcesWith(kind)
  process.env.PATH = pathDirs
  if (appImage) process.env.APPIMAGE = '/fake/AxonDeck.AppImage'
  else delete process.env.APPIMAGE
  stubs.electron = {
    app: { isPackaged: true, getVersion: () => '1.42.0' },
    shell: { openExternal: async (url) => { opened.push(url) } }
  }
  stubs['electron-updater'] = {
    autoUpdater: { fallback: true },
    AppImageUpdater: makeFakeClass('appimage', created),
    DebUpdater: makeFakeClass('deb', created),
    RpmUpdater: makeFakeClass('rpm', created),
    PacmanUpdater: makeFakeClass('pacman', created)
  }
  delete require.cache[require.resolve('../src/main/updater.js')]
  const updater = require('../src/main/updater.js')
  const restore = () => {
    process.env.PATH = saved.PATH
    if (saved.APPIMAGE === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = saved.APPIMAGE
    process.resourcesPath = saved.resources
  }
  return { updater, created, opened, restore }
}

async function main() {
  await check('packageKind：APPIMAGE 優先，其次 package-type，否則目錄版', () => {
    assert.strictEqual(linux.packageKind({ env: { APPIMAGE: '/a.AppImage' }, resourcesPath: resourcesWith('deb') }), 'appimage')
    assert.strictEqual(linux.packageKind({ env: {}, resourcesPath: resourcesWith('deb') }), 'deb')
    assert.strictEqual(linux.packageKind({ env: {}, resourcesPath: resourcesWith('rpm') }), 'rpm')
    assert.strictEqual(linux.packageKind({ env: {}, resourcesPath: resourcesWith('pacman') }), 'pacman')
    assert.strictEqual(linux.packageKind({ env: {}, resourcesPath: resourcesWith('snap') }), 'linux')
    assert.strictEqual(linux.packageKind({ env: {}, resourcesPath: resourcesWith('') }), 'linux')
  })

  await check('canAutoInstall：要有套件管理器＋（root 或圖形化提權）', () => {
    const both = { PATH: fakePath(['dpkg', 'pkexec']) }
    assert.strictEqual(linux.canAutoInstall('deb', { env: both, isRoot: false }), true)
    assert.strictEqual(linux.canAutoInstall('deb', { env: { PATH: fakePath(['dpkg']) }, isRoot: false }), false, '沒 pkexec 會退回沒終端機的 sudo')
    assert.strictEqual(linux.canAutoInstall('deb', { env: { PATH: fakePath(['dpkg']) }, isRoot: true }), true)
    assert.strictEqual(linux.canAutoInstall('deb', { env: { PATH: fakePath(['pkexec']) }, isRoot: false }), false, '沒 dpkg／apt')
    assert.strictEqual(linux.canAutoInstall('rpm', { env: { PATH: fakePath(['dnf', 'kdesudo']) }, isRoot: false }), true)
    assert.strictEqual(linux.canAutoInstall('rpm', { env: both, isRoot: false }), false, 'deb 的工具不算 rpm 的')
    assert.strictEqual(linux.canAutoInstall('appimage', { env: { PATH: '' } }), true)
    assert.strictEqual(linux.canAutoInstall('linux', { env: both, isRoot: true }), false)
    const noExec = tempDir('axd-pkg-noexec-')
    fs.writeFileSync(path.join(noExec, 'pkexec'), '', { mode: 0o644 })
    fs.writeFileSync(path.join(noExec, 'dpkg'), '#!/bin/sh\n', { mode: 0o755 })
    assert.strictEqual(linux.canAutoInstall('deb', { env: { PATH: noExec }, isRoot: false }), false, '不可執行的 pkexec 不算')
  })

  await check('createUpdater：依安裝方式 new 對應類別，沒有就退回 autoUpdater', () => {
    const created = []
    const mod = { autoUpdater: { fallback: true }, DebUpdater: makeFakeClass('deb', created), RpmUpdater: makeFakeClass('rpm', created), AppImageUpdater: makeFakeClass('appimage', created) }
    assert.strictEqual(linux.createUpdater(mod, 'deb').kind, 'deb')
    assert.strictEqual(linux.createUpdater(mod, 'rpm').kind, 'rpm')
    assert.strictEqual(linux.createUpdater(mod, 'appimage').kind, 'appimage')
    assert.strictEqual(linux.createUpdater(mod, 'linux').kind, 'appimage', '目錄版沿用 AppImageUpdater（只檢查、不套用）')
    assert.strictEqual(linux.createUpdater(mod, 'pacman').fallback, true)
  })

  await check('releaseUrl／assetName：網址固定由 main 組、檔名跟打包產物一致', () => {
    assert.strictEqual(linux.releaseUrl('1.43.0'), 'https://github.com/RX5950XT/AxonDeck/releases/tag/v1.43.0')
    assert.strictEqual(linux.releaseUrl('../../evil'), 'https://github.com/RX5950XT/AxonDeck/releases/latest')
    assert.strictEqual(linux.releaseUrl(''), 'https://github.com/RX5950XT/AxonDeck/releases/latest')
    for (const arch of lib.ARCHES) {
      const names = lib.packageNames('1.43.0', arch)
      assert.strictEqual(linux.assetName('deb', '1.43.0', arch), names.deb)
      assert.strictEqual(linux.assetName('rpm', '1.43.0', arch), names.rpm)
      assert.strictEqual(linux.assetName('appimage', '1.43.0', arch), names.appImage)
    }
    assert.match(linux.messages('deb', false).manualAvailable('1.43.0'), /sudo apt install \.\/AxonDeck-1\.43\.0-linux-(amd64|arm64)\.deb/)
    assert.match(linux.messages('rpm', false).manualAvailable('1.43.0'), /sudo dnf install/)
  })

  await check('updater.js：deb＋dpkg＋pkexec → DebUpdater、自動下載、重新啟動安裝、結束時不裝', async () => {
    const t = loadUpdater({ kind: 'deb', pathDirs: fakePath(['dpkg', 'pkexec']) })
    try {
      t.updater.configure({ autoUpdate: true })
      await t.updater.check()
      assert.strictEqual(t.created.length, 1)
      const u = t.created[0]
      assert.strictEqual(u.kind, 'deb')
      assert.strictEqual(u.autoDownload, true)
      const st = t.updater.status()
      assert.strictEqual(st.packageKind, 'deb')
      assert.strictEqual(st.manual, false)
      assert.match(st.note, /套件管理器/)
      u.fire('update-available', { version: '1.43.0' })
      assert.strictEqual(t.updater.status().state, 'downloading')
      u.fire('update-downloaded', { version: '1.43.0' })
      assert.match(t.updater.status().message, /系統密碼/)
      assert.strictEqual(t.updater.installOnQuit(false), false, 'deb 不在結束時跳密碼框')
      assert.deepStrictEqual(u.installCalls, [])
      assert.deepStrictEqual(t.opened, [])
    } finally {
      t.restore()
    }
  })

  await check('updater.js：deb 沒有 pkexec → 手動：不下載、按鈕開下載頁、不能套用', async () => {
    const t = loadUpdater({ kind: 'deb', pathDirs: fakePath(['dpkg']) })
    try {
      t.updater.configure({ autoUpdate: true })
      await t.updater.check()
      const u = t.created[0]
      assert.strictEqual(u.kind, 'deb')
      assert.strictEqual(u.autoDownload, false, '手動模式不該偷偷下載')
      u.fire('update-available', { version: '1.43.0' })
      const st = t.updater.status()
      assert.strictEqual(st.state, 'available')
      assert.strictEqual(st.manual, true)
      assert.match(st.message, /AxonDeck-1\.43\.0-linux-(amd64|arm64)\.deb/)
      await t.updater.check()
      assert.deepStrictEqual(t.opened, ['https://github.com/RX5950XT/AxonDeck/releases/tag/v1.43.0'])
      assert.strictEqual(u.downloadCount, 0)
      u.fire('update-downloaded', { version: '1.43.0' })
      assert.strictEqual(t.updater.quitAndInstall(), false)
      assert.match(t.updater.status().message, /GitHub Releases/)
    } finally {
      t.restore()
    }
  })

  await check('updater.js：rpm＋dnf＋pkexec → RpmUpdater；目錄版 → 手動', async () => {
    let t = loadUpdater({ kind: 'rpm', pathDirs: fakePath(['dnf', 'pkexec']) })
    try {
      await t.updater.check()
      assert.strictEqual(t.created[0].kind, 'rpm')
      assert.strictEqual(t.updater.status().manual, false)
    } finally {
      t.restore()
    }
    t = loadUpdater({ kind: '', pathDirs: fakePath(['dpkg', 'pkexec']) })
    try {
      await t.updater.check()
      const st = t.updater.status()
      assert.strictEqual(st.packageKind, 'linux')
      assert.strictEqual(st.manual, true)
      assert.match(st.note, /目錄版/)
    } finally {
      t.restore()
    }
  })

  await check('updater.js：AppImage 就算混進 package-type 也走 AppImageUpdater、結束時照舊安裝', async () => {
    const t = loadUpdater({ kind: 'deb', pathDirs: fakePath([]), appImage: true })
    try {
      t.updater.configure({ autoUpdate: true })
      await t.updater.check()
      const u = t.created[0]
      assert.strictEqual(u.kind, 'appimage')
      assert.strictEqual(t.updater.status().packageKind, 'appimage')
      u.fire('update-downloaded', { version: '1.43.0' })
      assert.strictEqual(t.updater.installOnQuit(false), true)
      assert.deepStrictEqual(u.installCalls, [[true, false]])
    } finally {
      t.restore()
    }
  })

  await check('update-mirrors：.deb／.rpm 也走鏡像改寫，清單 yml 不改', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'update-mirrors.js'), 'utf8')
    const re = new RegExp(/new RegExp\(\s*`([^`]+)`/.exec(src)[1].replace('${OWNER}', 'RX5950XT').replace('${REPO}', 'AxonDeck').replace(/\\\\/g, '\\'), 'i')
    const base = 'https://github.com/RX5950XT/AxonDeck/releases/download/v1.43.0/'
    assert.ok(re.test(`${base}AxonDeck-1.43.0-linux-amd64.deb`))
    assert.ok(re.test(`${base}AxonDeck-1.43.0-linux-aarch64.rpm`))
    assert.ok(re.test(`${base}AxonDeck-1.43.0-linux-arm64.AppImage`))
    assert.ok(!re.test(`${base}latest-linux-arm64.yml`))
  })

  await check('package.json：deb／rpm 目標、相依、desktop entry、圖示', () => {
    const l = pkg.build.linux
    assert.deepStrictEqual(l.target, ['AppImage', 'deb', 'rpm'])
    assert.ok(!l.target.some((t) => typeof t === 'object' && t.arch), '不寫死 arch：各 runner 打自己的架構')
    assert.strictEqual(l.executableName, 'axondeck')
    assert.ok(fs.existsSync(path.join(ROOT, l.icon)), `圖示 ${l.icon} 要在`)
    assert.ok(l.maintainer && /<.+@.+>/.test(l.maintainer), 'deb 要 maintainer')
    assert.strictEqual(l.desktop.entry.StartupNotify, 'true')
    const deb = pkg.build.deb.depends.join(',')
    for (const dep of ['libsecret-1-0', 'libnss3', 'libgtk-3-0 | libgtk-3-0t64', 'libasound2 | libasound2t64', 'xdg-utils']) assert.ok(deb.includes(dep), `deb 缺 ${dep}`)
    for (const rec of ['gvfs', 'libglib2.0-bin']) assert.ok(pkg.build.deb.recommends.includes(rec), `deb recommends 缺 ${rec}`)
    const rpm = pkg.build.rpm.depends.join(',')
    for (const dep of ['gtk3', 'nss', '(libsecret or libsecret-1-0)', 'xdg-utils']) assert.ok(rpm.includes(dep), `rpm 缺 ${dep}`)
    assert.ok(pkg.build.rpm.fpm.join(' ').includes('Recommends: gvfs'))
    assert.ok(pkg.repository && /github\.com\/RX5950XT\/AxonDeck/.test(pkg.repository.url))
  })

  await check('package.json：Windows（win／nsis／files／asarUnpack／publish）跟 linux-port-mvp 一模一樣', () => {
    const r = spawnSync('git', ['show', 'origin/linux-port-mvp:package.json'], { cwd: ROOT, encoding: 'utf8', shell: false })
    if (r.status !== 0) { console.log('      （沒有 origin/linux-port-mvp，略過）'); return }
    const base = JSON.parse(r.stdout)
    for (const key of ['win', 'nsis', 'files', 'asarUnpack', 'publish', 'appId', 'productName', 'extraResources', 'directories']) {
      assert.deepStrictEqual(pkg.build[key], base.build[key], `build.${key} 不該變`)
    }
    for (const key of ['electron:build', 'electron:pack', 'build']) assert.strictEqual(pkg.scripts[key], base.scripts[key], `scripts.${key} 不該變`)
    assert.strictEqual(pkg.author, base.author)
    assert.strictEqual(pkg.homepage, base.homepage)
  })

  await check('linux-artifacts：ELF 架構判斷與帶標籤路徑', () => {
    const elf = (machine) => {
      const b = Buffer.alloc(20)
      b.writeUInt32BE(0x7f454c46, 0)
      b[5] = 1
      b.writeUInt16LE(machine, 18)
      return b
    }
    assert.strictEqual(lib.elfMachine(elf(0x3e)), 0x3e)
    assert.strictEqual(lib.elfMachine(elf(0xb7)), 0xb7)
    assert.strictEqual(lib.elfMachine(Buffer.from('MZ not elf at all....')), -1)
    assert.ok(lib.labeledForOther('@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node', 'arm64'))
    assert.ok(!lib.labeledForOther('@lydell/node-pty-linux-arm64/prebuilds/linux-arm64/pty.node', 'arm64'))
    assert.ok(lib.labeledForOther('uiohook-napi/prebuilds/win32-x64/uiohook-napi.node', 'x64'))
    assert.ok(!lib.labeledForOther('uiohook-napi/build/Release/uiohook_napi.node', 'arm64'))
  })

  await check('linux-artifacts：checkNativeArch 抓到 x64 檔混進 arm64 包（uiohook 的假 arm64 prebuild 只算警告）', () => {
    const dir = tempDir('axd-pkg-unpacked-')
    const nm = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules')
    const put = (rel, machine) => {
      const file = path.join(nm, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const b = Buffer.alloc(64)
      b.writeUInt32BE(0x7f454c46, 0)
      b[5] = 1
      b.writeUInt16LE(machine, 18)
      fs.writeFileSync(file, b)
    }
    const exe = Buffer.alloc(64)
    exe.writeUInt32BE(0x7f454c46, 0)
    exe[5] = 1
    exe.writeUInt16LE(0xb7, 18)
    fs.writeFileSync(path.join(dir, 'axondeck'), exe)
    put('@lydell/node-pty-linux-arm64/prebuilds/linux-arm64/pty.node', 0xb7)
    put('sherpa-onnx-linux-arm64/sherpa-onnx.node', 0xb7)
    put('@reflink/reflink-linux-arm64-gnu/reflink.linux-arm64-gnu.node', 0xb7)
    put('uiohook-napi/build/Release/uiohook_napi.node', 0xb7)
    put('uiohook-napi/prebuilds/linux-arm64/uiohook-napi.node', 0x3e)
    put('uiohook-napi/prebuilds/linux-x64/uiohook-napi.node', 0x3e)
    let r = lib.checkNativeArch(dir, 'arm64')
    assert.deepStrictEqual(r.errors, [])
    assert.strictEqual(r.warnings.length, 1)
    put('some-addon/build/Release/addon.node', 0x3e)
    r = lib.checkNativeArch(dir, 'arm64')
    assert.strictEqual(r.errors.length, 1)
    assert.match(r.errors[0], /some-addon/)
    r = lib.checkNativeArch(dir, 'x64')
    assert.ok(r.errors.some((e) => /主程式架構不對/.test(e)))
  })

  await check('linux-artifacts：checkAsar 擋下打壞的 app.asar（版號、main、內容錯位）', async () => {
    const asar = require('@electron/asar')
    const src = tempDir('axd-pkg-asar-src-')
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', version: '1.43.0', main: 'src/main/main.js' }))
    fs.mkdirSync(path.join(src, 'src', 'main'), { recursive: true })
    fs.writeFileSync(path.join(src, 'src', 'main', 'main.js'), 'module.exports = 1\n')
    fs.writeFileSync(path.join(src, 'data.json'), JSON.stringify({ ok: true, pad: 'x'.repeat(200) }))
    const dir = tempDir('axd-pkg-asar-')
    fs.mkdirSync(path.join(dir, 'resources'))
    const file = path.join(dir, 'resources', 'app.asar')
    await asar.createPackage(src, file)
    let r = lib.checkAsar(dir, '1.43.0')
    assert.deepStrictEqual(r.errors, [])
    assert.ok(r.files >= 2)
    assert.match(lib.checkAsar(dir, '1.44.0').errors.join(), /版號是 1\.43\.0/)
    // 模擬打包途中檔案被改：內容區被蓋掉，header 照舊
    const { headerSize } = asar.getRawHeader(file)
    const stat = asar.statFile(file, 'data.json')
    const fd = fs.openSync(file, 'r+')
    fs.writeSync(fd, Buffer.from('\x00\xffgarbage'), 0, 9, 8 + headerSize + Number(stat.offset))
    fs.closeSync(fd)
    r = lib.checkAsar(dir, '1.43.0')
    assert.match(r.errors.join(), /data\.json 不是合法 JSON/)
  })

  await check('linux-artifacts：更新清單讀寫（簽完 rpm 改 sha512／size，其他檔不動）', () => {
    const yml = [
      'version: 1.43.0',
      'files:',
      '  - url: AxonDeck-1.43.0-linux-arm64.AppImage',
      '    sha512: AAA',
      '    size: 10',
      '    blockMapSize: 5',
      '  - url: AxonDeck-1.43.0-linux-arm64.deb',
      '    sha512: BBB',
      '    size: 20',
      '  - url: AxonDeck-1.43.0-linux-aarch64.rpm',
      '    sha512: CCC',
      '    size: 30',
      'path: AxonDeck-1.43.0-linux-arm64.AppImage',
      'sha512: AAA',
      "releaseDate: '2026-10-08T00:00:00.000Z'",
      ''
    ].join('\n')
    const out = lib.patchManifest(yml, 'AxonDeck-1.43.0-linux-aarch64.rpm', 'NEW', 31)
    assert.deepStrictEqual(lib.manifestEntry(out, 'AxonDeck-1.43.0-linux-aarch64.rpm'), { sha512: 'NEW', size: 31 })
    assert.deepStrictEqual(lib.manifestEntry(out, 'AxonDeck-1.43.0-linux-arm64.deb'), { sha512: 'BBB', size: 20 })
    assert.match(out, /^sha512: AAA$/m, '頂層 sha512 是 AppImage 的，不該被改')
    assert.strictEqual(lib.manifestEntry(out, 'nope.rpm'), null)
    assert.throws(() => lib.patchManifest(yml, 'nope.rpm', 'X', 1), /沒有/)
  })

  await check('sign-linux-artifacts：沒金鑰略過不動檔；壞金鑰失敗並清掉暫存 GNUPGHOME', () => {
    const dist = tempDir('axd-pkg-dist-')
    const names = lib.packageNames('9.9.9', 'x64')
    for (const n of [names.appImage, names.deb, names.rpm]) fs.writeFileSync(path.join(dist, n), 'x')
    fs.writeFileSync(path.join(dist, names.manifest), `version: 9.9.9\nfiles:\n  - url: ${names.rpm}\n    sha512: X\n    size: 1\n`)
    const before = fs.readdirSync(dist).sort()
    const script = path.join(__dirname, 'sign-linux-artifacts.js')
    const env = { ...process.env }
    delete env.LINUX_SIGNING_KEY
    let r = spawnSync(process.execPath, [script, '--arch', 'x64', '--version', '9.9.9', '--dist', dist], { env, encoding: 'utf8' })
    assert.strictEqual(r.status, 0, r.stderr)
    assert.match(r.stdout, /略過簽章/)
    assert.deepStrictEqual(fs.readdirSync(dist).sort(), before)
    r = spawnSync(process.execPath, [script, '--arch', 'x64', '--version', '9.9.9', '--dist', dist], { env: { ...env, LINUX_SIGNING_KEY: 'not a key' }, encoding: 'utf8' })
    assert.notStrictEqual(r.status, 0, '壞金鑰要讓 CI 失敗，不能默默不簽')
    assert.deepStrictEqual(fs.readdirSync(dist).sort(), before, '失敗也不能留下 .sign-* 暫存或半成品')
    const sign = require('./sign-linux-artifacts')
    assert.strictEqual(sign.signingKey({ LINUX_SIGNING_KEY: '  \n' }), '')
    assert.deepStrictEqual(sign.rpmsignArgs('ABCD', '/h', '', '/d/x.rpm').slice(-2), ['--addsign', '/d/x.rpm'])
    assert.ok(sign.rpmsignArgs('ABCD', '/h', '/p', '/d/x.rpm').join(' ').includes('--passphrase-file /p'))
    assert.ok(!sign.gpgBase('/h', '').includes('--passphrase-file'))
    assert.strictEqual(sign.sha256sumsText([{ name: 'a.deb', hex: 'ff' }]), 'ff  a.deb\n')
  })

  await check('check-linux-artifacts --list：只列這個架構的檔，有簽章才帶 .asc', () => {
    const dist = tempDir('axd-pkg-list-')
    const script = path.join(__dirname, 'check-linux-artifacts.js')
    const list = () => spawnSync(process.execPath, [script, '--arch', 'arm64', '--version', '1.43.0', '--dist', dist, '--list'], { encoding: 'utf8' }).stdout.trim().split('\n').map((f) => path.basename(f))
    assert.deepStrictEqual(list(), ['AxonDeck-1.43.0-linux-arm64.AppImage', 'AxonDeck-1.43.0-linux-arm64.deb', 'AxonDeck-1.43.0-linux-aarch64.rpm', 'latest-linux-arm64.yml'])
    fs.writeFileSync(path.join(dist, 'AxonDeck-1.43.0-linux-aarch64.rpm.asc'), '')
    fs.writeFileSync(path.join(dist, 'AxonDeck-linux-signing-key.asc'), '')
    assert.deepStrictEqual(list().slice(4), ['AxonDeck-1.43.0-linux-aarch64.rpm.asc', 'AxonDeck-linux-signing-key.asc'])
  })

  await check('Windows 行為：updater.js 的 Linux 分支都包在 isLinux()／isManual() 裡', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8')
    assert.match(src, /autoUpdater = isLinux\(\) \? require\('\.\/updater-linux'\)\.createUpdater\(mod, linuxInfo\(\)\.kind\) : mod\.autoUpdater/)
    assert.match(src, /function isManual\(\) \{\n\s+return isLinux\(\) && !linuxInfo\(\)\.auto/)
    assert.match(src, /packageKind: isLinux\(\) \? linuxInfo\(\)\.kind : 'nsis'/)
  })

  Module._load = origLoad
  if (failed) {
    console.log(`\n${failed} 項失敗`)
    process.exit(1)
  }
  console.log('\n全部通過')
}

main()
