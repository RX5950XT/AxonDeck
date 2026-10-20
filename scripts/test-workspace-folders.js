'use strict'
/** 真實 store 邏輯，僅替換 electron-store 的磁碟容器。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const file = path.join(__dirname, '../src/main/workspace/store.js')
const state = { projects: [
  { id: 'a', path: __dirname, name: 'A', tabsState: { activeId: 'e', tabs: [{ id: 'e', kind: 'editor', dirty: true, draftContent: '未存草稿' }] } },
  { id: 'b', path: path.dirname(__dirname), name: 'B' },
  { id: 'c', path: path.join(__dirname, 'lib'), name: 'C' }
] }
const context = { require: createRequire(file), module: { exports: {} }, process, setTimeout, clearTimeout }
vm.createContext(context)
vm.runInContext(fs.readFileSync(file, 'utf8') + `
store = {
  get: (key, fallback) => state[key] ?? fallback,
  set: (key, value) => typeof key === 'string' ? state[key] = value : Object.assign(state, key)
}`, Object.assign(context, { state }))
const api = context.module.exports
const plain = value => JSON.parse(JSON.stringify(value))

async function main() {
  assert((await api.list()).every(p => p.folderId === ''), '舊專案全部保留為未分類')
  const [one, two] = await Promise.all([api.createFolder('  開發  專案  '), api.createFolder('私人')])
  assert.equal(one.name, '開發 專案')
  assert.equal((await api.listFolders()).length, 2, '同時新增不互相覆蓋')
  await api.reorder([{ id: 'a', folderId: one.id }])
  await Promise.all([
    api.updateFolder(one.id, { collapsed: true, name: '程式' }),
    api.saveTabsState('a', state.projects[0].tabsState),
    api.reorder([{ id: 'b', folderId: two.id }, 'a'])
  ])
  assert.deepEqual(plain((await api.list()).map(p => [p.id, p.folderId])), [['b', two.id], ['a', one.id], ['c', '']])
  assert.equal((await api.listFolders())[0].collapsed, true)
  assert.equal((await api.getTabsState('a')).tabs[0].draftContent, '未存草稿')
  await api.reorder([{ id: 'a', folderId: '不存在' }, { id: 'a', folderId: '' }, null, 2, '未知'])
  assert.equal((await api.get('a')).folderId, one.id, '錯誤分類與重複 id 不改歸屬')
  await api.reorderFolders([two.id, two.id, '未知'])
  assert.deepEqual(plain((await api.listFolders()).map(f => f.id)), [two.id, one.id])
  await api.removeFolder(one.id)
  assert.equal((await api.get('a')).folderId, '')
  assert.equal((await api.list()).length, 3, '刪分類不刪專案')
  assert.equal((await api.getTabsState('a')).tabs[0].draftContent, '未存草稿')
  await api.rename('b', 'B 改名')
  assert.equal((await api.get('b')).folderId, two.id)
  state.projects[0].folderId = '已消失'
  state.folders = [null, {}, { id: two.id, name: 42 }, { id: two.id, name: '重複' }]
  assert.equal((await api.listFolders()).length, 1)
  assert.equal((await api.list())[0].folderId, '', '壞檔分類不能藏掉專案')
  state.folders = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, name: '分類' }))
  await assert.rejects(api.createFolder('超額'), { code: 'FOLDER_LIMIT' })
  assert.equal((await api.listFolders()).length, 100)
  console.log('PASS 專案分類：舊資料、並行儲存、分類／專案排序、錯誤輸入、刪除及草稿保留')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
