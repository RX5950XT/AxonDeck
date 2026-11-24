'use strict'
// 檔案總管啟動還原：已消失或空白的分頁路徑要安靜改回首頁，不要跳出「讀不到這個資料夾」
const assert = require('node:assert/strict')
const path = require('node:path')
const { tempDir } = require('./lib/test-temp')
const { sessionFallback, restoreExistingDir, restoreBrowseSession } = require('../src/main/explorer/restore-session')

const fallback = 'thispc'
const alive = 'C:\\Users\\me\\Documents'
const gone = 'C:\\Users\\me\\deleted'
const exists = new Set([alive.toLowerCase()])
const isDir = async (full) => exists.has(String(full).toLowerCase())

function ok(label, condition) {
  assert.equal(Boolean(condition), true, label)
}

ok('首頁後援用第一個常用位置', sessionFallback([{ path: 'thispc' }], [{ path: 'C:\\' }], 'C:\\') === 'thispc')
ok('沒有常用位置才用第一顆磁碟', sessionFallback([], [{ path: 'D:\\' }], 'C:\\') === 'D:\\')
ok('再沒有才用最後手段', sessionFallback([], [], 'C:\\') === 'C:\\')

async function main() {
  ok('本機首頁原樣保留', await restoreExistingDir('thispc', fallback, isDir) === 'thispc')
  ok('回收筒原樣保留', await restoreExistingDir('recyclebin', fallback, isDir) === 'recyclebin')
  ok('還在的資料夾原樣保留', await restoreExistingDir(alive, fallback, isDir) === alive)
  ok('已消失的資料夾改回首頁', await restoreExistingDir(gone, fallback, isDir) === fallback)
  ok('空白路徑改回首頁', await restoreExistingDir('', fallback, isDir) === fallback)
  ok('只有空白字元的路徑改回首頁', await restoreExistingDir('   ', fallback, isDir) === fallback)
  ok('探針失敗當消失', await restoreExistingDir(gone, fallback, async () => { throw new Error('boom') }) === fallback)

  const missingTab = await restoreBrowseSession({
    lastPath: gone,
    activeTabId: 't1',
    tabs: [{
      id: 't1',
      cwd: gone,
      history: [alive, gone],
      histIndex: 1
    }]
  }, { fallback, isDir })
  assert.equal(missingTab.lastPath, fallback)
  assert.equal(missingTab.tabs[0].cwd, fallback)
  assert.equal(missingTab.tabs[0].history[0], alive, '較早的歷史不動')
  assert.equal(missingTab.tabs[0].history[1], fallback, '目前那一格改成首頁')

  const emptyTab = await restoreBrowseSession({
    lastPath: '',
    activeTabId: 't1',
    tabs: [{ id: 't1', cwd: '', history: [''], histIndex: 0 }]
  }, { fallback, isDir })
  assert.equal(emptyTab.lastPath, fallback)
  assert.equal(emptyTab.tabs[0].cwd, fallback)

  const mixed = await restoreBrowseSession({
    lastPath: gone,
    activeTabId: 't2',
    tabs: [
      { id: 't1', cwd: gone, history: [gone], histIndex: 0 },
      { id: 't2', cwd: alive, history: [alive], histIndex: 0 }
    ]
  }, { fallback, isDir })
  assert.equal(mixed.tabs[0].cwd, fallback)
  assert.equal(mixed.tabs[1].cwd, alive)
  assert.equal(mixed.lastPath, alive, 'lastPath 跟著作用中的分頁')

  const noTabs = await restoreBrowseSession({ lastPath: gone, tabs: [] }, { fallback, isDir })
  assert.equal(noTabs.lastPath, fallback)
  assert.deepEqual(noTabs.tabs, [])

  const thisPc = await restoreBrowseSession({
    lastPath: 'thispc',
    tabs: [{ id: 't1', cwd: 'thispc', history: ['thispc'], histIndex: 0 }]
  }, { fallback, isDir })
  assert.equal(thisPc.tabs[0].cwd, 'thispc')

  // 預設探針：真實存在的暫存資料夾要留下來（不因路徑格式退回首頁）
  const realDir = tempDir('axd-restore-ok-')
  assert.equal(await restoreExistingDir(realDir, fallback), path.resolve(realDir))

  console.log('PASS: explorer restore missing/empty tab path falls back to home')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
