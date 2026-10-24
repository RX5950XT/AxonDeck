'use strict'

/**
 * Linux 整機檔名搜尋：自建索引（建置／查詢／mtime 增量／inotify／落盤）＋ plocate 後端選擇＋索引未完成時的退路。
 * 用法：node scripts/test-explorer-linux-index.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { removeTreeSync } = require('../src/main/safe-rm')
const { tempDir } = require('./lib/test-temp')
const { createFileIndex, isExcluded } = require('../src/main/explorer/linux-index')
const { createMachineSearch, defaultRoots } = require('../src/main/explorer/linux-machine-search')
const { probeLocate } = require('../src/main/explorer/linux-locate')

if (process.platform !== 'linux') {
  console.log('SKIP linux index（非 Linux）')
  process.exit(0)
}

function put(root, rel, text = 'x') {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

function tree() {
  const root = tempDir('idx-')
  put(root, 'Documents/Report-2026.docx', 'r')
  put(root, 'Documents/notes/todo.md')
  put(root, 'Music/Candy Shop.wav', 'w'.repeat(2048))
  put(root, 'Music/candy-remix.WAV')
  put(root, 'proj/src/main.js')
  put(root, 'proj/node_modules/candy/index.js')
  put(root, '.config/candy.conf')
  put(root, '.bashrc')
  put(root, 'Downloads/setup.AppImage')
  fs.symlinkSync(path.join(root, 'Music'), path.join(root, 'music-link'))
  return root
}

const names = (hits) => hits.map((h) => h.name).sort()

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function testCore() {
  const root = tree()
  const idx = createFileIndex({ yieldEvery: 4 })
  assert.equal(await idx.build([root]), true)
  const st = idx.stats()
  assert.ok(st.records >= 14, `records=${st.records}`)
  const q = (needle, extra = {}) => idx.query(() => false, { needle, limit: 100, ...extra })
  // 子字串、不分大小寫；node_modules 與隱藏資料夾不往下走，但名字本身搜得到
  assert.deepEqual(names(q('candy')), ['Candy Shop.wav', 'candy-remix.WAV'])
  assert.deepEqual(names(q('node_mod')), ['node_modules'])
  assert.deepEqual(names(q('.config')), ['.config'])
  assert.deepEqual(names(q('bashrc')), ['.bashrc'])
  // symlink 不跟：只有名字
  assert.deepEqual(names(q('music')), ['Music', 'music-link'])
  // glob 走逐筆比對
  const glob = idx.query((n) => /^.*\.wav$/i.test(n), { limit: 100 })
  assert.deepEqual(names(glob), ['Candy Shop.wav', 'candy-remix.WAV'])
  // 位置過濾
  const docs = q('o', { accept: (e) => e.path.startsWith(`${root}/Documents/`) })
  assert.ok(docs.every((e) => e.path.startsWith(`${root}/Documents/`)) && docs.length >= 2)
  // 一筆名字只命中一次（needle 在名字裡出現兩次）
  assert.equal(q('a').filter((e) => e.name === 'candy-remix.WAV').length, 1)

  // mtime 增量：新增、刪除、改名
  await new Promise((r) => setTimeout(r, 20))
  put(root, 'Music/new-candy.flac')
  fs.rmSync(path.join(root, 'Documents', 'notes', 'todo.md'))
  fs.renameSync(path.join(root, 'proj', 'src'), path.join(root, 'proj', 'source'))
  put(root, 'proj/source/deep/inner/candy.txt')
  const changed = await idx.refresh()
  assert.ok(changed >= 3, `changed=${changed}`)
  assert.deepEqual(names(q('candy')), ['Candy Shop.wav', 'candy-remix.WAV', 'candy.txt', 'new-candy.flac'])
  assert.equal(q('todo').length, 0)
  assert.deepEqual(names(q('source')), ['source'])
  assert.equal(q('main.js')[0].path, `${root}/proj/source/main.js`)
  // 整棵資料夾刪掉
  removeTreeSync(path.join(root, 'proj'))
  await idx.refresh()
  assert.equal(q('main.js').length, 0)
  assert.equal(idx.hasDir(`${root}/proj/source`), false)

  // 落盤再載回：筆數與查詢結果一致；檔名裡的 tab／換行可還原
  put(root, 'Documents/odd\tname\nx.txt')
  await idx.refresh()
  const file = path.join(tempDir('idxdata-'), 'index-v1.gz')
  await idx.save(file, { builtAt: 1 })
  const again = createFileIndex()
  const loaded = await again.load(file)
  assert.equal(loaded.meta.builtAt, 1)
  assert.equal(again.stats().records, idx.stats().records)
  assert.deepEqual(again.roots(), [root])
  assert.deepEqual(names(again.query(() => false, { needle: 'odd', limit: 10 })), ['odd\tname\nx.txt'])
  assert.equal(await again.load(path.join(path.dirname(file), 'nope.gz')), null)
  console.log('ok 核心：建置／子字串／glob／不跟 symlink／mtime 增量／落盤')
}

function stubLocate(fresh, paths = []) {
  const calls = []
  return {
    calls,
    probe: async () => ({ available: true, fresh, bin: '/usr/bin/plocate', name: 'plocate', db: '/var/lib/plocate/plocate.db', dbMtimeMs: Date.now() - 3_600_000 }),
    run: async (bin, pattern, opts) => { calls.push([bin, pattern, opts.limit]); return paths }
  }
}

async function testServiceIndexBackend() {
  const root = tree()
  const data = tempDir('userdata-')
  const none = async () => ({ available: false, fresh: false })
  const svc = createMachineSearch({ roots: () => [root], home: root, probeLocate: none, refreshMs: 60_000 })
  svc.configure(data)
  // 還沒建：有目前資料夾就退回資料夾樹搜尋；沒有就回 warming
  const cold = await svc.search('candy', { root: `${root}/Music` }, { autoBuild: false })
  assert.equal(cold.partial, true)
  assert.deepEqual(names(cold.hits), ['Candy Shop.wav', 'candy-remix.WAV'])
  const coldNoRoot = await svc.search('candy', {}, { autoBuild: false })
  assert.equal(coldNoRoot.warming, true)

  const progress = []
  const st0 = await svc.ensure({ onProgress: (p) => progress.push(p) })
  assert.equal(st0.mode, 'index')
  assert.equal(st0.backend, 'index')
  await svc._job()
  assert.equal(svc._phase(), 'ready')
  assert.ok(progress.some((p) => p.done && p.status?.daemon?.running))
  const st = await svc.status()
  assert.equal(st.daemon.running, true)
  assert.ok(st.daemon.records > 10)
  assert.match(st.message, /整機搜尋就緒/)
  assert.ok(fs.existsSync(path.join(data, 'linux-index', 'index-v1.gz')), '建完要落盤')

  // 整機搜尋：不需要 root；大小／時間／資料夾旗標由 stat 補上；類型與大小篩選照樣生效
  const res = await svc.search('candy', {})
  assert.deepEqual(names(res.hits), ['Candy Shop.wav', 'candy-remix.WAV'])
  const shop = res.hits.find((h) => h.name === 'Candy Shop.wav')
  assert.equal(shop.size, 2048)
  assert.equal(shop.ext, 'wav')
  assert.ok(shop.mtimeMs > 0)
  assert.equal(res.hits[0].name, 'Candy Shop.wav', 'rankHits：開頭命中排前面')
  const big = await svc.search('candy', { minSize: 1000 })
  assert.deepEqual(names(big.hits), ['Candy Shop.wav'])
  const folders = await svc.search('o', { type: 'folder' })
  assert.ok(folders.hits.length && folders.hits.every((h) => h.dir))
  const located = await svc.search('o', { location: `${root}/Documents` })
  assert.ok(located.hits.length && located.hits.every((h) => h.path.startsWith(`${root}/Documents`)))
  const globbed = await svc.search('*.appimage', {})
  assert.deepEqual(names(globbed.hits), ['setup.AppImage'])
  await assert.rejects(svc.search('-rf', {}), { code: 'BAD_QUERY' })
  // 取消
  const cancelled = await svc.search('candy', {}, { isCancelled: () => true })
  assert.equal(cancelled.cancelled, true)

  // inotify：家目錄（熱資料夾）新增的檔案幾秒內搜得到，不必等定期重掃
  put(root, 'fresh-download-candy.zip')
  const seen = await waitFor(async () => (await svc.search('fresh-download', {})).hits.length === 1, 6000)
  assert.equal(seen, true, 'inotify 應在數秒內補進索引')
  await svc.stop()

  // 第二次開 App：直接載入舊索引（不重建），再背景增量
  const svc2 = createMachineSearch({ roots: () => [root], home: root, probeLocate: none, refreshMs: 60_000 })
  svc2.configure(data)
  const t0 = Date.now()
  await svc2.ensure({})
  await svc2._job()
  assert.equal(svc2._phase(), 'ready')
  assert.ok((await svc2.search('fresh-download', {})).hits.length === 1, '落盤的索引含 inotify 補進來的那筆')
  console.log(`ok 服務（自建索引）：退路／建置／整機搜尋／篩選／inotify／重開載入（${Date.now() - t0}ms）`)
  await svc2.stop()
}

async function testServiceLocateBackend() {
  const root = tree()
  const real = `${root}/Music/Candy Shop.wav`
  const fresh = stubLocate(true, [real, `${root}/gone/candy.txt`, '/proc/1/candy', `${root}/Music`])
  const svc = createMachineSearch({ roots: () => [root], home: root, probeLocate: fresh.probe, runLocate: fresh.run })
  svc.configure(tempDir('userdata-'))
  const st = await svc.ensure({})
  assert.equal(st.backend, 'locate')
  assert.match(st.message, /plocate/)
  assert.equal(svc._job(), null, 'locate 新鮮就不自建索引')
  const res = await svc.search('candy', {})
  assert.deepEqual(fresh.calls[0], ['/usr/bin/plocate', 'candy', 2000])
  // 已刪除的（資料庫還沒更新）與 /proc 底下的都丟掉；資料夾旗標由 stat 決定
  assert.deepEqual(res.hits.map((h) => h.path).sort(), [`${root}/Music`, real].sort())
  assert.equal(res.hits.find((h) => h.path === `${root}/Music`).dir, true)
  await svc.stop()

  // 資料庫過期 → 改用自建索引，並在狀態說明
  const stale = stubLocate(false, [real])
  const svc2 = createMachineSearch({ roots: () => [root], home: root, probeLocate: stale.probe, runLocate: stale.run })
  svc2.configure('')
  await svc2.ensure({})
  await svc2._job()
  const st2 = await svc2.status()
  assert.equal(st2.backend, 'index')
  assert.match(st2.message, /資料庫已過期/)
  await svc2.search('candy', {})
  assert.equal(stale.calls.length, 0)
  await svc2.stop()

  // probeLocate：找不到程式＝不可用；有程式有 DB 才看新鮮度
  const fakeFs = (have) => ({
    access: async (p) => { if (!have.includes(p)) throw new Error('ENOENT') },
    stat: async (p) => { if (!have.includes(p)) throw new Error('ENOENT'); return { mtimeMs: 1000 } }
  })
  assert.equal((await probeLocate({ fsp: fakeFs([]) })).available, false)
  const p1 = await probeLocate({ fsp: fakeFs(['/usr/bin/plocate', '/var/lib/plocate/plocate.db']), now: () => 1000 + 3_600_000 })
  assert.equal(p1.available && p1.fresh, true)
  const p2 = await probeLocate({ fsp: fakeFs(['/usr/bin/plocate', '/var/lib/plocate/plocate.db']), now: () => 1000 + 40 * 3_600_000 })
  assert.equal(p2.fresh, false)
  assert.equal((await probeLocate({ fsp: fakeFs(['/usr/bin/plocate']) })).available, false, '沒跑過 updatedb')
  console.log('ok 服務（plocate）：新鮮才用／丟掉已刪與系統路徑／過期改自建索引')
}

function testRootsAndExcludes() {
  const roots = defaultRoots({
    home: '/home/rx',
    mounts: [
      { path: '/', fs: 'ext4', source: '/dev/nvme0n1p2' },
      { path: '/home', fs: 'ext4', source: '/dev/nvme0n1p3' },
      { path: '/boot/efi', fs: 'vfat', source: '/dev/nvme0n1p1' },
      { path: '/mnt/data', fs: 'ntfs3', source: '/dev/sda1' },
      { path: '/mnt/nas', fs: 'cifs', source: '//nas/share' },
      { path: '/run/media/rx/USB', fs: 'exfat', source: '/dev/sdb1' },
      { path: '/srv/backup', fs: 'xfs', source: '/dev/sdc1' }
    ]
  })
  assert.deepEqual(roots, ['/home/rx', '/mnt/data', '/run/media/rx/USB', '/srv/backup'])
  assert.equal(isExcluded('/proc/self'), true)
  assert.equal(isExcluded('/sys/class'), true)
  assert.equal(isExcluded('/dev/sda'), true)
  assert.equal(isExcluded('/run/user/1000/gvfs'), true)
  assert.equal(isExcluded('/run/media/rx/USB/a'), false)
  console.log('ok 索引範圍：家目錄＋本機掛載，排除網路磁碟／/proc／/sys／/dev')
}

;(async () => {
  testRootsAndExcludes()
  await testCore()
  await testServiceIndexBackend()
  await testServiceLocateBackend()
  console.log('test-explorer-linux-index: all passed')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
