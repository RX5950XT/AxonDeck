'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync('src/renderer/scripts/chat-page.js', 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
let pending
const context = vm.createContext({
  electronAPI: { chat: { image: async name => name === 'late' ? new Promise(resolve => { pending = resolve }) : 'data:image/png;base64,' + name + 'x'.repeat(2 * 1024 * 1024) } },
  console, setTimeout, clearTimeout, document: {}
})
vm.runInContext(source, context)
async function run() {
  await vm.runInContext('(async()=>{for(let i=0;i<40;i++)await loadImage(String(i))})()', context)
  const chars = vm.runInContext('[...imageCache.values()].reduce((n,s)=>n+s.length,0)', context)
  console.log('cached characters:', chars)
  assert.ok(chars <= 16 * 1024 * 1024, '歷史圖片快取不得隨瀏覽對話無限增加')
  assert.ok(await vm.runInContext('loadImage("0")', context), '被淘汰圖片仍可重新讀取')
  console.log('PASS 有界圖片快取與重新讀取')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
