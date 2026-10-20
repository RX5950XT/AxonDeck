#!/usr/bin/env node
/**
 * 終端機分頁的上下文用量（`src/main/workspace/agent-context.js`）：從記錄檔尾巴取最後一輪。
 */

'use strict'

const path = require('path')
const { parseContextTail } = require(path.join(__dirname, '..', 'src/main/workspace/agent-context.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const codexLine = (total, window) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: total }, model_context_window: window } } })
const codex = ['{"broken half line', codexLine(1000, 475000), '{"type":"response_item"}', codexLine(213470, 475000), ''].join('\n')
ok('Codex 取最後一筆 token_count', JSON.stringify(parseContextTail('codex', codex)) === JSON.stringify({ used: 213470, max: 475000 }))
ok('Codex info 是 null（剛開）回 null', parseContextTail('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } })) === null)
ok('Codex 沒有上限欄位時 max 是 null', parseContextTail('codex', codexLine(500, undefined))?.max === null)

const claudeLine = (usage, extra = {}) => JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage }, ...extra })
const claude = [
  claudeLine({ input_tokens: 2, cache_creation_input_tokens: 570, cache_read_input_tokens: 163296, output_tokens: 305 }),
  claudeLine({ input_tokens: 9, output_tokens: 9 }, { isSidechain: true }),
  JSON.stringify({ type: 'user', message: { content: 'hi' } })
].join('\n')
ok('Claude 加總輸入＋快取讀寫＋輸出，略過子代理', JSON.stringify(parseContextTail('claude', claude)) === JSON.stringify({ used: 164173, max: null }))
ok('Claude 0 用量（synthetic）不算', parseContextTail('claude', claudeLine({ input_tokens: 0, output_tokens: 0 })) === null)
ok('空檔回 null', parseContextTail('claude', '') === null && parseContextTail('codex', '\n\n') === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
