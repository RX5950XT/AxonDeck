/** 設定一致性回歸：node scripts/test-settings-consistency.js，不用真 Key／模型／使用者資料。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const cloud = require('../src/main/cloud-asr')
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n')
const main = read('src/main/main.js')
const picker = vm.createContext({})
const rendererSource = (file) => read(file).replace(/^import .*$/gm, '').replace(/\bexport /g, '')
vm.runInContext(rendererSource('src/renderer/scripts/model-picker.js'), picker)
const dictation = vm.createContext(picker)
vm.runInContext(rendererSource('src/renderer/scripts/dictation-page.js'), dictation)

function makeStore(initial) {
  const data = { ...initial }
  return {
    data,
    get: (key, fallback) => Object.hasOwn(data, key) ? data[key] : fallback,
    has: (key) => Object.hasOwn(data, key),
    set: (key, value) => { data[key] = value }
  }
}
function migrate(store) {
  const begin = main.indexOf('function migrateAsrClouds(')
  const end = main.indexOf('function translateProviderModels(', begin)
  const ctx = vm.createContext({ store, cloud })
  vm.runInContext(main.slice(begin, end), ctx)
  vm.runInContext('migrateAsrClouds(cloud)', ctx)
}

let passed = 0
let failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`) }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`) }
}

async function testEngine() {
  const keys = ['linguaforge08q4', 'qwen35translate', 'qwen354b']
  const ctx = vm.createContext({ module: { exports: {} }, console, require: (id) => {
    if (id === 'path') return path
    if (id === './models') return { MODELS: {}, LLM_MODEL_KEYS: keys, isLlmKey: (key) => keys.includes(key), isDownloaded: () => true }
    if (id === './gpu-capability') return { detectGpuCapability: async () => ({ ok: true }) }
    return {}
  } })
  vm.runInContext(read('src/main/local-llm.js') + '\nmodule.exports.inspectConfig = async () => ({ model: resolveLocalTranslateModel(), gpu: await resolveWantGpu() });', ctx)
  const llm = ctx.module.exports
  let asrStore = null
  const engine = vm.createContext({ module: { exports: {} }, require: (id) => {
    if (id === './local-llm') return llm
    if (id === './asr-select') return { setStore: (s) => { asrStore = s } }
    return {}
  } })
  vm.runInContext(read('src/main/engine.js'), engine)
  const store = makeStore({ localTranslateModel: 'qwen354b', llmGpu: true })
  engine.module.exports.setStore(store)
  assert.equal(asrStore, store)
  const config = await llm.inspectConfig()
  assert.equal(config.model, 'qwen354b')
  assert.equal(config.gpu, true)
}

async function testBanner() {
  const source = read('src/renderer/scripts/chat-page.js')
  const begin = source.indexOf('async function refreshBanner()')
  const end = source.indexOf('function showError(', begin)
  const store = makeStore({ chatProviders: [], chatProviderId: '__local' })
  let current = { providers: [{ id: '__local', name: '本機模型', models: ['test'], local: true, hasApiUrl: true, hasKey: true }], providerId: '__local' }
  const banner = { classList: { toggle: (_, hidden) => { banner.hidden = hidden } } }
  const text = {}
  const ctx = vm.createContext({ bannerEl: banner, bannerTextEl: text,
    electronAPI: { store, chat: { providerOptions: async () => current } } })
  vm.runInContext(source.slice(begin, end), ctx)
  await vm.runInContext('refreshBanner()', ctx)
  assert.equal(banner.hidden, true)
  current = { providers: [{ id: 'c', name: '雲端', models: ['test'], hasApiUrl: true, hasKey: false }], providerId: 'c' }
  await vm.runInContext('refreshBanner()', ctx)
  assert.equal(banner.hidden, false)
  assert.match(text.textContent, /API Key/)
  current = { providers: [], providerId: '' }
  await vm.runInContext('refreshBanner()', ctx)
  assert.match(text.textContent, /尚未設定聊天供應商/)
}

async function run() {
  await check('第一次載入 engine 就把模型與 GPU 設定交給 LLM', testEngine)
  await check('已刪光的 ASR 清單不重新搬回舊設定', () => {
    const store = makeStore({ asrClouds: [], asrApiKey: 'old-key', asrApiUrl: 'https://example.invalid/v1', asrModelId: 'old-model' })
    migrate(store)
    assert.equal(store.data.asrClouds.length, 0)
    migrate(store)
    assert.equal(store.data.asrClouds.length, 0)
  })
  await check('ASR 清單空白時也不再使用舊 Key', () => {
    const cfg = cloud.readConfig(makeStore({ asrClouds: [], asrApiKey: 'old-key' }), 'dictation')
    assert.equal(cfg.apiKey, '')
  })
  await check('真正舊版的 ASR 設定仍可升級', () => {
    const store = makeStore({ asrApiKey: 'old-key', asrApiUrl: 'https://example.invalid/v1', asrModelId: 'old-model' })
    migrate(store)
    assert.equal(store.data.asrClouds[0].apiKey, 'old-key')
    assert.equal(store.data.asrClouds[0].models[0], 'old-model')
    assert.equal(cloud.readConfig(store, 'file').apiKey, 'old-key')
    assert.equal(cloud.readConfig(makeStore({ asrApiKey: 'old-key' })).apiKey, 'old-key')
  })
  await check('既有 ASR 單模型格式仍升級為清單', () => {
    const store = makeStore({ asrClouds: [{ id: 'c', apiUrl: 'https://example.invalid/v1', apiKey: 'new-key', modelId: 'new-model' }] })
    migrate(store)
    assert.equal(store.data.asrClouds[0].models[0], 'new-model')
  })
  await check('本機聊天不誤報缺供應商，雲端缺 Key 仍提示', testBanner)
  await check('聊天選項回報設定是否完整，但不送出網址與 Key', async () => {
    let handler
    const ctx = vm.createContext({ store: makeStore({ chatProviderId: '__local' }),
      ipcMain: { handle: (_, fn) => { handler = fn } },
      chat: { LOCAL_PROVIDER_ID: '__local', allProviders: () => [{ id: '__local', name: '本機', models: ['model'], apiUrl: 'http://127.0.0.1:12345/v1', apiKey: 'private-test-key' }] } })
    const begin = main.indexOf("ipcMain.handle('chat:providerOptions'")
    vm.runInContext(main.slice(begin, main.indexOf('\n})', begin) + 3), ctx)
    const result = await handler()
    assert.equal(result.providers[0].hasApiUrl, true)
    assert.equal(result.providers[0].hasKey, true)
    assert.equal(Object.hasOwn(result.providers[0], 'apiKey'), false)
    assert.equal(Object.hasOwn(result.providers[0], 'apiUrl'), false)
  })
  for (const [apiUrl, apiKey, expected] of [
    ['', 'key', '缺 API URL'], ['https://example.invalid/v1', '', '缺 API Key'], ['', '', '缺 API URL、API Key'], ['https://example.invalid/v1', 'key', '']
  ]) {
    await check(`轉錄／翻譯／整理選單精確提示：${expected || '完整'}`, () => {
      picker.settings = { asrClouds: [{ id: 'c', name: '測試', apiUrl, apiKey, models: ['model'] }], chatProviders: [{ id: 'c', name: '測試', apiUrl, apiKey, models: ['model'] }] }
      const options = vm.runInContext('[asrOptions({}, settings)[0], translateOptions({}, settings)[0], cleanupOptions({}, settings)[1]]', picker)
      for (const option of options) {
        assert.equal(option.ready, !expected)
        if (expected) {
          assert.ok(option.label.endsWith(`（${expected}）`), option.label)
        } else assert.ok(!option.label.includes('缺 '), option.label)
      }
    })
  }
  console.log(`${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
run().catch((e) => { console.error(e); process.exitCode = 1 })
