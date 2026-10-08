'use strict'

/**
 * Linux 手機（MTP）：gio 輸出解析、指令組裝、偵測與退路文案，以及「瀏覽／複製進出／遞迴刪除／開檔暫存」整條流程。
 * 沒有真手機：整條流程用假的 `gio`（scripts/fixtures/mtp/fake-gio.js，照 gio 的語意）走真的子程序。
 * 用法：node scripts/test-mtp-linux.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { tempDir } = require('./lib/test-temp')
const t = require('../src/main/explorer/mtp-linux-transport')
const { createLinuxMtp, HINT_NO_TOOLS, HINT_NO_GVFS_MTP, HINT_NO_DEVICE } = require('../src/main/explorer/mtp-linux')

if (process.platform !== 'linux') {
  console.log('SKIP mtp linux（非 Linux）')
  process.exit(0)
}

const FAKE_GIO = path.join(__dirname, 'fixtures', 'mtp', 'fake-gio.js')

function testParsers() {
  const mounts = t.parseMountList([
    'Drive(0): Samsung SSD',
    '  Volume(0): Data',
    '    activation_root=file:///media/data/',
    'Volume(0): SAMSUNG Android',
    '  Type: GProxyVolume (GProxyVolumeMonitorMTP)',
    '  activation_root=mtp://SAMSUNG_Android_R58M1/',
    'Volume(1): Canon EOS',
    '  activation_root=gphoto2://Canon_EOS/',
    'Mount(0): Pixel 6a -> mtp://Google_Pixel_6a_1A2B/',
    'Mount(1): SAMSUNG Android -> mtp://SAMSUNG_Android_R58M1/',
    'Mount(2): share on nas -> smb://nas/share/'
  ].join('\n'))
  assert.deepEqual(mounts, [
    { name: 'SAMSUNG Android', uri: 'mtp://SAMSUNG_Android_R58M1/', mounted: true },
    { name: 'Canon EOS', uri: 'gphoto2://Canon_EOS/', mounted: false },
    { name: 'Pixel 6a', uri: 'mtp://Google_Pixel_6a_1A2B/', mounted: true }
  ])
  const items = t.parseGioList([
    'mtp://P/Internal%20shared%20storage/DCIM\t0\t(directory)\ttime::modified=1700000000',
    'mtp://P/Internal%20shared%20storage/%E5%A0%B1%E5%91%8A.pdf\t2048\t(regular)\ttime::modified=1700000001',
    'mtp://P/Internal%20shared%20storage/bad%09name\t1\t(regular)',
    'mtp://P/Internal%20shared%20storage/%2E%2E\t0\t(directory)',
    'garbage line'
  ].join('\n'))
  assert.deepEqual(items, [
    { name: 'DCIM', dir: true, size: 0, mtimeMs: 1700000000000 },
    { name: '報告.pdf', dir: false, size: 2048, mtimeMs: 1700000001000 }
  ])
  assert.equal(t.childUri('mtp://P/', ['內部 儲存', 'a#b.jpg']), 'mtp://P/%E5%85%A7%E9%83%A8%20%E5%84%B2%E5%AD%98/a%23b.jpg')
  assert.deepEqual(t.parseSimpleMtpfsList('1: Google Pixel 6a\n2: Xiaomi\n'), [
    { name: 'Google Pixel 6a', arg: ['--device', '1'] }, { name: 'Xiaomi', arg: ['--device', '2'] }
  ])
  assert.deepEqual(t.parseJmtpfsList('Device 0 (VID=18d1 and PID=4ee1) is a Google Inc Nexus/Pixel (MTP).\nAvailable devices (busLocation, devNum, productId, vendorId, product, vendor):\n1, 5, 0x4ee1, 0x18d1, Pixel 6a, Google\n'), [
    { name: 'Google Pixel 6a', arg: ['-device=1,5'] }
  ])
  assert.equal(t.classify({ stderr: 'Error: Directory not empty' }), 'NOT_EMPTY')
  assert.equal(t.classify({ timedOut: true }), 'TIMEOUT')
  console.log('ok 解析：gio mount -li／gio list -u／jmtpfs／simple-mtpfs')
}

function testDetect() {
  const has = (...list) => (p) => list.includes(p)
  assert.equal(t.detect({ exists: has('/usr/bin/gio', '/usr/libexec/gvfsd-mtp') }).kind, 'gio')
  const noBackend = t.detect({ exists: has('/usr/bin/gio') })
  assert.equal(noBackend.kind, 'none')
  assert.equal(noBackend.gio, true)
  assert.equal(t.detect({ exists: has('/usr/bin/gio', '/usr/bin/jmtpfs') }).kind, 'fuse')
  assert.equal(t.detect({ exists: has('/usr/bin/simple-mtpfs') }).fuseTool, 'simple-mtpfs')
  assert.equal(t.detect({ exists: has() }).kind, 'none')
  console.log('ok 偵測：gio＋gvfsd-mtp ＞ jmtpfs／simple-mtpfs ＞ 無')
}

/** 記錄每次 spawn 的參數，固定回 exit 0 與給定 stdout */
function recordingSpawn(stdout = '') {
  const calls = []
  const spawnFn = (file, args, opts) => {
    calls.push({ file, args, opts })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => { if (stdout) child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0) })
    return child
  }
  return { calls, spawnFn }
}

async function testGioCommands() {
  const rec = recordingSpawn('')
  const gio = t.createGioTransport({ spawnFn: rec.spawnFn, gioPath: '/usr/bin/gio' })
  const dev = { root: 'mtp://P/', mounted: false }
  await gio.mount(dev)
  const loc = gio.loc(dev, ['內部儲存', '-rf ; rm *'])
  await gio.list(loc)
  await gio.copyOut(loc, '/home/u/x')
  await gio.copyIn('/home/u/-y', loc)
  await gio.mkdir(loc)
  await gio.remove(loc)
  for (const c of rec.calls) {
    assert.equal(c.file, '/usr/bin/gio')
    assert.equal(c.opts.shell, false)
  }
  assert.deepEqual(rec.calls.map((c) => c.args[0]), ['mount', 'list', 'copy', 'copy', 'mkdir', 'remove'])
  // 每支都有 `--`，使用者檔名不可能被當成選項；URI 已百分比編碼
  for (const c of rec.calls) assert.ok(c.args.includes('--'))
  assert.ok(rec.calls[1].args.includes('-u'))
  assert.match(rec.calls[1].args.at(-1), /^mtp:\/\/P\/%E5%85%A7%E9%83%A8%E5%84%B2%E5%AD%98\/-rf%20%3B%20rm%20\*$/)
  assert.equal(dev.mounted, true)
  console.log('ok gio 指令：絕對路徑、shell:false、-- 分隔、URI 編碼')
}

/** 假手機：fake-gio 走真的子程序；手機內容在 phoneRoot */
function phoneFixture() {
  const base = tempDir('phone-')
  const phoneRoot = path.join(base, 'phone')
  fs.mkdirSync(path.join(phoneRoot, 'Internal shared storage', 'DCIM', 'Camera'), { recursive: true })
  fs.mkdirSync(path.join(phoneRoot, 'SD card'), { recursive: true })
  fs.writeFileSync(path.join(phoneRoot, 'Internal shared storage', 'DCIM', 'Camera', 'IMG_0001.jpg'), 'jpg-1')
  fs.writeFileSync(path.join(phoneRoot, 'Internal shared storage', 'DCIM', 'Camera', 'IMG_0002.jpg'), 'jpg-22')
  fs.writeFileSync(path.join(phoneRoot, 'Internal shared storage', '報告 2026.pdf'), 'pdf')
  fs.writeFileSync(path.join(phoneRoot, 'Internal shared storage', '.thumbnails'), '')
  process.env.FAKE_PHONE_ROOT = phoneRoot
  process.env.FAKE_GIO_LOG = path.join(base, 'gio.log')
  process.env.AXONDECK_ZIP_TEMP = tempDir('ziptemp-')
  return { base, phoneRoot }
}

function makeVfs(transport, extra = {}) {
  const mtp = require('../src/main/explorer/mtp')
  const paths = require('../src/main/explorer/paths')
  const files = require('../src/main/explorer/fs')
  const opened = []
  const vfs = createLinuxMtp({
    parse: mtp.parse, PREFIX: mtp.PREFIX, fail: paths.fail, files,
    zipTempRoot: () => process.env.AXONDECK_ZIP_TEMP,
    mediaOpen: async (file) => { opened.push(file); return '' },
    resolveExisting: (p) => paths.resolveExisting(p),
    transport,
    detect: () => ({ kind: 'gio', gio: true, gvfsMtp: true, fuseTool: '' }),
    ...extra
  })
  return { vfs, opened }
}

async function testEndToEnd() {
  const { base, phoneRoot } = phoneFixture()
  const gio = t.createGioTransport({ gioPath: FAKE_GIO })
  const { vfs, opened } = makeVfs(gio)
  const log = () => fs.readFileSync(process.env.FAKE_GIO_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

  // 裝置：只列 MTP（UDisks 的磁碟不算），名稱照 gio 的磁碟區名稱
  const devices = await vfs.listDevices()
  assert.deepEqual(devices, [{ name: 'Pixel 6a', path: 'mtp:Pixel 6a', type: '手機（MTP）' }])
  const support = await vfs.supportInfo()
  assert.equal(support.mode, 'gio')
  assert.equal(support.devices, 1)

  // 瀏覽：第一次進去才 gio mount（按需掛載）
  const top = await vfs.list('mtp:Pixel 6a', {})
  assert.ok(log().some((a) => a[0] === 'mount' && a.at(-1) === 'mtp://Fake_Phone/'))
  assert.deepEqual(top.entries.map((e) => e.name).sort(), ['Internal shared storage', 'SD card'])
  const storage = await vfs.list('mtp:Pixel 6a\\Internal shared storage', { showHidden: false })
  assert.deepEqual(storage.entries.map((e) => e.name).sort(), ['DCIM', '報告 2026.pdf'])
  const pdf = storage.entries.find((e) => e.name === '報告 2026.pdf')
  assert.equal(pdf.phone, true)
  assert.equal(pdf.size, 3)
  assert.equal(pdf.ext, 'pdf')
  assert.ok(pdf.mtimeMs > 0)
  const info = await vfs.inspect('mtp:Pixel 6a\\Internal shared storage\\報告 2026.pdf')
  assert.equal(info.type, 'PDF 檔')
  assert.deepEqual(await vfs.resolve('mtp:Pixel 6a\\Internal shared storage\\DCIM'), {
    path: 'mtp:Pixel 6a\\Internal shared storage\\DCIM', dir: true, parent: 'mtp:Pixel 6a\\Internal shared storage\\DCIM'
  })

  // 開檔：先複製到暫存，再交給系統開；第二次大小沒變直接用暫存那份
  assert.equal(await vfs.openPath('mtp:Pixel 6a\\Internal shared storage\\報告 2026.pdf'), true)
  assert.equal(fs.readFileSync(opened[0], 'utf8'), 'pdf')
  const copiesBefore = log().filter((a) => a[0] === 'copy').length
  await vfs.realPath('mtp:Pixel 6a\\Internal shared storage\\報告 2026.pdf')
  assert.equal(log().filter((a) => a[0] === 'copy').length, copiesBefore)

  // 複製出來：資料夾遞迴（gio copy 不收資料夾）、撞名產 (2)
  const dest = tempDir('dest-')
  fs.mkdirSync(path.join(dest, 'DCIM'))
  const out = await vfs.copyOut(['mtp:Pixel 6a\\Internal shared storage\\DCIM', 'mtp:Pixel 6a\\Internal shared storage\\報告 2026.pdf'], dest)
  assert.equal(out.status, 'completed')
  assert.deepEqual(out.paths, [path.join(dest, 'DCIM (2)'), path.join(dest, '報告 2026.pdf')])
  assert.equal(fs.readFileSync(path.join(dest, 'DCIM (2)', 'Camera', 'IMG_0002.jpg'), 'utf8'), 'jpg-22')

  // 複製進去：本機資料夾遞迴、撞名產 (2)、手機→手機擋下、裝置根（儲存空間那層）不給貼
  const local = tempDir('local-')
  fs.mkdirSync(path.join(local, 'Trip', 'Day 1'), { recursive: true })
  fs.writeFileSync(path.join(local, 'Trip', 'Day 1', 'a.mp4'), 'video')
  fs.writeFileSync(path.join(local, '報告 2026.pdf'), 'new')
  const into = await vfs.copyIn([path.join(local, 'Trip'), path.join(local, '報告 2026.pdf')], 'mtp:Pixel 6a\\Internal shared storage')
  assert.deepEqual(into.paths, ['mtp:Pixel 6a\\Internal shared storage\\Trip', 'mtp:Pixel 6a\\Internal shared storage\\報告 2026 (2).pdf'])
  assert.equal(fs.readFileSync(path.join(phoneRoot, 'Internal shared storage', 'Trip', 'Day 1', 'a.mp4'), 'utf8'), 'video')
  assert.equal(fs.readFileSync(path.join(phoneRoot, 'Internal shared storage', '報告 2026.pdf'), 'utf8'), 'pdf', '原檔不被覆寫')
  await assert.rejects(vfs.copyIn(['mtp:Pixel 6a\\SD card'], 'mtp:Pixel 6a\\Internal shared storage'), { code: 'BAD_PATH' })
  await assert.rejects(vfs.copyIn([path.join(local, 'Trip')], 'mtp:Pixel 6a'), { code: 'BAD_PATH' })

  // 永久刪除：資料夾遞迴（gio remove 刪不掉非空資料夾）；儲存空間本身不給刪
  const removed = await vfs.remove('mtp:Pixel 6a\\Internal shared storage\\Trip')
  assert.equal(removed.permanent, true)
  assert.equal(fs.existsSync(path.join(phoneRoot, 'Internal shared storage', 'Trip')), false)
  await assert.rejects(vfs.remove('mtp:Pixel 6a\\Internal shared storage'), { code: 'PROTECTED' })
  await assert.rejects(vfs.remove('mtp:Pixel 6a\\Internal shared storage\\nope.txt'), { code: 'NOT_FOUND' })
  const after = await vfs.list('mtp:Pixel 6a\\Internal shared storage', {})
  assert.ok(!after.entries.some((e) => e.name === 'Trip'), '刪完重列不再出現')

  // 手機拔掉：清單變空，再進去回「找不到這支手機」
  fs.renameSync(phoneRoot, `${phoneRoot}-gone`)
  await assert.rejects(vfs.list('mtp:Pixel 6a\\Internal shared storage', {}), (err) => ['NOT_FOUND', 'MTP_FAILED'].includes(err.code))
  fs.renameSync(`${phoneRoot}-gone`, phoneRoot)
  await assert.rejects(vfs.list('mtp:Galaxy\\x', {}), { code: 'NOT_FOUND' })
  assert.ok(fs.existsSync(base))
  console.log('ok 整條流程（假 gio 子程序）：列裝置／按需掛載／瀏覽／開檔暫存／遞迴複製進出／撞名／遞迴永久刪除／拔除')
}

async function testFuseFallback() {
  // FUSE 退路：掛載點已經是個資料夾（模擬 jmtpfs 掛好），之後全走一般 fs
  const base = tempDir('fuse-')
  const rec = recordingSpawn('1, 5, 0x4ee1, 0x18d1, Pixel 6a, Google\n')
  const fuse = t.createFuseTransport({
    spawnFn: rec.spawnFn,
    exists: (p) => p === '/usr/bin/jmtpfs' || p === '/usr/bin/fusermount3',
    mountBase: base
  })
  assert.equal(fuse.tool, 'jmtpfs')
  const found = await fuse.enumerate()
  assert.deepEqual(found.map((d) => d.name), ['Google Pixel 6a'])
  const dev = found[0]
  await fuse.mount(dev)
  assert.deepEqual(rec.calls.at(-1).args, ['-device=1,5', path.join(base, '1')])
  fs.mkdirSync(path.join(dev.root, 'Internal'), { recursive: true })
  fs.writeFileSync(path.join(dev.root, 'Internal', 'a.txt'), 'a')
  const { vfs } = makeVfs(fuse)
  await vfs.listDevices()
  const listing = await vfs.list('mtp:Google Pixel 6a\\Internal', {})
  assert.deepEqual(listing.entries.map((e) => e.name), ['a.txt'])
  const dest = tempDir('fuse-dest-')
  await vfs.copyOut(['mtp:Google Pixel 6a\\Internal\\a.txt'], dest)
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'a')
  await vfs.remove('mtp:Google Pixel 6a\\Internal\\a.txt')
  assert.equal(fs.existsSync(path.join(dev.root, 'Internal', 'a.txt')), false)
  await vfs.shutdown()
  assert.deepEqual(rec.calls.at(-1).args, ['-u', '--', path.join(base, '1')], '只卸自己掛的')
  console.log('ok FUSE 退路（jmtpfs）：列舉／掛載參數／瀏覽／複製／刪除／結束時卸載')
}

async function testHints() {
  const mtp = require('../src/main/explorer/mtp')
  const files = require('../src/main/explorer/fs')
  const paths = require('../src/main/explorer/paths')
  const mk = (det) => createLinuxMtp({ parse: mtp.parse, PREFIX: 'mtp:', fail: paths.fail, files, zipTempRoot: () => '', mediaOpen: async () => '', resolveExisting: (p) => p, detect: () => det })
  assert.equal((await mk({ kind: 'none', gio: false }).supportInfo()).note, HINT_NO_TOOLS)
  assert.equal((await mk({ kind: 'none', gio: true }).supportInfo()).note, HINT_NO_GVFS_MTP)
  const empty = createLinuxMtp({ parse: mtp.parse, PREFIX: 'mtp:', fail: paths.fail, files, zipTempRoot: () => '', mediaOpen: async () => '', resolveExisting: (p) => p,
    detect: () => ({ kind: 'gio', gio: true, gvfsMtp: true }), transport: { enumerate: async () => [] } })
  const info = await empty.supportInfo()
  assert.equal(info.supported, true)
  assert.equal(info.note, HINT_NO_DEVICE)
  // 這台測試機沒有 gio／gvfs：真的模組要回安裝說明，不是丟錯
  const real = await mtp.supportInfo()
  assert.equal(typeof real.note, 'string')
  assert.ok(['none', 'gio', 'fuse'].includes(real.mode))
  assert.equal(typeof mtp.copyIn, 'function')
  assert.throws(() => { throw mtp.readOnly() }, { code: 'READ_ONLY' })
  console.log(`ok 文案：缺 gvfs-backends／缺工具／沒插手機（本機實測 mode=${real.mode}）`)
}

;(async () => {
  testParsers()
  testDetect()
  await testGioCommands()
  await testEndToEnd()
  await testFuseFallback()
  await testHints()
  console.log('test-mtp-linux: all passed')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
