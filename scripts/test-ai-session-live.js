'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-ai-session.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
const api = vm.runInNewContext(`${source}\n;({ sessionReadPlan, advanceSessionRead, sessionContentKey })`, {})

const first = api.sessionReadPlan({ sessionRow: { id: 'a' } })
assert.equal(first.follow, true, '剛打開的對話要跟著最新內容')
assert.equal(first.cursor, null)
const page = { hasMore: true, nextCursor: { offset: 40, part: 0, text: 0 }, turns: [{ role: 'user', text: '舊' }] }
const next = api.advanceSessionRead(first, page, 40)
assert.equal(next.walk, true)
assert.equal(next.page, 1)
assert.deepEqual(next.cursor, page.nextCursor)
const tail = api.advanceSessionRead(next, { hasMore: false, turns: [{ role: 'assistant', text: '最新' }] }, 40)
assert.equal(tail.walk, false)
assert.equal(tail.page, 1, '已經到記錄末尾就停在這一頁')
const parked = api.sessionReadPlan({ sessionFollow: false, sessionPage: 0, sessionPageCursors: [null] })
assert.equal(parked.follow, false, '使用者翻回較早的頁時不要被拉回最新')
assert.equal(api.advanceSessionRead(parked, page, 40).walk, false)
assert.notEqual(
  api.sessionContentKey({ sessionId: 'a', hasMore: false, turns: [{ role: 'user', text: '一' }] }, 0),
  api.sessionContentKey({ sessionId: 'a', hasMore: false, turns: [{ role: 'user', text: '一' }, { role: 'assistant', text: '二' }] }, 0),
  '新的一句要讓畫面重畫'
)
console.log('PASS 同視窗切換對話會改讀該段最新頁，翻回舊頁則停在那一頁')
