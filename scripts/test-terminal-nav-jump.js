'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const { requestJump } = require('../src/main/terminal/nav-jump')

const dir = tempDir('nav-jump-')
const id = 't_nav_jump'
;(async () => {
  try {
    const pending = requestJump(dir, id, { text: 'hello there message', role: 'prompt', index: 1 })
    const file = path.join(dir, `${id}.json`)
    const started = Date.now()
    while (!fs.existsSync(file) && Date.now() - started < 1000) await new Promise(resolve => setTimeout(resolve, 20))
    const body = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(body.role, 'prompt')
    assert.equal(body.index, 1)
    assert.equal(body.ok, null)
    fs.writeFileSync(file, JSON.stringify({ ...body, ok: true }))
    assert.equal(await pending, true, '外掛寫回 ok 才算跳到')
    assert.equal(await requestJump(dir, '../outside', { text: 'hello', role: 'answer', index: 0 }), false, '終端機 id 不能是路徑')
    assert.equal(await requestJump(dir, id, { text: '   ', role: 'prompt', index: 0 }), false, '空白訊息不送')
    console.log('PASS OpenCode 跳轉檔只收合法終端機 id，並等外掛寫回')
  } finally { removeTree(dir) }
})().catch(error => { console.error(error); process.exitCode = 1 })
