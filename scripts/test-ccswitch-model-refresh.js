'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { tempDir, removeTree } = require('./lib/test-temp')
const providers = require('../src/main/ccswitch/providers')
const service = require('../src/main/ccswitch')
const modelsScan = require('../src/main/ccswitch/models-scan')
const home = tempDir('voiceink-cc-model-refresh-')
const bag = new Map()
providers.configure({ getStore: async () => ({ get: (key, fallback) => bag.get(key) ?? fallback, set: (key, value) => bag.set(key, value) }) })
require('../src/main/ccswitch/claude-settings').configure({ homeDir: home, backupDir: path.join(home, 'backup') })
modelsScan.configure({ acquire: async () => ({ token: 'isolated-test-token', accountId: 'isolated-account' }) })
const originalFetch = globalThis.fetch
let payload = { data: [{ id: 'fresh' }] }
let status = 200
let calls = 0
globalThis.fetch = async () => {
  calls++
  return { ok: status === 200, status, text: async () => JSON.stringify(payload) }
}

async function main() {
  const created = await providers.create({ presetId: 'custom', baseUrl: 'https://isolated.invalid/v1', apiFormat: 'openai_chat', apiKey: 'isolated-key', model: 'retired' })
  await service.scanProviderModels(created.id)
  assert.deepEqual((await providers.getRaw(created.id)).availableModels, ['fresh'], '成功掃描必須持久化最新模型清單')
  payload = { data: [{ id: 'next' }] }
  await service.scanProviderModels(created.id)
  assert.deepEqual((await providers.list()).providers.find((item) => item.id === created.id).availableModels, ['next'], '新清單取代舊清單')
  status = 503
  await service.scanProviderModels(created.id)
  assert.deepEqual((await providers.getRaw(created.id)).availableModels, ['next'], '斷線不刪模型')
  status = 200
  payload = { data: [] }
  assert.equal((await service.scanProviderModels(created.id)).ok, true, '合法空清單是成功掃描')
  assert.deepEqual((await providers.getRaw(created.id)).availableModels, [], '合法空清單移除全部舊模型')
  payload = { error: 'not-a-model-list' }
  assert.equal((await service.scanProviderModels(created.id)).ok, false, '畸形回應不可當空清單')
  assert.equal((await providers.getRaw(created.id)).model, 'retired', '掃描不改使用者模型映射')

  let release
  globalThis.fetch = async () => {
    calls++
    await new Promise((resolve) => { release = resolve })
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'late' }] }) }
  }
  const before = calls
  const first = service.scanProviderModels(created.id)
  const second = service.scanProviderModels(created.id)
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  await providers.update(created.id, { apiKey: 'changed-key' })
  release()
  const results = await Promise.all([first, second])
  assert.equal(calls - before, 1, '同一供應商並行掃描只打一次')
  assert(results.every((result) => !result.ok && result.code === 'STALE'), '改過認證後晚到的結果不能進畫面')
  assert.equal((await providers.getRaw(created.id)).availableModels, null, '換認證後清掉舊快取')

  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'automatic' }] }) })
  let refreshTick
  const originalInterval = globalThis.setInterval
  globalThis.setInterval = (fn, milliseconds) => {
    assert.equal(milliseconds, 24 * 60 * 60_000, '自動更新間隔一天')
    refreshTick = fn
    return { unref() {} }
  }
  try { await service.listProviders() } finally { globalThis.setInterval = originalInterval }
  for (let attempt = 0; attempt < 50 && !(await providers.getRaw(created.id)).availableModels; attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual((await providers.getRaw(created.id)).availableModels, ['automatic'], '供應商載入時自動掃全部供應商')

  const originalNow = Date.now
  const cached = (await providers.getRaw(created.id)).modelsCheckedAt
  assert(cached > 0, '保存掃描時間')
  const servicePath = require.resolve('../src/main/ccswitch')
  delete require.cache[servicePath]
  const restarted = require(servicePath)
  let repeatCalls = 0
  globalThis.fetch = async () => {
    repeatCalls++
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'manual-latest' }] }) }
  }
  globalThis.setInterval = () => ({ unref() {} })
  try { await restarted.listProviders() } finally { globalThis.setInterval = originalInterval }
  for (let attempt = 0; attempt < 10; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(repeatCalls, 0, '重啟後一天內不可再次自動掃描')
  await restarted.scanProviderModels(created.id)
  assert.equal(repeatCalls, 1, '手動刷新不受一天限制')
  assert.deepEqual((await providers.getRaw(created.id)).availableModels, ['manual-latest'])
  Date.now = () => originalNow() + 24 * 60 * 60_000 + 1000
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'timer-latest' }] }) })
  try {
    refreshTick()
    for (let attempt = 0; attempt < 50 && !(await providers.getRaw(created.id)).availableModels?.includes('timer-latest'); attempt++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.deepEqual((await providers.getRaw(created.id)).availableModels, ['timer-latest'], '沒有 renderer 呼叫時 main 定時更新')
  } finally { Date.now = originalNow }

  let grokHeaders
  await modelsScan.scanProviderModels({ presetId: 'grok-build' }, { fetchImpl: async (url, options) => {
    grokHeaders = options.headers
    return { ok: true, status: 200, text: async () => '{"data":[{"id":"grok"}]}' }
  } })
  assert.equal(grokHeaders['x-grok-client-version'], '1.0.13', 'Grok 模型掃描帶 CLI 版本標頭')

  checkDropdown()
  console.log('PASS CC 模型：每天更新、重啟保留時間、手動即時刷新、清單與草稿保護')
}

function checkDropdown() {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.classList = { toggle() {} } }
    get options() { return this.children }
    append(node) { this.children.push(node) }
    replaceChildren() { this.children = [] }
    closest() { return null }
  }
  const elements = new Map()
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)
  }
  get('ccProviderDialog').open = true
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ccswitch-page.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const context = vm.createContext({
    window: { electronAPI: {} },
    document: { getElementById: get, createElement: () => new Element() },
    syncCustomSelects() {}, createGridReorder: () => ({})
  })
  vm.runInContext(source + `\nproviders = [{ id: 'p', presetId: 'codex', model: 'retired', availableModels: ['fresh'] }];
    editingProviderId = 'p'; catalog = { presets: [{ id: 'codex', defaults: { model: 'retired' } }] };
    field('ccModelInput').value = 'draft'; field('ccModelSelect').value = 'draft';
    rebuildModelSelects(['fresh']);`, context)
  assert.deepEqual(get('ccModelSelect').options.map((option) => option.value), ['', 'fresh'], '下架模型與舊預設不能併回下拉')
  assert.equal(get('ccModelInput').value, 'draft', '更新清單不蓋掉未儲存的選擇')
  assert.equal(vm.runInContext('modelManual', context), true, '清單外草稿保留在手動欄位')
  vm.runInContext('toggleModelMode()', context)
  assert.equal(vm.runInContext('modelManual', context), false)
  assert(!get('ccModelSelect').options.some((option) => option.value === 'draft'), '切回下拉不能把清單外模型補回去')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  globalThis.fetch = originalFetch
  removeTree(home)
})
