#!/usr/bin/env node
/**
 * 背景 agent 系統通知（`src/main/agent-notify.js`）的純邏輯：renderer 給的內容驗形狀、工作列紅點畫得出來。
 */

'use strict'

const path = require('path')
const { sanitize, badgeBitmap } = require(path.join(__dirname, '..', 'src/main/agent-notify.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

ok('正常輸入照收', JSON.stringify(sanitize('t_abc', 'done', 'Claude Code · VoiceInk')) === JSON.stringify({ id: 't_abc', kind: 'done', title: 'Claude Code · VoiceInk' }))
ok('id 形狀不對拒收', sanitize('../x', 'done', 'a') === null && sanitize(1, 'done', 'a') === null)
ok('kind 只收 done／waiting', sanitize('t1', 'toString', 'a') === null && sanitize('t1', 'waiting', 'a')?.kind === 'waiting')
ok('控制字元換成空白、截長', sanitize('t1', 'done', `a\u001b[31mb${'x'.repeat(300)}`).title.length === 120 && !/\u001b/.test(sanitize('t1', 'done', 'a\u001bb').title))
ok('空標題補預設', sanitize('t1', 'done', '   ').title === '終端機')

const pixel = (buf, x, y) => [...buf.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
for (const count of [1, 7, 12]) {
  const buf = badgeBitmap(count)
  ok(`紅點 ${count}：16×16 BGRA`, buf.length === 16 * 16 * 4)
  ok(`紅點 ${count}：角落透明、邊緣紅色`, pixel(buf, 0, 0)[3] === 0 && pixel(buf, 7, 0).join() === '77,72,229,255')
  const white = Array.from({ length: 256 }, (_, i) => buf[i * 4] === 255 && buf[i * 4 + 1] === 255 && buf[i * 4 + 2] === 255).filter(Boolean).length
  ok(`紅點 ${count}：有畫出白字`, white >= 16, String(white))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
