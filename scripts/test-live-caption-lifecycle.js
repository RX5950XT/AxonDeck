'use strict'
/** 真正的字幕與引擎生命週期；只替換模型載入、音源與 DOM，不跑推論。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function createHarness() {
  const loaded = { asr: false, llm: false }, unloads = { asr: 0, llm: 0 }
  const model = kind => ({
    warm: async () => { loaded[kind] = true; return { warnings: [] } },
    unload: async () => { loaded[kind] = false; unloads[kind]++; return { warnings: [] } },
    isLoaded: () => loaded[kind], setStore() {}
  })
  const deps = { './asr-select': model('asr'), './local-llm': model('llm'), './model-scope': { readLlm: () => ({ mode: 'local', modelKey: 'llm' }) } }
  const main = { require: name => deps[name], module: { exports: {} } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/engine.js'), 'utf8'), main)
  const engine = main.module.exports
  const nodes = new Map(), events = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: 'zh-TW', style: {}, textContent: '', disabled: false,
      classList: { toggle() {} }, addEventListener() {}, querySelector: key => node(id + key)
    })
    return nodes.get(id)
  }
  let closed
  const context = {
    console, setTimeout, Float32Array, syncCustomSelects() {}, refreshLiveHistory() {}, newTranscriptId: () => 'live-test',
    getSettings: async () => ({}), readScope: async () => ({ asr: 'local:asr', llm: 'local:llm' }),
    parseAsrValue: () => ({ engine: 'local', modelKey: 'asr' }), parseLlmValue: () => ({ mode: 'local', modelKey: 'llm' }),
    resolveTranslateModelKey: () => 'llm', showToast: message => { throw new Error(message) },
    document: { getElementById: node, addEventListener: (event, handler) => events.set(event, handler) },
    MediaStream: class { constructor(tracks) { this.tracks = tracks } },
    openRecordingAudio: async () => {
      const track = { addEventListener() {} }
      return { stream: { getAudioTracks: () => [track] }, tracks: [track], close: async () => {} }
    },
    electronAPI: {
      engine, store: { get: async (_key, fallback) => fallback },
      models: { status: async () => ({ models: { asr: { downloaded: true }, llm: { downloaded: true } } }) },
      subtitle: { onClosed: fn => { closed = fn }, show: async () => true, close: async () => closed() }
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/live-caption.js'), 'utf8')
    .replace(/^import [\s\S]*?from '[^']*'$/gm, '').replace(/^export /gm, '')
  vm.createContext(context)
  vm.runInContext(`${source}\nstartPcmCapture = async () => {};
    this.api = { startCapture, stopCapture, prewarmEngine, cooldownEngine, initLiveCaption,
      processing: value => { isProcessing = value }, state: () => ({ isCapturing, isStopping }) }`, context)
  context.api.initLiveCaption()
  return { api: context.api, engine, loaded, unloads, closeWindow: () => closed(), settingsChanged: () => events.get('settings-changed')() }
}

async function main() {
  const h = createHarness()
  await h.api.prewarmEngine()
  await h.api.startCapture()
  assert.equal(h.api.state().isCapturing, true)
  assert.equal(h.engine.status().users.live, true)
  for (let i = 0; i < 3; i++) await h.api.cooldownEngine()
  await h.settingsChanged()
  await h.engine.release('translate')
  assert.deepEqual(h.loaded, { asr: true, llm: true }, '字幕開啟時，切頁、設定通知或其他工具釋放都不能卸載模型')
  assert.deepEqual(h.unloads, { asr: 0, llm: 0 })
  console.log('PASS 字幕開啟時持續保留本地 ASR 與翻譯模型')

  h.api.processing(true)
  const stopping = h.api.stopCapture()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.engine.status().users.live, true, '停止時先等進行中的辨識完成')
  h.api.processing(false)
  await stopping
  assert.equal(h.engine.status().users.live, false)
  assert.deepEqual(h.loaded, { asr: false, llm: false })
  assert.deepEqual(h.unloads, { asr: 1, llm: 1 }, '停止字幕後各卸載一次')
  console.log('PASS 停止字幕等辨識完成後才卸載模型')

  await h.api.startCapture()
  await h.api.cooldownEngine()
  h.closeWindow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.api.state().isCapturing, false)
  assert.equal(h.engine.status().users.live, false)
  assert.deepEqual(h.loaded, { asr: false, llm: false })
  assert.deepEqual(h.unloads, { asr: 2, llm: 2 }, '關閉字幕視窗等同停止並釋放模型')
  console.log('PASS 切頁後關閉字幕視窗仍停止並卸載模型')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
