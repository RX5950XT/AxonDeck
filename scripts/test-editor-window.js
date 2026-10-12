'use strict'
// 跑法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-editor-window.js（需要 original-fs 與完整 ICU 的 Big5）
const assert = require('assert')
const { decode, encode, isEditable } = require('../src/main/editor-window.js')
for (const [enc, text] of [['utf8', 'a\r\n中文'], ['utf8bom', '{"a":1}'], ['utf16le', '記事本 Unicode']]) {
  const d = decode(encode(text, enc)); assert.deepEqual(d, { content: text, encoding: enc })
}
const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]) // 「中文」Big5
assert.deepEqual(decode(big5), { content: '中文', encoding: 'big5' })
assert.throws(() => decode(Buffer.from([1, 0, 2])), (e) => e.code === 'BINARY')
assert.ok(isEditable('C:/a/README.MD') && isEditable('x.json') && !isEditable('x.ts') && !isEditable('x.exe') && !isEditable(null))
console.log('editor decode/encode PASS')
