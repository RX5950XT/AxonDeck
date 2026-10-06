'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
let body, request, status = 200
const hfmodels = { endpoint: () => ({ baseUrl: 'http://127.0.0.1/v1', apiKey: 'test-key' }) }
const box = vm.createContext({ module: { exports: {} }, AbortSignal,
  require: (id) => id === './hfmodels' ? hfmodels : { readResponseText: async () => body },
  fetch: async (_url, options) => { request = JSON.parse(options.body); return { ok: status === 200, status, body: { cancel: async () => {} } } }
})
vm.runInContext(fs.readFileSync('src/main/local-llm-router.js', 'utf8'), box)
async function run() {
  body = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '譯文' } }] })
  box.options = { temperature: 0, maxTokens: 256, repeatPenalty: false,
    dryRepeatPenalty: { strength: 0.8, base: 1.75, allowedLength: 3 }, customStopTriggers: ['<|endoftext|>'] }
  const result = await vm.runInContext("complete('indextranslate2b', [], 'Hello', options)", box)
  assert.equal(result.responseText, '譯文')
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Hello' }])
  assert.equal(request.chat_template_kwargs.enable_thinking, false)
  assert.equal(request.repeat_penalty, 1)
  assert.equal(request.dry_allowed_length, 3)
  assert.equal(request.dry_multiplier, 0.8)
  assert.deepEqual(request.stop, ['<|endoftext|>'])
  status = 500
  body = 'private-upstream-text'
  await assert.rejects(vm.runInContext("complete('indextranslate2b', [], 'x', {})", box), /HTTP 500/)
  status = 200
  await assert.rejects(vm.runInContext("complete('indextranslate2b', [], 'x', {})", box), /回應格式錯誤/)
  console.log('PASS router 請求、單輪 prompt、關思考與錯誤不外洩')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
