'use strict'

const path = require('path')
const appFs = require('fs')
const fs = require('../raw-fs').promises
const { app, dialog } = require('electron')
const { randomUUID } = require('crypto')
const { spawn, execFile } = require('child_process')
const { StringDecoder } = require('string_decoder')
const { removeTreeSync } = require('../safe-rm')
const models = require('../models')
const runtime = require('./runtime')
const { fail, validateOptions, publicProgress, warningsOf, splitText, MAX_PDF_BYTES, MAX_LINE_BYTES } = require('./protocol')

let store
let send = () => {}
let selected = null
let active = null
let latest = null
let saving = false
let selecting = false

function init(options) { store = options.store; send = options.send || send }
function rootDir() { return path.join(app.getPath('userData'), 'pdf-translate') }
function fileView() { return selected ? { fileId: selected.fileId, name: selected.name, size: selected.size, kind: selected.kind } : null }
function assertIdle() { if (active || saving || selecting) throw fail('BUSY', 'PDF 正在處理，請先停止或等待完成') }
function publish(job, values) {
  job.view = { ...job.view, ...values }
  send('pdfTranslate:progress', { ...job.view })
}

async function timed(action, milliseconds = 15000) {
  let timer
  try {
    return await Promise.race([action, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('FILE_TIMEOUT', '檔案讀取逾時，請確認磁碟可以使用')), milliseconds)
      timer.unref()
    })])
  } finally { clearTimeout(timer) }
}

async function inspect(filename) {
  assertIdle()
  selecting = true
  try { return await selectInput(filename) } finally { selecting = false }
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'])

function kindOf(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  return IMAGE_EXTS.has(ext) ? 'image' : ''
}

function imageExtOf(header) {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png'
  if (header.length >= 3 && header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return '.jpg'
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4D) return '.bmp'
  if (header.length >= 4 && ((header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2A && header[3] === 0x00)
    || (header[0] === 0x4D && header[1] === 0x4D && header[2] === 0x00 && header[3] === 0x2A))) return '.tif'
  return ''
}

function magicKind(header) {
  if (header.includes(Buffer.from('%PDF-'))) return 'pdf'
  return imageExtOf(header) ? 'image' : ''
}

async function selectInput(filename) {
  if (typeof filename !== 'string' || filename.length > 32767 || filename.includes('\0')
    || !path.isAbsolute(filename) || !kindOf(filename)) {
    throw fail('INVALID_FILE', '請選擇 PDF 或圖片檔')
  }
  const resolved = await timed(fs.realpath(filename))
  const info = await timed(fs.stat(resolved))
  if (!info.isFile() || info.size < 8 || info.size > MAX_PDF_BYTES) {
    throw fail('INVALID_FILE', '檔案無效或超過 2 GB')
  }
  const handle = await timed(fs.open(resolved, 'r'))
  let kind = ''
  try {
    const header = Buffer.alloc(1024)
    const { bytesRead } = await timed(handle.read(header, 0, header.length, 0))
    kind = magicKind(header.subarray(0, bytesRead))
    if (!kind || kind !== kindOf(filename)) throw fail('INVALID_FILE', '檔案內容不是 PDF 或圖片')
  } finally { await handle.close() }
  if (selected?.clipboard) await fs.unlink(selected.path).catch(() => {})
  selected = { fileId: randomUUID(), name: path.basename(filename), size: info.size, kind,
    path: resolved, mtimeMs: info.mtimeMs }
  if (latest) cleanJob(latest)
  latest = null
  return fileView()
}

// 剪貼簿圖片沒有檔案路徑：只收 data: 圖片（防 SSRF，不收 renderer 給的網址），
// 副檔名由檔頭決定，暫存 App 自己的工作資料夾，換檔或關閉時刪掉。
const PASTE_PREFIX = /^data:image\/(png|jpe?g|webp|bmp|tiff?);base64,/

async function pasteImage(payload) {
  assertIdle()
  selecting = true
  let staged = null
  try {
    const prefix = typeof payload?.dataUrl === 'string' && payload.dataUrl.match(PASTE_PREFIX)
    if (!prefix) throw fail('INVALID_FILE', '剪貼簿沒有可用的圖片')
    const bytes = Buffer.from(payload.dataUrl.slice(prefix[0].length), 'base64')
    if (!bytes.length || bytes.length < 8 || bytes.length > MAX_PDF_BYTES) {
      throw fail('INVALID_FILE', '剪貼簿圖片無效或超過 2 GB')
    }
    const ext = imageExtOf(bytes.subarray(0, Math.min(bytes.length, 1024)))
    if (!ext) throw fail('INVALID_FILE', '剪貼簿圖片內容不是圖片')
    const base = String(payload?.name || '').split(/[\\/]/).pop()
      .replace(/[\0-\x1F\x7F]/g, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 100) || '剪貼簿圖片'
    await timed(fs.mkdir(rootDir(), { recursive: true }))
    staged = path.join(rootDir(), `clipboard-${randomUUID()}${ext}`)
    await timed(fs.writeFile(staged, bytes))
    try {
      await selectInput(staged)
    } catch (error) {
      await fs.unlink(staged).catch(() => {})
      staged = null
      throw error
    }
    staged = null
    selected.clipboard = true
    selected.name = `${base}${ext}`
    return fileView()
  } finally { selecting = false }
}

async function pick() {
  assertIdle()
  selecting = true
  try {
    const result = await dialog.showOpenDialog({ title: '選擇要翻譯的檔案', properties: ['openFile'],
      filters: [{ name: '文件', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] }] })
    return result.canceled || !result.filePaths?.[0] ? null : await selectInput(result.filePaths[0])
  } finally { selecting = false }
}

function missingModels() {
  const missing = ['paddleocrvl16', 'ppdoclayoutv3', 'pdfruntime'].filter((key) => !models.isDownloaded(key))
  if (!['llamaruntime', 'llamaruntimecuda'].some((key) => models.isDownloaded(key))) missing.push('llamaruntime')
  return missing.map((key) => models.MODELS[key]?.label || key)
}

function status() { const missing = missingModels(); return { job: latest?.view || null, file: fileView(), ready: !missing.length, missing } }

function translationStore() {
  const values = Object.fromEntries(['translator', 'localTranslateModel', 'translateProviderId', 'translateModelId', 'chatProviders']
    .map((key) => [key, structuredClone(store.get(key))]))
  values.fileLlm = values.translator === 'cloud'
    ? `cloud:${values.translateProviderId || ''}:${values.translateModelId || ''}`
    : `local:${require('../local-llm').resolveLocalTranslateModel(store)}`
  const snapshot = { get: (key, fallback) => values[key] ?? fallback }
  const choice = require('../model-scope').readLlm(snapshot, 'file')
  if (choice.mode === 'off' || (choice.mode === 'cloud' && (!choice.apiUrl || !choice.apiKey || !choice.modelId))) {
    throw fail('NOT_READY', '請先在翻譯頁選擇已設定好的翻譯模型')
  }
  if (choice.mode === 'local' && !models.isDownloaded(choice.modelKey)) throw fail('NOT_READY', '請先下載選定的翻譯模型')
  return { store: snapshot, local: choice.mode === 'local' }
}

function start(options) {
  assertIdle()
  const request = validateOptions(options)
  if (selected?.fileId !== request.fileId) throw fail('INVALID_FILE', '檔案選擇已變更，請重新選擇')
  if (missingModels().length) throw fail('NOT_INSTALLED', '請先到 Local SI 安裝 PDF 辨識模型與執行環境')
  const translator = translationStore()
  const jobId = randomUUID()
  const previous = latest
  const job = { jobId, file: { ...selected }, request, translator, controller: new AbortController(), child: null,
    dir: path.join(rootDir(), jobId), view: { jobId, state: 'running', page: 0, pages: 0, stage: 'opening', warnings: [] } }
  // 同步佔位，再開始任何 await，避免雙重工作或取消競態。
  active = job; latest = job
  job.promise = run(job, previous).catch((error) => {
    publish(job, { state: job.controller.signal.aborted ? 'cancelled' : 'failed',
      error: job.controller.signal.aborted ? '' : error.userMessage || 'PDF 翻譯失敗，請檢查檔案與模型後再試' })
  }).finally(async () => {
    await stopChild(job)
    if (job.engineHeld) await require('../engine').release('pdf').catch(() => {})
    if (!job.result) cleanJob(job)
    if (active === job) active = null
    if (job.result) publish(job, job.result)
  })
  publish(job, {})
  return { jobId }
}

function cleanJob(job) {
  try { removeTreeSync(job.dir) } catch { /* 可能仍被防毒占用，保留本機暫存供下次清理。 */ }
}

async function prepareInput(job) {
  const info = await timed(fs.stat(job.file.path))
  if (info.size !== job.file.size || info.mtimeMs !== job.file.mtimeMs) throw fail('STALE', 'PDF 已被修改，請重新選擇')
  await fs.mkdir(job.dir, { recursive: true })
  await timed(fs.copyFile(job.file.path, path.join(job.dir, 'input.pdf')), 120000)
  const current = await timed(fs.stat(job.file.path))
  if (current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw fail('STALE', 'PDF 已被修改，請重新選擇')
  job.controller.signal.throwIfAborted()
}

async function prepareModels(job) {
  const hf = require('../hfmodels')
  hf.init({ userDataPath: app.getPath('userData'), store })
  await hf.writePresets()
  await hf.ensureRuntime()
  if (!(await hf.refreshModels()).some((row) => row.id === 'paddleocrvl16')) await hf.applyPresets()
  job.controller.signal.throwIfAborted()
  if (job.translator.local) {
    const engine = require('../engine')
    engine.setStore(store)
    const result = await engine.acquire('pdf', { asr: false, llm: true })
    if (!result.ok) throw fail('NOT_READY', '翻譯模型無法載入，請檢查 Local SI')
    job.engineHeld = true
  }
  job.controller.signal.throwIfAborted()
  const endpoint = hf.endpoint()
  if (!endpoint) throw fail('NOT_READY', 'PDF 辨識執行環境尚未啟動')
  return { baseUrl: `${endpoint.baseUrl.replace(/\/v1\/?$/, '')}/v1`, apiKey: endpoint.apiKey }
}

async function run(job, previous) {
  if (previous) cleanJob(previous)
  await prepareInput(job)
  const endpoint = await prepareModels(job)
  const worker = path.join(job.dir, 'worker.py')
  // Python 不能從 asar 執行；寫出 App 自己的 worker，來源 PDF 只讀。
  await fs.writeFile(worker, appFs.readFileSync(path.join(__dirname, 'worker.py')))
  const config = { inputPath: path.join(job.dir, 'input.pdf'), outputPath: path.join(job.dir, 'result.partial.pdf'),
    endpoint, ocrModel: 'paddleocrvl16', layoutDir: models.modelDir('ppdoclayoutv3'), ...job.request }
  const summary = await runWorker(job, worker, config)
  job.controller.signal.throwIfAborted()
  const bytes = (await fs.stat(config.outputPath)).size
  if (!bytes || !summary.pages) throw fail('EMPTY_RESULT', 'PDF 翻譯沒有產生有效檔案')
  job.outputPath = path.join(job.dir, 'result.pdf')
  await fs.rename(config.outputPath, job.outputPath)
  job.result = { state: 'done', page: summary.pages, pages: summary.pages,
    translatedBlocks: summary.translatedBlocks, warnings: warningsOf(summary.warnings), error: '' }
}

async function translateBlock(job, message) {
  const validId = (Number.isSafeInteger(message.id) && message.id >= 0)
    || (typeof message.id === 'string' && /^\d{1,6}:\d{1,6}$/.test(message.id))
  if (!validId || typeof message.text !== 'string'
    || !message.text.trim() || message.text.length > 100000) throw fail('WORKER_PROTOCOL', 'PDF 辨識回應格式錯誤')
  const output = []
  const llm = require('../local-llm')
  llm.setStore(store)
  for (const text of splitText(message.text)) {
    job.controller.signal.throwIfAborted()
    const translated = await llm.translate(job.translator.store, text, job.request.targetLang,
      { mode: 'file', scope: 'file', signal: job.controller.signal })
    if (typeof translated !== 'string' || !translated.trim()) throw fail('EMPTY_TRANSLATION', '翻譯模型回傳空白內容，已停止')
    output.push(translated)
  }
  job.controller.signal.throwIfAborted()
  return { id: message.id, text: output.join('') }
}

function runWorker(job, worker, config) {
  return new Promise((resolve, reject) => {
    let done = null, buffered = '', pending = false, failed = false
    const decoder = new StringDecoder('utf8')
    const child = spawn(runtime.pythonExe(models.modelDir('pdfruntime')), ['-I', '-B', '-u', worker],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
          AXONDECK_PDF_WORKER: '1',
          PADDLE_PDX_CACHE_HOME: path.join(models.modelDir('pdfruntime'), 'paddle-cache'),
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True' } })
    job.child = child
    const abort = () => { reject(job.controller.signal.reason); void stopChild(job) }
    const stop = (error) => { if (failed) return; failed = true; reject(error); void stopChild(job) }
    job.controller.signal.addEventListener('abort', abort, { once: true })
    child.on('error', () => stop(fail('START_FAILED', 'PDF 執行環境無法啟動，請重新安裝')))
    child.stdin.on('error', () => stop(fail('WORKER_EXIT', 'PDF 執行環境已結束')))
    child.stdout.on('data', (bytes) => {
      buffered += decoder.write(bytes)
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) return stop(fail('WORKER_PROTOCOL', 'PDF 辨識回應過大'))
      let newline
      while (!failed && (newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { return stop(fail('WORKER_PROTOCOL', 'PDF 辨識回應格式錯誤')) }
        if (message.type === 'progress') publish(job, publicProgress(message))
        else if (message.type === 'done') {
          if (!Number.isSafeInteger(message.pages) || message.pages < 1 || !Number.isSafeInteger(message.translatedBlocks)
            || message.translatedBlocks < 0) return stop(fail('WORKER_PROTOCOL', 'PDF 辨識回應格式錯誤'))
          done = message
        } else if (message.type === 'translate' && !pending) {
          pending = true
          translateBlock(job, message).then((reply) => {
            pending = false
            if (!failed && !job.controller.signal.aborted) child.stdin.write(JSON.stringify(reply) + '\n')
          }).catch(stop)
        } else if (message.type === 'error') stop(fail('PDF_PARSE_FAILED', 'PDF 無法處理；請確認未加密、檔案完整且模型已安裝'))
        else return stop(fail('WORKER_PROTOCOL', 'PDF 辨識回應格式錯誤'))
      }
    })
    child.once('close', (code) => {
      job.controller.signal.removeEventListener('abort', abort)
      if (job.child === child) job.child = null
      if (!failed && !job.controller.signal.aborted && code === 0 && done && !pending && !buffered.trim()) resolve(done)
      else if (!failed) reject(fail('WORKER_EXIT', 'PDF 執行環境意外結束，未輸出不完整檔案'))
    })
    child.stdin.write(JSON.stringify(config) + '\n')
    if (job.controller.signal.aborted) abort()
  })
}

function stopChild(job) {
  if (job.stopping) return job.stopping
  const child = job.child
  if (!child?.pid || child.exitCode !== null) return Promise.resolve()
  job.stopping = new Promise((resolve) => {
    if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => { child.kill(); resolve() })
    else { child.once('close', resolve); child.kill('SIGKILL') }
  })
  return job.stopping
}

async function cancel(jobId) {
  if (!active || active.jobId !== jobId) return false
  const job = active
  job.controller.abort(fail('CANCELLED', '已停止 PDF 翻譯'))
  await stopChild(job)
  await job.promise
  return true
}

async function assertOutputPath(filename, job) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')
    || path.extname(filename).toLowerCase() !== '.pdf') throw fail('INVALID_OUTPUT', '請另存為 PDF 檔案')
  const parent = await timed(fs.realpath(path.dirname(filename)))
  const resolved = path.join(parent, path.basename(filename))
  let existing = resolved
  try { existing = await timed(fs.realpath(filename)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if ([resolved, existing].some((item) => item.toLowerCase() === job.file.path.toLowerCase())) {
    throw fail('SOURCE_OVERWRITE', '請使用新的檔名，保留原本的檔案')
  }
  const relative = path.relative(rootDir(), resolved)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw fail('INVALID_OUTPUT', '請存到 PDF 工作資料夾以外的位置')
  return resolved
}

async function save(jobId) {
  assertIdle()
  const job = latest
  if (job?.jobId !== jobId || job.view.state !== 'done') throw fail('NOT_FINISHED', 'PDF 尚未翻譯完成')
  saving = true
  let temporary
  try {
    const result = await dialog.showSaveDialog({ title: '另存翻譯 PDF',
      defaultPath: `${path.basename(job.file.name, path.extname(job.file.name))}-${job.request.targetLang}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePath) return { saved: false }
    const destination = await assertOutputPath(result.filePath, job)
    temporary = path.join(path.dirname(destination), `.axondeck-pdf-${randomUUID()}.pdf`)
    await timed(fs.copyFile(job.outputPath, temporary, appFs.constants.COPYFILE_EXCL), 120000)
    await timed(fs.rename(temporary, destination))
    return { saved: true, name: path.basename(destination) }
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {})
    saving = false
  }
}

async function shutdown() {
  if (active) await cancel(active.jobId)
  if (latest) cleanJob(latest)
  if (selected?.clipboard) await fs.unlink(selected.path).catch(() => {})
  selected = null; latest = null
}

module.exports = { init, pick, inspect, pasteImage, start, cancel, status, save, shutdown, assertIdle }
