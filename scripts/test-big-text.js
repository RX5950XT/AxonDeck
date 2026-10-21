'use strict'
/**
 * 超大文字檔分段檢視（src/main/big-text.js）：跟一份「整份讀進來再切」的笨做法逐列對照。
 * 用法：node scripts/test-big-text.js
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const big = require('../src/main/big-text')

const dir = tempDir('big-text-')

/** 笨做法：整份切行，太長的行每 MAX_ROW_BYTES 切一刀（退到 UTF-8 邊界） */
function reference(buf) {
  let start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
  const rows = []
  let line = 1
  while (start < buf.length) {
    let nl = buf.indexOf(10, start)
    if (nl < 0) nl = buf.length
    let s = start
    let first = true
    while (nl - s > big.MAX_ROW_BYTES) {
      let cut = s + big.MAX_ROW_BYTES
      while (cut > s + 1 && (buf[cut] & 0xc0) === 0x80) cut -= 1
      rows.push({ t: buf.subarray(s, cut).toString('utf8'), n: first ? line : 0 })
      first = false
      s = cut
    }
    let end = nl
    if (end > s && buf[end - 1] === 13) end -= 1
    rows.push({ t: buf.subarray(s, end).toString('utf8'), n: first ? line : 0 })
    line += 1
    start = nl + 1
  }
  return { rows, lines: line - 1 }
}

/** UTF-16 的笨做法：直接切 JS 字串（本來就是 UTF-16 碼元），每 MAX_ROW_BYTES/2 個碼元一刀，不切開代理對 */
function reference16(text) {
  const per = big.MAX_ROW_BYTES / 2
  const rows = []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  lines.forEach((full, i) => {
    let rest = full
    let first = true
    while (rest.length > per) {
      let cut = per
      const c = rest.charCodeAt(cut)
      if (c >= 0xdc00 && c <= 0xdfff) cut -= 1
      rows.push({ t: rest.slice(0, cut), n: first ? i + 1 : 0 })
      first = false
      rest = rest.slice(cut)
    }
    rows.push({ t: rest.endsWith('\r') ? rest.slice(0, -1) : rest, n: first ? i + 1 : 0 })
  })
  return { rows, lines: lines.length }
}

/** @param {'utf8' | 'utf16le' | 'utf16be'} [encoding] utf16 會自動加 BOM */
async function check(name, content, encoding = 'utf8') {
  const file = path.join(dir, `${name}.txt`)
  const le = Buffer.from(content, 'utf16le')
  fs.writeFileSync(file, encoding === 'utf8' ? content
    : encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), le])
      : Buffer.concat([Buffer.from([0xfe, 0xff]), le.swap16()]))
  const buf = fs.readFileSync(file)
  const ref = encoding === 'utf8' ? reference(buf) : reference16(content)
  const idx = await big.index(file)
  assert.strictEqual(idx.rows, ref.rows.length, `${name}: 列數`)
  assert.strictEqual(idx.lines, ref.lines, `${name}: 行數`)
  const starts = [0, 1, big.STEP - 1, big.STEP, big.STEP + 7, Math.floor(ref.rows.length / 2), ref.rows.length - 3]
  for (const start of starts.filter((s) => s >= 0 && s < ref.rows.length)) {
    const got = await big.readRows(idx, start, 40)
    assert.deepStrictEqual(got, ref.rows.slice(start, start + 40), `${name}: 第 ${start} 列起`)
  }
  for (const line of [1, 2, Math.floor(ref.lines / 2), ref.lines].filter((n) => n >= 1 && n <= ref.lines)) {
    const row = await big.rowOfLine(idx, line)
    assert.strictEqual(ref.rows[row].n, line, `${name}: 第 ${line} 行在第 ${row} 列`)
  }
  return { idx, ref }
}

;(async () => {
  // 1) 很多短行＋CRLF＋中文，跨好幾個書籤
  const short = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行 {"id": ${i}}`).join('\r\n') + '\r\n'
  const a = await check('short', '﻿' + short)
  assert.strictEqual(await big.find(a.idx, '"id": 4321}', -1), a.ref.rows.findIndex((r) => r.t.includes('"id": 4321}')))
  // 從後面找要繞回開頭
  const first = a.ref.rows.findIndex((r) => r.t.includes('第 3 行'))
  assert.strictEqual(await big.find(a.idx, '第 3 行', 4000), first)
  assert.strictEqual(await big.find(a.idx, '不存在的字', -1), null)
  // 預設不分大小寫；勾了「大小寫」就要一模一樣
  const id = a.ref.rows.findIndex((r) => r.t.includes('"id": 4321}'))
  assert.strictEqual(await big.find(a.idx, '"ID": 4321}', -1), id)
  assert.strictEqual(await big.find(a.idx, '"ID": 4321}', -1, true), null)
  assert.strictEqual(await big.find(a.idx, '"id": 4321}', -1, true), id)
  await assert.rejects(() => big.find(a.idx, '', -1), (e) => e.code === 'BAD_QUERY')

  // 2) 壓成一行的大 JSON（含中文，切點落在多位元組字中間）＋跨 4MB 讀取塊
  const oneLine = '[' + Array.from({ length: 200000 }, (_, i) => `{"名稱":"項目${i}","v":${i}}`).join(',') + ']'
  const b = await check('oneline', oneLine + '\n短的一行\n')
  assert.ok(b.ref.rows.length > 1000 && b.ref.rows.every((r) => !r.t.includes('�')), '切列不切斷中文字')
  const target = '"項目199999"'
  assert.strictEqual(await big.find(b.idx, target, -1), b.ref.rows.findIndex((r) => r.t.includes(target)))

  // 3) 沒有結尾換行、空行、空檔
  await check('tail', 'a\n\nb\nc')
  const empty = await check('empty', '')
  assert.deepStrictEqual(await big.readRows(empty.idx, 0, 10), [])

  // 4) UTF-16 LE／BE：長行切點落在表情符號（代理對）上、CRLF、跟換行長得像但沒對齊的位元組（ਅ一 → 05 0A 00 4E）
  const u16 = 'x' + '😀'.repeat(5000) + 'ਅ一'.repeat(3000) + '\r\n' +
    Array.from({ length: 3000 }, (_, i) => `Row ${i} 中文 ਅ一ਅ`).join('\r\n') + '\r\nEnd'
  for (const encoding of /** @type {const} */ (['utf16le', 'utf16be'])) {
    const c = await check(encoding, u16, encoding)
    assert.ok(c.ref.rows.every((r) => !r.t.includes('�')), `${encoding}: 不切開代理對`)
    const want = c.ref.rows.findIndex((r) => r.t.includes('Row 2999 中文'))
    assert.strictEqual(await big.find(c.idx, 'row 2999 中文', -1), want, `${encoding}: 不分大小寫找得到`)
    assert.strictEqual(await big.find(c.idx, 'row 2999 中文', -1, true), null, `${encoding}: 分大小寫找不到`)
    // ਅ一 的位元組含 0A 00，切列不可以把它當成換行
    assert.strictEqual(await big.find(c.idx, 'End', -1, true), c.ref.rows.length - 1)
  }

  // 5) 檔案往後長（還在寫的 log）：接著掃的結果要跟整份重掃一模一樣
  const grow = path.join(dir, 'grow.txt')
  // 剛好 2*STEP 列、最後一行沒寫完 → 最後一個書籤落在檔尾，接著寫的要併進同一行
  fs.writeFileSync(grow, Array.from({ length: 2 * big.STEP }, (_, i) => `L${i}`).join('\n'))
  let prev = await big.index(grow)
  for (const more of ['-more\nnext\n', 'x'.repeat(3 * big.MAX_ROW_BYTES) + '\n中文\n', '']) {
    fs.appendFileSync(grow, more)
    const inc = await big.index(grow, prev)
    assert.deepStrictEqual(inc, await big.index(grow), `接著掃：追加 ${JSON.stringify(more.slice(0, 12))}`)
    prev = inc
  }
  // 確定真的是接著掃：中間原地改一個字（檔頭檔尾沒動）就看不出來，這是刻意的取捨
  const bytes = fs.readFileSync(grow)
  bytes[Math.floor(bytes.length / 3)] = 10
  fs.writeFileSync(grow, Buffer.concat([bytes, Buffer.from('tail\n')]))
  assert.notStrictEqual((await big.index(grow, prev)).lines, (await big.index(grow)).lines, '中間沒重掃')
  // 變短（log 被輪替）或檔頭變了：整份重掃
  fs.writeFileSync(grow, 'a\nb\n')
  assert.deepStrictEqual(await big.index(grow, prev), await big.index(grow), '變短要重掃')
  prev = await big.index(grow)
  fs.writeFileSync(grow, 'X\nb\nc\n')
  assert.deepStrictEqual(await big.index(grow, prev), await big.index(grow), '檔頭變了要重掃')

  console.log('big-text PASS')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
