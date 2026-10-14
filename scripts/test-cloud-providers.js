/** npx electron scripts/test-cloud-providers.js */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { app } = require('electron')
const { tempDir } = require('./lib/test-temp')
app.setPath('userData', tempDir('cloud-providers-'))
const cloud = require('../src/main/cloud-providers')
const { classifyModel } = require('../src/shared/cloud-model-types.mjs')

let failed = 0
let passed = 0
function test(name, run) {
  try { run(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
}
function store(initial = {}) {
  return { data: structuredClone(initial), writes: 0,
    get(key, fallback) { return Object.hasOwn(this.data, key) ? this.data[key] : fallback },
    has(key) { return Object.hasOwn(this.data, key) },
    set(values) { Object.assign(this.data, structuredClone(values)); this.writes++ } }
}
const provider = (id, models, extra = {}) => ({ id, name: id, apiUrl: 'https://example.test/v1', apiKey: 'test-key', models, ...extra })

if (process.argv.includes('--collision')) {
  const id = 'a_'.repeat(20)
  const state = store({ chatProviders: [provider(id, ['chat'])], asrClouds: [provider(id, ['asr'], { apiKey: 'other-key' })] })
  cloud.write(state, cloud.read(state))
  assert.equal(state.data.chatProviders[0].id, id)
  assert.equal(state.data.asrClouds[0].id, id)
  assert.equal(new Set(state.data.cloudProviders.map((p) => p.id)).size, 2)
  app.exit(0)
}

test('40-character legacy id collision terminates and preserves selections', () => {
  const child = spawnSync(process.execPath, [__filename, '--collision'], { timeout: 8000, encoding: 'utf8', windowsHide: true })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr || child.stdout)
})

test('migration merges same endpoint and key while preserving legacy selections', () => {
  const state = store({ chatProviders: [provider('chat-old', ['gpt-4o', 'image-model'], { imageModels: ['image-model'] })],
    asrClouds: [provider('asr-old', ['whisper-1'], { apiUrl: 'https://example.test/v1/' })] })
  const list = cloud.read(state)
  assert.equal(list.length, 1)
  assert.equal(list[0].chatId, 'chat-old')
  assert.equal(list[0].asrId, 'asr-old')
  assert.deepEqual(list[0].models.map((m) => m.type), ['chat', 'image', 'asr'])
  assert.equal(state.writes, 0)
  cloud.write(state, list)
  assert.equal(state.data.chatProviders[0].id, 'chat-old')
  assert.equal(state.data.asrClouds[0].id, 'asr-old')
})

test('different credentials and colliding legacy ids remain separate', () => {
  const state = store({ chatProviders: [provider('same', ['chat-model'])],
    asrClouds: [provider('same', ['asr-model'], { apiKey: 'other-key' })] })
  const list = cloud.read(state)
  assert.equal(list.length, 2)
  assert.equal(new Set(list.map((p) => p.id)).size, 2)
  cloud.write(state, list)
  assert.equal(state.data.chatProviders[0].id, 'same')
  assert.equal(state.data.chatProviders[0].apiKey, 'test-key')
  assert.equal(state.data.asrClouds[0].id, 'same')
  assert.equal(state.data.asrClouds[0].apiKey, 'other-key')
})

test('multiple ASR providers never lose their legacy selection ids', () => {
  const state = store({ chatProviders: [provider('chat', ['chat-model'])],
    asrClouds: [provider('first', ['asr-1']), provider('second', ['asr-2'])] })
  cloud.write(state, cloud.read(state))
  assert.deepEqual(state.data.asrClouds.map((p) => p.id).sort(), ['first', 'second'])
})

test('write projects only supported target types in one store write', () => {
  const state = store()
  const types = ['chat', 'image', 'asr', 'tts', 'unknown', 'unsupported']
  cloud.write(state, [provider('all', types.map((type) => ({ id: `${type}-model`, type })))])
  assert.equal(state.writes, 1)
  assert.deepEqual(state.data.chatProviders[0].models, ['chat-model', 'image-model'])
  assert.deepEqual(state.data.chatProviders[0].imageModels, ['image-model'])
  assert.deepEqual(state.data.asrClouds[0].models, ['asr-model'])
  assert.deepEqual(state.data.cloudProviders[0].models.map((m) => m.type), types)
})

test('unknown-only providers do not enter any existing model menu', () => {
  const state = store()
  cloud.write(state, [provider('unknown', [{ id: 'custom-model', type: 'unknown' }])])
  assert.deepEqual(state.data.chatProviders, [])
  assert.deepEqual(state.data.asrClouds, [])
  assert.equal(cloud.read(state)[0].models[0].type, 'unknown')
})

test('explicit empty list never resurrects old providers', () => {
  const state = store({ cloudProviders: [], chatProviders: [provider('old', ['gpt-4o'])] })
  assert.deepEqual(cloud.read(state), [])
  cloud.write(state, [])
  assert.deepEqual(state.data.chatProviders, [])
  assert.deepEqual(cloud.read(state), [])
})

test('fresh configuration gets OpenRouter; deliberate empty legacy configuration stays empty', () => {
  assert.equal(cloud.read(store())[0].apiUrl, 'https://openrouter.ai/api/v1')
  assert.deepEqual(cloud.read(store({ chatProviders: [], asrClouds: [] })), [])
})

test('old maximum 10 chat and 20 ASR providers migrate without data loss', () => {
  const chatProviders = Array.from({ length: 10 }, (_, i) => provider(`chat${i}`, Array.from({ length: 30 }, (_, m) => `chat-${m}`), { apiKey: `chat-key-${i}` }))
  const asrClouds = Array.from({ length: 20 }, (_, i) => provider(`asr${i}`, Array.from({ length: 30 }, (_, m) => `asr-${m}`), { apiKey: `asr-key-${i}` }))
  const state = store({ chatProviders, asrClouds })
  cloud.write(state, cloud.read(state))
  assert.equal(state.data.cloudProviders.length, 30)
  assert.equal(state.data.chatProviders.length, 10)
  assert.equal(state.data.asrClouds.length, 20)
  assert.equal(state.data.cloudProviders.reduce((sum, p) => sum + p.models.length, 0), 900)
})

test('merging two old 30-model providers preserves all 60 models', () => {
  const state = store({ chatProviders: [provider('chat', Array.from({ length: 30 }, (_, i) => `chat-${i}`))],
    asrClouds: [provider('asr', Array.from({ length: 30 }, (_, i) => `asr-${i}`))] })
  cloud.write(state, cloud.read(state))
  assert.equal(state.data.cloudProviders[0].models.length, 60)
  assert.equal(state.data.chatProviders[0].models.length, 30)
  assert.equal(state.data.asrClouds[0].models.length, 30)
})

test('AGY sync is idempotent, refreshes credentials, and retains user model types', () => {
  const state = store({ cloudProviders: [] })
  cloud.syncAntigravity(state, { running: false })
  assert.equal(state.writes, 0)
  const endpoint = { running: true, baseUrl: 'http://127.0.0.1:1234', apiKey: 'key1' }
  cloud.syncAntigravity(state, endpoint)
  assert.equal(state.writes, 1)
  cloud.syncAntigravity(state, endpoint)
  assert.equal(state.writes, 1)
  state.data.cloudProviders[0].models = [{ id: 'custom-tts', type: 'tts' }]
  cloud.syncAntigravity(state, { ...endpoint, apiKey: 'key2' })
  assert.equal(state.writes, 2)
  assert.equal(state.data.cloudProviders[0].apiKey, 'key2')
  assert.deepEqual(state.data.cloudProviders[0].models, [{ id: 'custom-tts', type: 'tts' }])
})

test('sanitizer rejects ambiguous IDs and unsafe endpoints without writing', () => {
  const state = store()
  assert.throws(() => cloud.write(state, [provider('same', []), provider('same', [])]))
  assert.throws(() => cloud.write(state, [provider('p', [], { apiUrl: 'https://key@example.test' })]))
  assert.throws(() => cloud.write(state, [provider('p', [{ id: 'm', type: 'chat' }, { id: 'm', type: 'asr' }])]))
  assert.equal(state.writes, 0)
})

test('classifier prioritizes explicit endpoints and output over name heuristics', () => {
  assert.equal(classifyModel({ id: 'whisper-looking', supported_endpoints: ['/v1/audio/speech'] }), 'tts')
  assert.equal(classifyModel({ id: 'tts-looking', supported_endpoints: ['/v1/audio/transcriptions'] }), 'asr')
  assert.equal(classifyModel({ id: 'gpt-4o', architecture: { output_modalities: ['image', 'text'] } }), 'image')
  assert.equal(classifyModel({ id: 'gpt-4o', architecture: { output_modalities: ['video'] } }), 'unsupported')
  assert.equal(classifyModel({ id: 'custom', architecture: { input_modalities: ['audio'], output_modalities: ['text'] } }), 'chat')
  assert.equal(classifyModel({ id: 'custom', architecture: { output_modalities: ['audio'] } }), 'tts')
  assert.equal(classifyModel('whisper-1'), 'asr')
  assert.equal(classifyModel('gpt-4o-mini-tts'), 'tts')
  assert.equal(classifyModel('gpt-image-1'), 'unsupported')
  assert.equal(classifyModel('totally-new-model'), 'unknown')
})

test('classifier ignores malformed remote metadata without crashing or guessing', () => {
  for (const raw of [null, 4, {}, { id: { toString: 1 } }, { id: 'new', supported_endpoints: [{ toString: 1 }, null, 4] },
    { id: 'new', architecture: { output_modalities: 'audio' } }, { id: 'new', supported_endpoints: '/audio/speech' }]) {
    assert.equal(classifyModel(raw), 'unknown')
  }
})

console.log(`cloud providers: ${passed} passed, ${failed} failed`)
app.exit(failed ? 1 : 0)
