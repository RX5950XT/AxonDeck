'use strict'

const path = require('path')
const { DEV_URL } = require('../dev-url')
const { app, BrowserWindow, screen } = require('electron')
const models = require('../models')
const { readResponseText } = require('../usage/shared')
const { splitText } = require('../pdf-translate/protocol')
const { fail, capture, changed } = require('./capture')

const LANGUAGES = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
const MIN_SIZE = { width: 240, height: 110 }
const AIM_OPACITY = 0.6, READ_OPACITY = 0.95
let config
let session = null
let closing = null

function init(options) { config = options }
function status() { return session ? { ...session.view } : { open: false } }
function owns(event) { return !!session && event.sender === session.win?.webContents && event.senderFrame === event.sender.mainFrame }
function assertIdle() { if (session || closing) throw fail('BUSY', '螢幕翻譯正在使用模型，請先關閉取景視窗') }
function publish(job, values) {
  if (session !== job) return
  job.view = { ...job.view, ...values }
  if (job.win.isDestroyed()) return
  // 沒譯文時調淡，方便對準底下的字；有譯文再調濃方便閱讀
  job.win.setOpacity(job.view.translation ? READ_OPACITY : AIM_OPACITY)
  job.win.webContents.send('screenTranslate:state', status())
  config.send('screenTranslate:state', status())
}

function translatorSnapshot() {
  const values = Object.fromEntries(['translator', 'localTranslateModel', 'translateProviderId', 'translateModelId',
    'chatProviders', 'translateGlossary', 'translateGlossaryBuiltin'].map((key) => [key, structuredClone(config.store.get(key))]))
  values.fileLlm = values.translator === 'cloud'
    ? `cloud:${values.translateProviderId || ''}:${values.translateModelId || ''}`
    : `local:${require('../local-llm').resolveLocalTranslateModel(config.store)}`
  const store = { get: (key, fallback) => values[key] ?? fallback }
  const choice = require('../model-scope').readLlm(store, 'file')
  if (choice.value !== values.fileLlm || choice.mode === 'off' || (choice.mode === 'cloud' && (!choice.apiUrl || !choice.apiKey || !choice.modelId))
    || (choice.mode === 'local' && !models.isDownloaded(choice.modelKey))) {
    throw fail('NOT_READY', '請先在翻譯頁選好可使用的翻譯模型')
  }
  return { store, local: choice.mode === 'local', label: `${choice.mode === 'cloud' ? '雲端' : '本機'} · ${choice.modelId || models.MODELS[choice.modelKey]?.label || choice.modelKey}` }
}

function open(options) {
  if (!LANGUAGES.has(options?.targetLang) || (options.sourceLang !== 'auto' && !LANGUAGES.has(options.sourceLang))) {
    throw fail('INVALID_LANGUAGE', '不支援這個翻譯語言')
  }
  if (session) { session.win.showInactive(); return status() }
  if (closing) throw fail('BUSY', '取景視窗正在關閉，請稍候再開啟')
  if (process.platform !== 'win32') throw fail('UNSUPPORTED', '螢幕翻譯目前支援 Windows')
  const missing = ['paddleocrvl16'].filter((key) => !models.isDownloaded(key))
  if (!['llamaruntime', 'llamaruntimecuda'].some((key) => models.isDownloaded(key))) missing.push('llamaruntime')
  if (missing.length) throw fail('NOT_INSTALLED', '請先到 Local SI 安裝 PaddleOCR-VL 與 llama.cpp 執行環境')
  const translator = translatorSnapshot()
  const job = { translator, controller: new AbortController(), prepared: false, timer: null, pending: null,
    image: null, lastMoved: 0, view: { open: true, paused: false, stage: 'preparing', source: '', translation: '', error: '',
      sourceLang: options.sourceLang, targetLang: options.targetLang, model: translator.label, theme: config.store.get('theme', 'dark') } }
  session = job
  try { createWindow(job) } catch (error) { session = null; job.win?.destroy(); throw error }
  job.pending = prepare(job).then(() => { job.prepared = true }).catch((error) => reportError(job, error))
    .finally(() => { job.pending = null; schedule(job) })
  return status()
}

function createWindow(job) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(520, area.width), height = Math.min(200, area.height)
  const win = new BrowserWindow({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    width, height, minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height, show: false, frame: false, transparent: false, backgroundColor: '#14191b',
    resizable: true, maximizable: false, fullscreenable: false, minimizable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: config.preload } })
  job.win = win
  win.setMenu(null)
  win.setBackgroundMaterial('none')
  // 用 setOpacity 做半透明：transparent + resizable 在 Windows 會殘影／失效。
  win.setOpacity(AIM_OPACITY)
  // 擷取時排除自己，才能整窗蓋在字上又讀到底下的畫面
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.once('did-finish-load', () => { publish(job, {}); win.showInactive() })
  win.webContents.on('render-process-gone', () => { void close() })
  const moved = () => {
    if (session !== job) return
    if (job.prepared) job.controller.abort()
    job.lastMoved = Date.now(); job.image = null
    publish(job, { source: '', translation: '', stage: 'waiting' })
    schedule(job)
  }
  win.on('move', moved); win.on('resize', moved)
  win.on('closed', () => { if (session === job) void close() })
  const loaded = config.isDev ? win.loadURL(`${DEV_URL}/pages/screen-translate.html`)
    : win.loadFile(path.join(__dirname, '../../renderer/pages/screen-translate.html'))
  loaded.catch(() => { if (session === job) void close() })
}

async function prepare(job) {
  const hf = require('../hfmodels')
  hf.init({ userDataPath: app.getPath('userData'), store: config.store })
  await hf.writePresets()
  await hf.ensureRuntime()
  if (session !== job) return
  if (!(await hf.refreshModels()).some((row) => row.id === 'paddleocrvl16')) await hf.applyPresets()
  if (session !== job) return
  if (job.translator.local) {
    const engine = require('../engine')
    engine.setStore(config.store)
    const result = await engine.acquire('screen', { asr: false, llm: true })
    job.engineHeld = result.ok
    if (!result.ok) throw fail('NOT_READY', '翻譯模型無法載入，請檢查 Local SI 後重試')
  }
}

function schedule(job) {
  clearTimeout(job.timer)
  if (session !== job || job.view.paused || job.pending || !job.prepared) return
  job.timer = setTimeout(() => {
    job.pending = cycle(job).catch((error) => reportError(job, error))
      .finally(() => { job.pending = null; schedule(job) })
  }, 1000)
}

function reportError(job, error) {
  if (session !== job || (job.prepared && job.controller.signal.aborted)) return
  publish(job, { paused: true, stage: 'error', error: error.userMessage || '辨識或翻譯失敗，請確認模型與連線後按重試' })
}

async function recognize(image, signal) {
  const endpoint = require('../hfmodels').endpoint()
  if (!endpoint) throw fail('NOT_READY', '辨識執行環境未啟動，請關閉取景視窗後重新開啟')
  const response = await fetch(`${endpoint.baseUrl.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
    body: JSON.stringify({ model: 'paddleocrvl16', temperature: 0, max_tokens: 4096, stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'OCR:' }, { type: 'image_url', image_url: { url: image.toDataURL() } }] }] }) })
  if (!response.ok) { await response.body?.cancel(); throw fail('OCR_FAILED', `畫面辨識失敗（HTTP ${response.status}），請檢查 Local SI 後重試`) }
  const result = JSON.parse(await readResponseText(response, 1024 * 1024))
  const choice = result?.choices?.[0]
  if (typeof choice?.message?.content !== 'string') throw fail('OCR_FAILED', '辨識回應格式錯誤，請重試')
  if (choice.finish_reason === 'length') throw fail('TOO_MUCH_TEXT', '框內文字太多，請縮小範圍後重試')
  return choice.message.content.replace(/<\|[^|]*\|>/g, '').replace(/<\/s>\s*$/, '').trim()
}

async function cycle(job) {
  if (Date.now() - job.lastMoved < 700 || !job.win.isVisible()) return
  job.controller = new AbortController()
  const signal = job.controller.signal
  const image = await capture(job.win.getContentBounds())
  signal.throwIfAborted()
  const sample = image.resize({ width: 160, height: 96 }).toBitmap()
  if (!changed(job.image, sample)) { publish(job, { stage: job.view.source ? 'watching' : 'empty' }); return }
  publish(job, { stage: 'ocr', error: '' })
  const source = await recognize(image, signal)
  signal.throwIfAborted()
  if (source === job.view.source) { job.image = sample; publish(job, { stage: source ? 'watching' : 'empty' }); return }
  publish(job, { source, translation: '', stage: source ? 'translate' : 'empty' })
  let translation = ''
  for (const text of splitText(source)) {
    const piece = job.view.sourceLang === job.view.targetLang ? text
      : await require('../local-llm').translate(job.translator.store, text, job.view.targetLang, { scope: 'file', mode: 'file', signal })
    signal.throwIfAborted()
    if (!piece?.trim()) throw fail('EMPTY_TRANSLATION', '翻譯沒有回傳文字，請按重試')
    translation += (translation ? '\n' : '') + piece.trim()
  }
  job.image = sample
  publish(job, { translation, stage: source ? 'watching' : 'empty' })
}

/** 浮窗自繪的縮放把手；原生邊框只有約 5px，太難抓。 */
function resize(bounds) {
  const job = session
  if (!job) return status()
  const values = ['x', 'y', 'width', 'height'].map((key) => bounds?.[key])
  if (!values.every(Number.isFinite)) throw fail('INVALID_INPUT', '視窗大小格式錯誤')
  const [x, y, width, height] = values.map(Math.round)
  job.win.setBounds({ x, y, width: Math.max(MIN_SIZE.width, width), height: Math.max(MIN_SIZE.height, height) })
  return { open: true }
}

function pause(paused) {
  if (typeof paused !== 'boolean') throw fail('INVALID_INPUT', '暫停設定格式錯誤')
  const job = session
  if (!job) return status()
  job.controller.abort(); clearTimeout(job.timer)
  publish(job, { paused, error: '', stage: paused ? 'paused' : 'preparing' })
  if (!paused) {
    job.image = null
    // 辨識或翻譯中被取消的原文不能命中去重，必須重新取得完整譯文。
    publish(job, { source: '', translation: '' })
    if (!job.prepared && !job.pending) {
      job.controller = new AbortController()
      job.pending = prepare(job).then(() => { job.prepared = true }).catch((error) => reportError(job, error))
        .finally(() => { job.pending = null; schedule(job) })
    } else schedule(job)
  }
  return status()
}

function close() {
  const job = session
  if (!job) return closing || Promise.resolve()
  session = null
  job.controller.abort(); clearTimeout(job.timer)
  if (!job.win.isDestroyed()) job.win.destroy()
  config.send('screenTranslate:state', { open: false })
  closing = Promise.resolve(job.pending).catch(() => {}).then(async () => {
    if (job.engineHeld) await require('../engine').release('screen')
  }).catch(() => console.warn('[screenTranslate] engine release failed')).finally(() => { closing = null })
  return closing
}

module.exports = { init, open, pause, resize, close, status, owns, assertIdle }
