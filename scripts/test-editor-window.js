'use strict'
// 跑法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-editor-window.js（需要 original-fs 與完整 ICU 的 Big5）
const assert = require('assert')
const { decode, decodeAs, encode, isEditable, isOpenWith } = require('../src/main/editor-window.js')
for (const [enc, text] of [['utf8', 'a\r\n中文'], ['utf8bom', '{"a":1}'], ['utf16le', '記事本 Unicode']]) {
  const d = decode(encode(text, enc)); assert.deepEqual(d, { content: text, encoding: enc })
}
const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]) // 「中文」Big5
assert.deepEqual(decode(big5), { content: '中文', encoding: 'big5' })
assert.throws(() => decode(Buffer.from([1, 0, 2])), (e) => e.code === 'BINARY')
assert.ok(isEditable('C:/a/README.MD') && isEditable('x.json') && isEditable('x.ts') && !isEditable('x.exe') && !isEditable(null))
// 點開頭的檔名照 Windows 規則取副檔名（Node 的 extname 回空字串，關聯點兩下會打不開）
assert.ok(isEditable('C:/repo/.gitignore') && isEditable('D:/x/.editorconfig') && !isEditable('C:/a/LICENSE'))
// HTML／CSV 只進「開啟方式」：預設分流不收，指名才收
assert.ok(!isEditable('a.html') && isOpenWith('a.html') && isOpenWith('B.CSV') && !isOpenWith('a.md'))
// 指定編碼重開：剝 BOM、照指定的解
assert.deepEqual(decodeAs(encode('中文', 'utf8bom'), 'utf8bom'), { content: '中文', encoding: 'utf8bom' })
assert.deepEqual(decodeAs(big5, 'big5'), { content: '中文', encoding: 'big5' })
assert.equal(decodeAs(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'gbk').content, '中文')
assert.equal(decodeAs(Buffer.from([0xfe, 0xff, 0x4e, 0x2d]), 'utf16be').content, '中')
console.log('editor decode/encode PASS')
