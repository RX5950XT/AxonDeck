'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-ai-session.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
const api = vm.runInNewContext(`${source}\n;({ mergeSessionPages, readSessionPages, sessionContentKey, groupSessionTurns, reloadFollowedSession })`, {})

assert.notEqual(
  api.sessionContentKey({ sessionId: 'a', hasMore: false, turns: [{ role: 'user', text: '一' }] }, 0),
  api.sessionContentKey({ sessionId: 'a', hasMore: false, turns: [{ role: 'user', text: '一' }, { role: 'assistant', text: '二' }] }, 0),
  '新的一句要讓畫面重畫'
)

const turns = [
  { role: 'user', text: '提問\n完整尾巴' },
  { role: 'assistant', text: '先讀取', tools: [{ name: 'Read', detail: '第一行\n第二行' }] },
  { role: 'assistant', text: '', tools: [{ name: 'Read', detail: '接續尾巴' }], continued: true },
  { role: 'assistant', text: '', tools: [{ name: 'Write', detail: '<script>完整內容</script>' }] },
  { role: 'assistant', text: '完整回答', thought: true },
  { role: 'assistant', text: '', tools: [{ name: '工具結果', detail: '最後結果' }] }
]
const before = JSON.stringify(turns)
const groups = api.groupSessionTurns(turns)
assert.deepEqual(Array.from(groups, group => group.text || ''), ['提問\n完整尾巴', '先讀取', '', '完整回答', ''])
assert.equal(groups[2].tools.length, 3, '連續工具片段合併，遇到文字就分開')
assert.equal(groups[2].tools[1].continued, true, '長工具內容的接續標記保留')
assert.equal(groups[3].thought, true)
assert.deepEqual(Array.from(groups.flatMap(group => group.tools || []), tool => tool.detail), turns.flatMap(turn => turn.tools || []).map(tool => tool.detail), '工具內容逐字保留原順序')
assert.equal(JSON.stringify(turns), before, '不修改原始紀錄')
assert.equal(api.groupSessionTurns([]).length, 0)
assert.notEqual(
  api.sessionContentKey({ sessionId: 'a', turns: [{ role: 'assistant', tools: [{ name: 'Read', detail: '前' }] }] }, 0),
  api.sessionContentKey({ sessionId: 'a', turns: [{ role: 'assistant', tools: [{ name: 'Read', detail: '後' }] }] }, 0),
  '工具內容更新也要重畫，不能一直留著舊內容'
)
console.log('PASS 連續工具合併，對話與工具全文不變，工具更新會重畫')

async function readChecks() {
  const cursor = offset => ({ offset, part: 0, text: 0 })
  const pages = [
    { sessionId: 'a', pageCursor: cursor(0), hasMore: true, nextCursor: cursor(1), turns: [{ role: 'user', text: '第一段' }], toolCallsBreakdown: { Read: 1 }, readFiles: ['a.js', 'b.js'] },
    { sessionId: 'a', pageCursor: cursor(1), hasMore: false, turns: [{ role: 'assistant', text: '第二段' }], toolCallsBreakdown: { Write: 1 }, editedFiles: ['a.js'] }
  ]
  const merged = api.mergeSessionPages(pages)
  assert.deepEqual(Array.from(merged.turns, turn => turn.text), ['第一段', '第二段'])
  assert.equal(merged.toolCallsCount, 2)
  assert.deepEqual({ ...merged.toolCallsBreakdown }, { Read: 1, Write: 1 })
  assert.deepEqual(Array.from(merged.readFiles), ['b.js'], '後來改過的檔案只留在改過清單')
  const original = JSON.stringify(pages)
  const calls = []
  const initial = await api.readSessionPages([pages[0]], async c => { calls.push(c.offset); return pages[c.offset] }, () => true)
  assert.deepEqual(calls, [0, 1], '自動讀到末尾，不要求使用者翻頁')
  assert.equal(initial.length, 2)
  calls.length = 0
  const updated = await api.readSessionPages(initial, async c => { calls.push(c.offset); return { ...pages[1], turns: [...pages[1].turns, { role: 'assistant', text: '追加' }] } }, () => true)
  assert.deepEqual(calls, [1], '更新只重讀末段')
  assert.deepEqual(Array.from(api.mergeSessionPages(updated).turns, turn => turn.text), ['第一段', '第二段', '追加'], '末段取代舊末段，不重複追加')
  assert.equal(JSON.stringify(pages), original)
  const partial = await api.readSessionPages([pages[0]], async () => pages[0], () => true, 1)
  assert.equal(partial.at(-1).hasMore, true, '單批上限不冒充已讀完')
  const long = Array.from({ length: 45 }, (_, i) => ({ pageCursor: cursor(i), hasMore: i < 44, nextCursor: i < 44 ? cursor(i + 1) : null, turns: [{ role: 'assistant', text: String(i) }] }))
  const firstBatch = await api.readSessionPages([long[0]], async c => long[c.offset], () => true)
  const full = await api.readSessionPages(firstBatch, async c => long[c.offset], () => true)
  assert.equal(full.length, 45, '超過 40 段也會自動接完')
  assert.equal(api.mergeSessionPages(full).turns.length, 45, '跨批次不能漏掉或重複內容')
  await assert.rejects(() => api.readSessionPages([pages[0]], async c => ({ ...pages[0], nextCursor: c }), () => true), /游標/)
  let current = true
  assert.equal(await api.readSessionPages([pages[0]], async () => { current = false; return pages[1] }, () => current), null, '切走後作廢讀取結果')
  await assert.rejects(() => api.readSessionPages([pages[0]], async () => null, () => true), /讀取/)
  let latest = pages[1]
  const tab = { sessionData: pages[0] }
  const body = { scrollHeight: 2000, scrollTop: 200, clientHeight: 300 }
  let paints = 0
  const hooks = { read: async c => c.offset === 0 ? pages[0] : latest, current: () => true, body: () => body, paint: () => { paints++ } }
  await api.reloadFollowedSession(tab, hooks, 0)
  assert.equal(body.scrollTop, 200, '首次讀完保留閱讀位置，不跳到末尾')
  await api.reloadFollowedSession(tab, hooks, 0)
  assert.equal(paints, 1, '內容沒變不重畫')
  latest = { ...pages[1], turns: [...pages[1].turns, { role: 'assistant', text: '新內容' }] }
  await api.reloadFollowedSession(tab, hooks, 0)
  assert.equal(body.scrollTop, 200, '閱讀舊內容時更新不拉走位置')
  body.scrollTop = 1700
  latest = { ...latest, turns: [...latest.turns, { role: 'assistant', text: '再次追加' }] }
  await api.reloadFollowedSession(tab, hooks, 0)
  assert.equal(body.scrollTop, body.scrollHeight, '停在末尾時才跟著最新內容')
  console.log('PASS 全文單頁自動讀取、末段更新、取消與跨段統計')
}
readChecks().catch(error => { console.error(error); process.exitCode = 1 })
