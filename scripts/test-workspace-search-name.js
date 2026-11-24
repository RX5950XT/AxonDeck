'use strict'

/**
 * 工作區搜尋：檔名模式要找得到 Candy Circuit.wav；內容模式仍回 path:line。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const search = require('../src/main/workspace/search')

async function main() {
  const root = tempDir('ws-search-name')
  try {
    fs.mkdirSync(path.join(root, 'Downloads'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Downloads', 'Candy Circuit.wav'), Buffer.alloc(16))
    fs.writeFileSync(path.join(root, 'readme.md'), 'mentions Candy in content only\n')
    fs.writeFileSync(path.join(root, 'note.txt'), 'plain wav text line\n')

    const byName = await search.search(root, 'Candy', false, 'name')
    assert.equal(byName.mode, 'name')
    assert.ok(byName.hits.some((h) => h.rel.replace(/\\/g, '/').endsWith('Downloads/Candy Circuit.wav')))
    assert.ok(byName.hits.every((h) => h.kind === 'name' && h.line === 0))
    assert.ok(!byName.hits.some((h) => h.rel.endsWith('readme.md')), '檔名模式不可把內容命中當成檔名')

    const wav = await search.search(root, 'wav', false, 'name')
    assert.ok(wav.hits.some((h) => /Candy Circuit\.wav$/i.test(h.rel.replace(/\\/g, '/'))))
    assert.ok(!wav.hits.some((h) => h.text && h.line > 0), '檔名模式不可回內容行')

    const byContent = await search.search(root, 'Candy', false, 'content')
    assert.equal(byContent.mode, 'content')
    assert.ok(byContent.hits.some((h) => h.rel.endsWith('readme.md') && h.line >= 1))
    // .wav 是二進位，內容搜尋應跳過；即使掃到也不該當文字行
    assert.ok(!byContent.hits.some((h) => /\.wav$/i.test(h.rel)))

    const legacy = await search.search(root, 'plain', false)
    assert.equal(legacy.mode, 'content', '省略 mode 仍走內容（相容）')

    console.log('PASS: 工作區檔名搜尋（Candy → Candy Circuit.wav）與內容模式分離')
  } finally {
    removeTree(root)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
