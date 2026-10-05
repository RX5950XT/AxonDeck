'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { tempDir, removeTree } = require('./lib/test-temp')
const providers = require('../src/main/ccswitch/providers')
const service = require('../src/main/ccswitch')
const modelsScan = require('../src/main/ccswitch/models-scan')
const home = tempDir('axondeck-cc-model-refresh-')
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
  const created = await providers.create({ presetId: 'custom', baseUrl: 'https://isolated.invalid/v1', apiFormat: 'openai_chat', apiKey: 'isolated-key', sonnetModel: 'retired' })
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
  assert.equal((await providers.getRaw(created.id)).sonnetModel, 'retired', '掃描不改使用者模型映射')

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
  console.log('PASS CC 模型：每天更新、重啟保留時間、lab 分組、世代排序、清單與草稿保護')
}

function checkDropdown() {
  class Element {
    constructor(tagName = '') { this.tagName = tagName; this.children = []; this.value = ''; this.textContent = ''; this.classList = { toggle() {} } }
    get options() { return this.children.flatMap((child) => child.tagName === 'optgroup' ? child.options : [child]) }
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
  const grouping = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/cc-model-groups.js'), 'utf8').replace(/^export /gm, '')
  const context = vm.createContext({
    window: { electronAPI: {} },
    document: { getElementById: get, createElement: (tag) => new Element(tag) },
    syncCustomSelects() {}, createGridReorder: () => ({})
  })
  vm.runInContext(grouping + '\n' + source + `\nproviders = [{ id: 'p', presetId: 'codex', sonnetModel: 'retired', availableModels: ['fresh'] }];
    editingProviderId = 'p'; catalog = { presets: [{ id: 'codex', defaults: { sonnetModel: 'retired' } }] };
    field('ccSonnetInput').value = 'draft';
    rebuildModelSelects(['fresh']);`, context)
  const choices = () => JSON.parse(vm.runInContext('JSON.stringify(modelGroups)', context))
  assert.deepEqual(choices().flatMap((group) => group.models), ['fresh'], '下架模型與舊預設不能併回清單')
  assert.equal(get('ccSonnetInput').value, 'draft', '更新清單不蓋掉未儲存的輸入')
  checkGroups(context, choices)
  checkGeneration(context)
}

function checkGeneration(context) {
  const samples = ['Qwen/Qwen3.9-235B', 'Qwen/Qwen3.10-Max-0902', 'Qwen/Qwen3.10-Max',
    'Qwen/Qwen3.10-Max-Preview', 'gpt-oss:120b', 'gpt-6-luna', 'gemma4:31b', 'gemma3:270b',
    'claude-haiku-4-5-20251001', 'claude-opus-5', 'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4-pro', 'qwen3.8-max', 'openai/o3', 'mystery-99', 'qwen3.8-max', null, '']
  const original = [...samples]
  const groups = JSON.parse(vm.runInContext(`JSON.stringify(groupCcModels(${JSON.stringify(samples)}))`, context))
  const values = (label) => groups.find((group) => group.label === label).models
  assert.deepEqual(values('Alibaba · Qwen'), ['Qwen/Qwen3.10-Max', 'Qwen/Qwen3.10-Max-0902', 'Qwen/Qwen3.10-Max-Preview', 'Qwen/Qwen3.9-235B', 'qwen3.8-max'], '3.10 比 3.9 新，同代正式版在 preview 前面')
  assert.deepEqual(values('OpenAI'), ['gpt-6-luna', 'openai/o3', 'gpt-oss:120b'], '參數量不能當世代')
  assert.deepEqual(values('Google'), ['gemma4:31b', 'gemma3:270b'])
  assert.deepEqual(values('Anthropic'), ['claude-opus-5', 'claude-haiku-4-5-20251001'], '日期不能當世代')
  assert.deepEqual(values('DeepSeek'), ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro'])
  assert.deepEqual(samples, original, '不改輸入清單')
  assert.equal(groups.flatMap((group) => group.models).length, 15, '只去重與排除無效值，不丟陌生模型')
}

function checkGroups(context, choices) {
  const models = ['mystery-99', 'gpt-5.6-luna', 'moonshotai/Kimi-K2.6', 'Qwen/Qwen3.7-Max',
    'claude-opus-4-8', 'z-ai/glm-5.2', 'MiniMaxAI/MiniMax-M2.7', 'Qwen/Qwen3.8-Max',
    'claude-sonnet-5-5', 'gpt-6.1-sol', 'moonshotai/Kimi-K3', 'MiniMaxAI/MiniMax-M3', 'zai-org/GLM-5.3']
  vm.runInContext(`field('ccSonnetInput').value = 'gpt-5.6-luna'; rebuildModelSelects(${JSON.stringify(models)});`, context)
  const groups = choices()
  assert.deepEqual(groups.map((group) => group.label), ['Anthropic', 'OpenAI', 'Alibaba · Qwen', 'Moonshot AI · Kimi', 'Z.ai · GLM', 'MiniMax', '其他／未分類'], '主流 AI lab 分組在前，未知模型在最後')
  assert.deepEqual(groups[0].models, ['claude-sonnet-5-5', 'claude-opus-4-8'], 'Claude 世代排序不能受 Sonnet／Opus 字母影響')
  for (const [index, newest] of [[1, 'gpt-6.1-sol'], [2, 'Qwen/Qwen3.8-Max'], [3, 'moonshotai/Kimi-K3'], [4, 'zai-org/GLM-5.3'], [5, 'MiniMaxAI/MiniMax-M3']]) {
    assert.equal(groups[index].models[0], newest, '各家較新世代在上面')
  }
  assert.equal(vm.runInContext("field('ccSonnetInput').value", context), 'gpt-5.6-luna', '分類不改原本選擇')
  assert.deepEqual(groups.flatMap((group) => group.models).sort(), [...models].sort(), '分類不增刪或改寫上游 ID')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  globalThis.fetch = originalFetch
  removeTree(home)
})
