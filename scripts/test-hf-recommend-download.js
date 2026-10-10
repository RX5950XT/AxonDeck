'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/hf-recommend.js'), 'utf8')
const fn = source.match(/async function startDownload\(model\) \{[\s\S]*?\n\}/)[0]

async function run(reply, installed = false) {
  const downloaded = [], notices = []
  let scans = 0
  const context = {
    electronAPI: {
      models: { download: async key => { downloaded.push(key) } },
      hfmodels: { hardware: async () => { scans++; return reply } }
    },
    latestModels: {}, hasLlamaRuntime: () => installed,
    refreshRecommend: async () => {}, showToast: (...args) => notices.push(args),
    cleanIpcError: error => error.message
  }
  vm.runInNewContext(fn + '\nthis.start = startDownload', context)
  await context.start({ key: 'qwen3asr', requires: 'llamaruntime' })
  return { downloaded, notices, scans }
}

async function main() {
  const reply = { ok: true, data: { installable: [
    { key: 'llamaruntime', recommended: false, downloaded: false },
    { key: 'llamaruntimecuda', recommended: true, downloaded: false }
  ] } }
  assert.deepEqual((await run(reply)).downloaded, ['qwen3asr', 'llamaruntimecuda'], 'IPC 的 data 裡指定的建議環境也要下載')
  const ready = await run(reply, true)
  assert.deepEqual(ready.downloaded, ['qwen3asr'])
  assert.equal(ready.scans, 0, '已有 CUDA 或 Vulkan 時不重複安裝')
  reply.data.installable[0].recommended = true
  reply.data.installable[1].recommended = false
  assert.deepEqual((await run(reply)).downloaded, ['qwen3asr', 'llamaruntime'])
  const failed = await run({ ok: false, error: { message: '硬體偵測失敗' } })
  assert.ok(failed.notices.some(([message, kind]) => kind === 'error' && message.includes('硬體偵測失敗')))
  console.log('PASS 推薦下載：IPC 資料、CUDA／Vulkan 選擇、已安裝與偵測失敗')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
