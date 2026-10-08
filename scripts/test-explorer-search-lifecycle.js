'use strict'

// UFFS CLI（uffs.exe）的參數／生命週期契約只存在於 Windows；Linux 走 plocate／自建索引（test-explorer-linux-index.js）
if (process.platform !== 'win32') {
  console.log('SKIP: UFFS CLI 契約只在 Windows 驗')
  process.exit(0)
}
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const calls = []
const load = Module._load
let uffs
let warmingResponses = 0
try {
  Module._load = function(request, ...args) {
    if (request === 'fs') return { statSync: () => ({ isFile: () => true }) }
    if (request === 'child_process') return { spawn: (exe, argv) => {
      calls.push(argv)
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => setImmediate(() => child.emit('close', 1))
      setImmediate(() => {
        const warming = argv.includes('--status') && warmingResponses-- > 0
        child.stdout.emit('data', Buffer.from(argv.includes('--status')
          ? JSON.stringify({ broker: { installed: true }, daemon: { running: warming,
            status: { status: { state: warming ? 'warming' : 'ready' } }, drives: [{ loading: warming }] } }) : '[]'))
        child.emit('close', 0)
      })
      return child
    } }
    return load.call(this, request, ...args)
  }
  uffs = require('../src/main/explorer/uffs')
} finally { Module._load = load }

async function main() {
  uffs.configure(__dirname)
  assert.deepEqual(uffs.searchFilterArgs({ minSize: null, maxSize: null }), [], '空篩選不可把全部正常檔案濾掉')
  assert.deepEqual(uffs.searchFilterArgs({ maxSize: 0 }), ['--max-size', '0'], '明確搜尋空檔仍保留')
  await uffs.ensureReady()
  assert(!calls.some(argv => argv[0] === '--daemon' && argv[1] === 'start'), '進頁不能預先載入整機索引')
  await uffs.releaseMemory()
  assert(!calls.some(argv => argv[1] === 'hibernate'), '沒被這份 App 用過的 daemon 不碰')
  await uffs.search('*.txt')
  const beforeSearches = calls.filter(argv => argv[0].includes('.txt')).length
  warmingResponses = 1
  await uffs.search('*.txt')
  assert(calls.filter(argv => argv[0].includes('.txt')).length > beforeSearches + 1, '首次建索引後須自動重試原查詢')
  warmingResponses = 1
  const oldQuery = uffs.search('*.txt')
  await new Promise(resolve => setTimeout(resolve, 10))
  const newQuery = uffs.search('*.js')
  const [oldResult, newResult] = await Promise.all([oldQuery, newQuery])
  assert.equal(oldResult.cancelled, true, '新版查詢須停止前一輪的索引等待')
  assert.equal(newResult.cancelled, undefined)
  const realTimeout = global.setTimeout
  global.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms === 60000 ? 10 : ms, ...args)
  try {
    await uffs.search('*.txt')
    await new Promise(resolve => realTimeout(resolve, 30))
    assert(calls.some(argv => argv[1] === 'hibernate'), '閒置計時器需真的觸發休眠')
  } finally { global.setTimeout = realTimeout }
  assert.equal(await uffs.releaseMemory(), true)
  assert(calls.some(argv => argv[0] === '--daemon' && argv[1] === 'hibernate'), '搜尋閒置後需釋放索引 RAM')
  await uffs.search('*.js')
  await uffs.shutdown()
  console.log('PASS: 進頁不載索引、只休眠 App 用過的索引、關閉應用等待釋放')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
