#!/usr/bin/env node
'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let passed = 0
async function test(name, run) {
  await run()
  passed += 1
  console.log(`  PASS ${name}`)
}

function harness(items, states) {
  const requests = []
  const denied = new Proxy({}, { get: (_, name) => () => assert.fail(`唯讀查詢不可呼叫 ${String(name)}`) })
  const state = { items, states, error: null }
  const store = new Proxy({ list: async () => state.items }, {
    get: (target, name) => name in target ? target[name] : denied[name]
  })
  class HostClient {
    async request(...args) {
      requests.push(args)
      assert.equal(args.length, 1)
      assert.equal(args[0], 'list')
      if (state.error) throw state.error
      return state.states
    }
    start() { assert.fail('不可啟動宿主') }
    write() { assert.fail('不可寫入終端機') }
    kill() { assert.fail('不可結束終端機') }
  }
  const mocks = { './store': store, './pty': denied, './links': denied, './foreground': denied,
    './editor-bridge': denied, './clipboard-image': denied, './background': denied,
    './claude-hooks': denied, '../workspace/agents': denied, './host-client': { HostClient },
    './agent-activity': { createActivity: () => denied, shellCommandOpen: denied.shellCommandOpen },
    './agent-resume': { createTracker: () => denied }, path,
    electron: { app: { getPath: key => { assert.equal(key, 'userData'); return 'D:\\isolated-test' } } } }
  const context = { module: { exports: {} }, require: name => {
    assert.ok(name in mocks, `不可載入真實模組：${name}`)
    return mocks[name]
  } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/terminal/service.js'), 'utf8'), context)
  return { list: context.module.exports.listRunningUnder, requests, state }
}

async function paths() {
  await test('Windows 路徑不分大小寫、斜線與尾部分隔符', async () => {
    const h = harness([], [{ id: 'same', state: 'running', cwd: 'd:/repo/WT-1/' },
      { id: 'nested', state: 'idle', cwd: 'D:\\REPO\\wt-1\\src' }])
    assert.equal((await h.list({ path: 'D:\\Repo\\wt-1\\' })).map(item => item.id).join(','), 'same,nested')
  })
  await test('分隔符邊界不把 wt-10 誤當 wt-1', async () => {
    const h = harness([], [{ id: 'inside', state: 'running', cwd: 'D:\\repo\\wt-1\\src' },
      { id: 'neighbor', state: 'running', cwd: 'D:\\repo\\wt-10' },
      { id: 'parent', state: 'running', cwd: 'D:\\repo' }])
    assert.equal((await h.list({ path: 'D:\\repo\\wt-1' })).map(item => item.id).join(','), 'inside')
  })
  await test('宿主即時 cwd 優先，空值才用建立時 cwd', async () => {
    const h = harness([{ id: 'moved-in', cwd: 'D:\\other' }, { id: 'moved-out', cwd: 'D:\\repo\\wt-1' },
      { id: 'fallback', cwd: 'D:\\repo\\wt-1\\sub' }],
    [{ id: 'moved-in', state: 'running', cwd: 'D:\\repo\\wt-1' },
      { id: 'moved-out', state: 'running', cwd: 'D:\\other' }, { id: 'fallback', state: 'idle', cwd: '' }])
    assert.equal((await h.list({ path: 'D:\\repo\\wt-1' })).map(item => item.id).join(','), 'moved-in,fallback')
  })
  await test('磁碟根目錄不因多加分隔符漏掉子目錄', async () => {
    const h = harness([], [{ id: 'root-child', state: 'running', cwd: 'D:\\repo' }])
    assert.equal((await h.list({ path: 'D:\\' }))[0].id, 'root-child')
  })
}

async function metadata() {
  await test('只包含 running 與 idle，忽略 exited／stopped 與無效 cwd', async () => {
    const states = ['running', 'idle', 'exited', 'stopped'].map(state => ({ id: state, state, cwd: 'D:\\repo' }))
    states.push({ id: 'relative', state: 'running', cwd: 'repo' }, null)
    const h = harness([], states)
    assert.equal((await h.list({ path: 'D:\\repo' })).map(item => item.id).join(','), 'running,idle')
  })
  await test('無 metadata 的宿主工作階段仍包含，預設純 shell', async () => {
    const h = harness([], [{ id: 'orphan', state: 'running', cwd: 'D:\\repo', title: 'live title' }])
    const result = await h.list({ path: 'D:\\repo' })
    assert.equal(JSON.stringify(result), JSON.stringify([{ id: 'orphan', title: 'live title', preset: 'shell' }]))
  })
  await test('使用者改名優先，其餘依即時標題、儲存標題與預設值', async () => {
    const items = [{ id: 'renamed', renamed: true, title: '我的 agent', preset: 'claude' },
      { id: 'live', title: 'saved', preset: 'codex' }, { id: 'saved', title: 'stored', preset: 'grok' }]
    const states = ['renamed', 'live', 'saved', 'default'].map(id => ({ id, state: 'running', cwd: 'D:\\repo',
      title: ['renamed', 'live'].includes(id) ? 'live title' : '' }))
    const result = await harness(items, states).list({ path: 'D:\\repo' })
    assert.equal(result.map(item => item.title).join(','), '我的 agent,live title,stored,終端機')
    assert.equal(result.map(item => item.preset).join(','), 'claude,codex,grok,shell')
  })
  await test('查詢只讀 list，不呼叫 start／write／kill／metadata 修改', async () => {
    const items = Object.freeze([Object.freeze({ id: 'term', cwd: 'D:\\repo', preset: 'shell' })])
    const states = Object.freeze([Object.freeze({ id: 'term', state: 'running', cwd: 'D:\\repo' })])
    const h = harness(items, states)
    await h.list({ path: 'D:\\repo' })
    assert.equal(JSON.stringify(h.requests), JSON.stringify([['list']]))
  })
}

async function errors() {
  await test('沒有執行中宿主時 null 回空清單', async () => {
    assert.equal((await harness([], null).list({ path: 'D:\\repo' })).length, 0)
  })
  await test('壞路徑先擋下，不查宿主', async () => {
    const h = harness([], [])
    for (const req of [null, {}, { path: '' }, { path: 1 }, { path: 'relative' },
      { path: 'D:\\repo\n' }, { path: 'D:\\repo\r' }, { path: 'D:\\repo\0' }]) {
      await assert.rejects(h.list(req), { code: 'BAD_PATH' })
    }
    assert.equal(h.requests.length, 0)
  })
  await test('宿主回應格式錯誤會擋移除，不當空清單', async () => {
    for (const value of [undefined, {}, false, 1, 'invalid']) {
      await assert.rejects(harness([], value).list({ path: 'D:\\repo' }), { code: 'HOST_STATE' })
    }
  })
  await test('宿主查詢失敗保留錯誤，不當空清單', async () => {
    const h = harness([], [])
    h.state.error = Object.assign(new Error('host unavailable'), { code: 'HOST_ERROR' })
    await assert.rejects(h.list({ path: 'D:\\repo' }), error => error === h.state.error)
  })
}

async function main() {
  await paths()
  await metadata()
  await errors()
  console.log(`\n${passed} passed, 0 failed`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
