'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
let body, request, status = 200
const hfmodels = { endpoint: () => ({ baseUrl: 'http://127.0.0.1/v1', apiKey: 'test-key' }) }
const box = vm.createContext({ module: { exports: {} }, AbortSignal,
  require: (id) => id === './hfmodels' ? hfmodels : { readResponseText: async () => body },
  fetch: async (_url, options) => {
    request = JSON.parse(options.body)
    if (status === 0) return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    return { ok: status === 200, status, body: { cancel: async () => {} } }
  }
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
  body = '{"choices":[{"finish_reason":"stop","message":{"content":"�件 �"}}]}'
    .replace(/�/g, '\\udce6')
  const dirty = await vm.runInContext("complete('indextranslate2b', [], 'x', {})", box)
  assert.equal(dirty.responseText, '�件 �')
  assert(!/[\uD800-\uDFFF]/.test(dirty.responseText), '孤立替代字要換成 �，不能往下傳')
  body = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '𠮷野家 😀' } }] })
  const astral = await vm.runInContext("complete('indextranslate2b', [], 'x', {})", box)
  assert.equal(astral.responseText, '𠮷野家 😀', '成對的代理字不能被拆掉')
  status = 0
  const controller = new AbortController()
  box.options = { signal: controller.signal }
  const pending = vm.runInContext("complete('indextranslate2b', [], 'x', options)", box)
  controller.abort(new Error('PDF cancelled'))
  await assert.rejects(pending, /PDF cancelled/)
  console.log('PASS router 請求、單輪 prompt、關思考與錯誤不外洩')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
