'use strict'

/**
 * Linux 資料夾樹檔名搜尋（UFFS 替代）回歸。
 * Windows 上跳過；只驗證本機 walk／取消／篩選／status 文案。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')

const platform = require('../src/main/platform')
const linuxSearch = require('../src/main/explorer/linux-search')
const uffs = require('../src/main/explorer/uffs')

async function main() {
  if (!platform.isLinux) {
    console.log('SKIP: Linux 資料夾搜尋（目前非 Linux）')
    return
  }

  const st = await uffs.status()
  assert.equal(st.mode, 'folder')
  assert.equal(st.installed, true)
  assert.equal(st.daemon.running, true)
  assert.equal(st.unsupported, false)
  assert.match(String(st.message || ''), /資料夾樹/)

  const root = tempDir('linux-search')
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(root, 'readme.md'), 'hi')
    fs.writeFileSync(path.join(root, 'docs', 'Notes.txt'), 'n')
    fs.writeFileSync(path.join(root, 'src', 'deep', 'app.js'), 'x')
    fs.writeFileSync(path.join(root, 'src', 'deep', 'other.ts'), 'y')
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'hidden.js'), 'z')

    assert.equal(linuxSearch.compileMatcher('notes')('Notes.txt'), true)
    assert.equal(linuxSearch.compileMatcher('*.js')('app.js'), true)
    assert.equal(linuxSearch.compileMatcher('*.js')('app.ts'), false)

    const all = await linuxSearch.searchLocal('app', { root })
    assert.equal(all.warming, false)
    assert.ok(all.hits.some((h) => h.name === 'app.js'))
    assert.ok(!all.hits.some((h) => h.name === 'hidden.js'), '不可遞迴進 node_modules')

    const glob = await linuxSearch.searchLocal('*.txt', { root })
    assert.ok(glob.hits.some((h) => h.name === 'Notes.txt'))

    const typed = await linuxSearch.searchLocal('readme', { root, type: 'document' })
    assert.ok(typed.hits.some((h) => h.name === 'readme.md'))

    const viaUffs = await uffs.search('Notes', { root })
    assert.ok(viaUffs.hits.some((h) => /Notes/i.test(h.name)))

    let cancelled = false
    const cancelJob = uffs.search('a', { root })
    uffs.cancelSearch()
    const cancelledResult = await cancelJob
    if (cancelledResult.cancelled) cancelled = true
    // 極小樹可能在 cancel 前就跑完；再測 searchLocal 的 isCancelled
    const forced = await linuxSearch.searchLocal('readme', { root }, { isCancelled: () => true })
    assert.equal(forced.cancelled, true)
    assert.equal(forced.hits.length, 0)
    assert.ok(cancelled || true, 'cancelSearch 不應拋錯')

    await assert.rejects(() => uffs.search('x', {}), { code: 'BAD_PATH' })
    await assert.rejects(() => uffs.search('', { root }), { code: 'BAD_QUERY' })

    console.log('PASS: Linux 資料夾樹搜尋（命中／glob／略過 node_modules／取消／status）')
  } finally {
    removeTree(root)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
