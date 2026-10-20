'use strict'

/** node scripts/test-screen-translate.js — 執行真實服務程式，只有桌面／模型換成替身。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const { createRequire } = require('module')

function load(file, replacements, globals = {}) {
  const filename = path.resolve(file), realRequire = createRequire(filename)
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(filename),
    Buffer, structuredClone, AbortController, AbortSignal, setTimeout, clearTimeout, process, ...globals,
    require: (id) => id in replacements ? replacements[id] : realRequire(id) })
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  return context.module.exports
}

const capture = load('src/main/screen-translate/capture.js', { electron: {} })
const plain = (value) => JSON.parse(JSON.stringify(value))
assert.deepEqual(plain(capture.cropRect({ x: -1800, y: 100, width: 500, height: 200 },
  { x: -1920, y: 0, width: 1920, height: 1080 }, { width: 2880, height: 1620 })), { x: 180, y: 150, width: 750, height: 300 })
assert.throws(() => capture.cropRect({ x: -10, y: 0, width: 100, height: 20 },
  { x: 0, y: 0, width: 1920, height: 1080 }, { width: 1920, height: 1080 }), /同一個螢幕/)
const sample = Buffer.alloc(160 * 96 * 4, 100), cursor = Buffer.from(sample)
cursor[0] = 255
assert.equal(capture.changed(sample, cursor), false)
assert.equal(capture.changed(sample, Buffer.alloc(sample.length, 120)), true)
assert.equal(capture.changed(null, sample), true)

let bounds = null, opacity = 0
let windowCount = 0, win, captures = 0, ocrCalls = 0, translations = 0, released = 0, pixel = 100
let ocrText = 'Hello world', mode = '', prepareFails = false, downloaded = true, now = 10000
const events = [], timers = new Set(), values = { translator: 'local', localTranslateModel: 'linguaforge08q4', theme: 'dark' }
const store = { get: (key, fallback) => values[key] ?? fallback }
class Window extends EventEmitter {
  constructor(options) {
    super(); windowCount++; win = this; this.options = options; this.dead = false
    this.webContents = new EventEmitter(); this.webContents.mainFrame = {}
    this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = () => {}
  }
  getContentBounds() { return { x: 0, y: 0, width: 720, height: 480 } }
  setMenu() {} setBounds(value) { bounds = value } setOpacity(value) { opacity = value }
  setBackgroundMaterial(value) { assert.equal(value, 'none') }
  setContentProtection(value) { assert.equal(value, true) }
  setAlwaysOnTop() {} showInactive() {} isVisible() { return true }
  loadFile() { return Promise.resolve() } isDestroyed() { return this.dead }
  destroy() { this.dead = true; this.emit('closed') }
}
const service = load('src/main/screen-translate/index.js', {
  electron: { app: { getPath: () => 'test-user-data' }, BrowserWindow: Window,
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } },
  './capture': { ...capture, capture: async () => { captures++; return { resize: () => ({ toBitmap: () => Buffer.alloc(sample.length, pixel) }), toDataURL: () => 'data:image/png;base64,aGVsbG8=' } } },
  '../models': { MODELS: {}, isDownloaded: () => downloaded },
  '../usage/shared': { readResponseText: (response) => response.text() },
  '../hfmodels': { init() {}, writePresets: async () => {}, ensureRuntime: async () => { if (prepareFails) throw new Error('private endpoint token') },
    refreshModels: async () => [{ id: 'paddleocrvl16' }], endpoint: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'private-key' }) },
  '../model-scope': { readLlm: (snapshot) => ({ mode: 'local', modelKey: snapshot.get('fileLlm').slice(6), value: snapshot.get('fileLlm') }) },
  '../engine': { setStore() {}, acquire: async (owner, needs) => { assert.equal(owner, 'screen'); assert.equal(needs.asr, false); return { ok: true } }, release: async () => { released++ } },
  '../local-llm': { resolveLocalTranslateModel: () => 'linguaforge08q4', translate: async (snapshot, text, lang, options) => {
    translations++
    assert.equal(snapshot.get('localTranslateModel'), 'linguaforge08q4', '開始後固定使用同一個模型快照')
    assert.equal(lang, 'zh-TW'); assert.equal(options.scope, 'file')
    if (mode === 'wait-translation') await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    return '你好世界'
  } }
}, { process: { platform: 'win32' }, Date: { now: () => now }, setTimeout: (fn) => { const timer = { fn }; timers.add(timer); return timer }, clearTimeout: (timer) => timers.delete(timer),
  fetch: async (_url, options) => {
    ocrCalls++
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'paddleocrvl16'); assert.equal(body.messages[0].content[0].text, 'OCR:')
    if (mode === 'wait-ocr') await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    return { ok: true, text: async () => mode === 'bad-json' ? 'private upstream token' : JSON.stringify({ choices: [{ message: { content: ocrText ? `${ocrText}</s>` : '' }, finish_reason: mode === 'too-long' ? 'length' : 'stop' }] }) }
  } })
service.init({ store, send: (channel, state) => events.push({ channel, state: plain(state) }), preload: 'test-preload', isDev: false })
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve() }
const tick = async () => { now += 1000; const timer = [...timers][0]; assert(timer, '有排下一次辨識'); timers.delete(timer); timer.fn(); await flush() }
const options = { sourceLang: 'auto', targetLang: 'zh-TW' }

async function run() {
  assert.throws(() => service.open({}), /語言/)
  downloaded = false; assert.throws(() => service.open(options), /Local SI/); downloaded = true
  service.open(options); service.open(options); await flush()
  assert.equal(windowCount, 1); assert.throws(() => service.assertIdle(), /關閉/)
  assert.equal(service.owns({ sender: win.webContents, senderFrame: win.webContents.mainFrame }), true)
  assert.equal(service.owns({ sender: {}, senderFrame: {} }), false)
  values.localTranslateModel = 'changed-after-open'
  await tick()
  assert.equal(service.status().translation, '你好世界')
  assert.equal(service.status().source, 'Hello world', 'OCR 結束 token 不當作原文')
  assert.equal(opacity, 0.95, '有譯文時調濃方便閱讀')
  service.resize({ x: 10.4, y: 20, width: 50, height: 300 })
  assert.deepEqual(plain(bounds), { x: 10, y: 20, width: 240, height: 300 }, '縮放不小於最小尺寸')
  assert.throws(() => service.resize({ x: 'a', y: 0, width: 300, height: 200 }), /格式/)
  assert.throws(() => service.resize({ x: 5, y: 6 }), /格式/)
  await tick(); assert.equal(ocrCalls, 1, '相同畫面不重跑 OCR'); assert.equal(translations, 1)
  pixel += 20; await tick(); assert.equal(ocrCalls, 2); assert.equal(translations, 1, '相同原文不重翻')
  pixel += 20; ocrText = ''; await tick(); assert.equal(service.status().translation, ''); assert.equal(service.status().stage, 'empty')
  assert.equal(opacity, 0.6, '沒譯文時調淡方便對準')
  service.pause(true); assert.equal(timers.size, 0); assert.throws(() => service.pause('false'), /格式/)
  service.pause(false); pixel += 20; ocrText = 'New text'; mode = 'wait-translation'; await tick()
  service.pause(true); await flush()
  assert.equal(service.status().paused, true); assert.equal(service.status().translation, '', '取消不顯示舊結果')
  mode = ''; service.pause(false); await tick(); assert.equal(service.status().translation, '你好世界')
  pixel += 20; mode = 'bad-json'; await tick()
  assert.equal(service.status().paused, true); assert(!service.status().error.includes('private'), '錯誤不可外洩上游內容')
  mode = 'too-long'; service.pause(false); await tick(); assert.match(service.status().error, /文字太多/)
  mode = 'wait-ocr'; service.pause(false); await tick()
  const closed = service.close(); assert.throws(() => service.open(options), /關閉/); await closed
  assert.equal(service.status().open, false); assert.equal(released, 1); assert.equal(timers.size, 0)
  mode = ''; values.localTranslateModel = 'linguaforge08q4'; prepareFails = true; service.open(options); win.emit('move'); await flush()
  assert.equal(service.status().paused, true, '準備失敗仍顯示錯誤，不被移動事件吞掉')
  assert(!service.status().error.includes('private'))
  prepareFails = false; service.pause(false); await flush(); await tick(); assert.equal(service.status().translation, '你好世界')
  await service.close(); service.assertIdle()
  assert.equal(released, 2)
  assert(captures >= 8)
  let loaded = false
  const engine = load('src/main/engine.js', {
    './local-llm': { setStore() {}, isLoaded: () => loaded, warm: async () => { loaded = true; return {} }, unload: async () => { loaded = false; return {} } },
    './asr-select': { setStore() {}, isLoaded: () => false, warm: () => { throw new Error('螢幕翻譯不載入 ASR') }, unload: async () => ({}) },
    './model-scope': { readLlm: () => ({ mode: 'off' }) }
  })
  await engine.acquire('translate', { llm: true }); await engine.acquire('screen', { llm: true })
  await engine.release('translate'); assert.equal(loaded, true, '切頁不卸載螢幕翻譯模型')
  await engine.unloadAll(); assert.equal(engine.status().users.screen, false); assert.equal(loaded, false)
  const handlers = {}
  require('../src/main/screen-translate/ipc').registerScreenTranslateIpc({
    ipcMain: { handle: (name, handler) => { handlers[name] = handler } }, service,
    isMainSender: (sender) => sender === 'main', isOverlaySender: (sender) => sender === 'overlay'
  })
  assert.equal((await handlers['screenTranslate:open']('overlay', options)).error.code, 'FORBIDDEN')
  assert.equal((await handlers['screenTranslate:pause']('guest', true)).error.code, 'FORBIDDEN')
  assert.equal((await handlers['screenTranslate:status']('overlay')).ok, true)
  console.log('PASS screen translation: DPI/crop, resize, aim/read opacity, change detection, model snapshot, dedup, pause/retry, cancellation, errors, cleanup')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
