/** node scripts/test-asr-router.js：兩顆模型、router 路由、停止載入與錯誤邊界。 */
const assert = require('assert/strict')
const fs = require('fs')
const vm = require('vm')
const source = fs.readFileSync(require('path').join(__dirname, '../src/main/llama-asr.js'), 'utf8')
let resolveLoad
let delayLoad = false
const loaded = new Set()
const hf = {
  init() {}, writePresets: async () => {}, ensureRuntime: async () => {},
  refreshModels: async () => [{ id: 'qwen3asr' }, { id: 'qwen3asrgpu' }],
  endpoint: () => ({ baseUrl: 'http://127.0.0.1/v1', apiKey: 'test' }),
  loadModel: async (key) => { if (delayLoad) await new Promise((r) => { resolveLoad = r }); loaded.add(key); return true },
  unloadModel: async (key) => { loaded.delete(key); return true }
}
let sent, response = { ok: true, json: async () => ({ text: 'language Chinese<asr_text>公园散步' }) }
const ctx = vm.createContext({ module: { exports: {} }, FormData, Blob, AbortSignal, fetch: async (url, req) => { sent = { url, req }; return response }, require: (id) => {
  if (id === 'electron') return { app: { getPath: () => 'test' } }
  if (id === './models') return { isAsrKey: (key) => ['qwen3asr', 'qwen3asrgpu'].includes(key), isDownloaded: () => true }
  if (id === './hfmodels') return hf
  if (id === './cloud-asr') return { normalizeSamples: (s) => s, float32ToWav: () => new Uint8Array(2) }
  return { shouldS2twpSource: (text, lang) => { assert.equal(lang, 'zh-TW'); return !!text }, s2twp: (text) => text.replace('园', '園') }
} })
vm.runInContext(source, ctx)
const big = ctx.module.exports, small = big.createAsr('qwen3asr')
async function run() {
  assert.equal((await small.warm()).ok, true)
  assert.equal((await big.warm()).ok, true)
  assert.equal(loaded.size, 2)
  assert.equal(await small.transcribe({ samples: [0], lang: 'zh-TW' }), '公園散步')
  assert.equal(sent.req.body.get('model'), 'qwen3asr')
  assert.equal(sent.url, 'http://127.0.0.1/v1/audio/transcriptions')
  await big.unload()
  assert.equal(small.isLoaded(), true)
  await small.unload()
  delayLoad = true
  const warming = small.warm()
  while (!resolveLoad) await new Promise((r) => setImmediate(r))
  const stopping = small.unload()
  resolveLoad()
  assert.equal((await warming).ok, false)
  await stopping
  assert.equal(small.isLoaded(), false)
  assert.equal(loaded.size, 0)
  delayLoad = false
  response = { ok: false, status: 502, body: { cancel: async () => {} } }
  await assert.rejects(small.transcribe({ samples: [0] }), /HTTP 502/)
  response = { ok: true, json: async () => ({}) }
  await assert.rejects(small.transcribe({ samples: [0] }), /格式錯誤/)
  assert.throws(() => big.createAsr('unknown'), /未知/)
  console.log('PASS ASR router：兩模型獨立、正確路由、繁中、載入取消與錯誤邊界')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
