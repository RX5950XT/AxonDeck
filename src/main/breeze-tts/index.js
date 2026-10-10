'use strict'

const path = require('path')
const net = require('net')
const { randomUUID } = require('crypto')
const { spawn, execFile } = require('child_process')
const { app, dialog, BrowserWindow } = require('electron')
const fs = require('../raw-fs').promises
const models = require('../models')
const { detectGpuCapability } = require('../gpu-capability')
const { fail, text, voiceId, validate, wavInfo, wavHeader, wavToMono16k, savedVoice, MAX_AUDIO_BYTES } = require('./protocol')

const MAX_RESULT_BYTES = 128 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 180000
const START_TIMEOUT_MS = 180000
const GENERATE_TIMEOUT_MS = 30 * 60 * 1000
let send = () => {}
let child = null
let baseUrl = ''
let loading = null
let loadController = null
let active = null
let ready = false
let backend = ''
let closing = null
const inputs = new Map()
const results = new Map()

function init(options = {}) {
  if (typeof options.send === 'function') send = options.send
}

function emit(channel, payload) { send(channel, payload) }
function voicesDir() { return path.join(app.getPath('userData'), 'breeze-tts', 'voices') }
function parentWindow() { return BrowserWindow.getFocusedWindow() || undefined }

async function fileInfo(filename) {
  if (!filename) return false
  try {
    const info = await Promise.race([fs.stat(filename), new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000); timer.unref()
    })])
    return info?.isFile() ? info : null
  } catch { return null }
}

async function isFile(filename) { return !!(await fileInfo(filename)) }

async function installed(key, field) {
  const definition = models.MODELS[key]
  if (!definition) return false
  const info = await fileInfo(models.filePath(key, field))
  if (!info || !info.size) return false
  if (!definition.archive && info.size !== definition.totalBytes) return false
  if (!definition.check) return true
  const files = await Promise.all(definition.check.map((relative) => fileInfo(path.join(models.modelDir(key), relative))))
  return files.every((file) => file && file.size > 0)
}

async function status() {
  const [modelInstalled, runtimeInstalled] = await Promise.all([
    installed('breezetts2q8', 'gguf'), installed('breezeruntime', 'binary')
  ])
  return { ready, loading: !!loading, busy: !!active, installed: modelInstalled && runtimeInstalled,
    modelInstalled, runtimeInstalled, model: 'breezetts2q8', backend }
}

function publishStatus() {
  status().then((value) => emit('breeze:status', value)).catch(() => {})
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function request(endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, { ...options, redirect: 'error',
    signal: options.signal || AbortSignal.timeout(30000) })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 409) throw fail('BUSY', '目前正在生成語音')
    if (response.status === 404) throw fail('VOICE_MISSING', '找不到這個聲音，請重新選擇')
    throw fail('RUNTIME_ERROR', '語音執行環境拒絕請求，請檢查錄音與設定')
  }
  return response
}

async function load(signal) {
  if (closing) await closing
  if (ready && child) return
  if (loading) return loading
  loadController = new AbortController()
  const loadSignal = signal ? AbortSignal.any([signal, loadController.signal]) : loadController.signal
  loading = start(loadSignal).finally(() => { loading = null; loadController = null; publishStatus() })
  publishStatus()
  return loading
}

async function start(signal) {
  const state = await status()
  if (!state.installed) throw fail('NOT_INSTALLED', '請先在 Local SI 下載 Breeze-TTS-2 模型與執行環境')
  const gpu = await detectGpuCapability()
  backend = gpu.ok && gpu.hasVulkan ? 'Vulkan' : 'CPU'
  await fs.mkdir(voicesDir(), { recursive: true })
  signal?.throwIfAborted()
  const port = await freePort()
  signal.throwIfAborted()
  const binary = models.filePath('breezeruntime', 'binary')
  const args = [models.filePath('breezetts2q8', 'gguf'), '--host', '127.0.0.1', '--port', String(port),
    '--ws-port', '-1', '--voices-dir', voicesDir()]
  if (backend === 'CPU') args.push('--cpu')
  const owned = spawn(binary, args, { cwd: path.dirname(binary), windowsHide: true, stdio: 'ignore', shell: false })
  child = owned
  baseUrl = `http://127.0.0.1:${port}`
  let exited = false
  owned.once('error', () => { exited = true })
  owned.once('exit', () => {
    exited = true
    if (child !== owned) return
    child = null; ready = false; baseUrl = ''; publishStatus()
    active?.controller.abort(fail('RUNTIME_EXIT', '語音執行環境已結束'))
  })
  const deadline = Date.now() + START_TIMEOUT_MS
  try {
    while (Date.now() < deadline && !exited) {
      signal?.throwIfAborted()
      try {
        const response = await request('/health', { signal: AbortSignal.timeout(1000) })
        const health = await response.json()
        if (health.status !== 'ok' || health.sample_rate !== 24000) throw fail('RUNTIME_ERROR', '語音執行環境版本不符')
        ready = true; return
      } catch (error) { if (error.userMessage) throw error }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw fail('START_FAILED', '語音執行環境啟動失敗或逾時')
  } catch (error) {
    const canceled = signal?.aborted
    await stopRuntime()
    throw canceled ? fail('CANCELED', '已停止語音生成') : error
  }
}

function stopRuntime() {
  if (closing) return closing
  loadController?.abort(fail('CANCELED', '已停止語音生成'))
  const owned = child
  child = null; ready = false; baseUrl = ''
  if (!owned) return Promise.resolve()
  closing = new Promise((resolve) => {
    if (!owned.pid || owned.exitCode !== null) return resolve()
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      execFile(taskkill, ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve())
    } else { owned.once('exit', resolve); owned.kill('SIGKILL') }
  }).finally(() => { closing = null; publishStatus() })
  return closing
}

function requireIdle() {
  if (active) throw fail('BUSY', '目前正在生成語音，請先停止或等待完成')
}

async function editVoice(action) {
  requireIdle()
  const controller = new AbortController()
  active = { reqId: randomUUID(), controller }
  publishStatus()
  try { return await action(controller.signal) }
  finally { if (active?.controller === controller) active = null; publishStatus() }
}

function inputFor(id, kind) {
  const audio = inputs.get(id)
  if (!audio || audio.kind !== kind) throw fail('AUDIO_MISSING', '錄音已失效，請重新選擇')
  return audio
}

function withTimeout(operation, message) {
  let timer
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail('FILE_TIMEOUT', message)), 15000)
  })]).finally(() => clearTimeout(timer))
}

async function readWav(filename) {
  const handle = await fs.open(filename, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_AUDIO_BYTES) throw fail('AUDIO_TOO_LARGE', 'WAV 錄音須小於 64 MB')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw fail('INVALID_AUDIO', 'WAV 錄音在讀取期間已變動')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw fail('INVALID_AUDIO', 'WAV 錄音在讀取期間已變動')
    return { bytes, meta: wavInfo(bytes) }
  } finally { await handle.close() }
}

function formWithReference(options, fields) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  if (options.mode !== 'design' && !fields.voice_id) {
    const audio = inputFor(options.refAudioId, 'reference')
    form.set('ref_audio', new Blob([audio.bytes], { type: 'audio/wav' }), 'reference.wav')
  }
  if (options.mode === 'convert') {
    const audio = inputFor(options.sourceAudioId, 'source')
    form.set('source', new Blob([audio.bytes], { type: 'audio/wav' }), 'source.wav')
  }
  return form
}

async function generate(options) {
  const fields = validate(options)
  const reqId = text(options.reqId, '請求代碼', 64, true)
  const form = formWithReference(options, fields)
  requireIdle()
  const controller = new AbortController()
  active = { reqId, controller }
  const timer = setTimeout(() => controller.abort(fail('TIMEOUT', '語音生成逾時')), GENERATE_TIMEOUT_MS)
  publishStatus()
  try {
    emit('breeze:progress', { reqId, phase: 'loading', seconds: 0 })
    await load(controller.signal)
    controller.signal.throwIfAborted()
    emit('breeze:progress', { reqId, phase: 'generating', seconds: 0 })
    const endpoint = options.mode === 'convert' ? '/v1/audio/convert' : '/v1/audio/speech'
    const response = await request(endpoint, { method: 'POST', body: form, signal: controller.signal })
    return await collectAudio(response, reqId, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      await stopRuntime()
      throw controller.signal.reason?.userMessage ? controller.signal.reason : fail('CANCELED', '已停止語音生成')
    }
    if (error.userMessage) throw error
    throw fail('GENERATE_FAILED', '語音生成失敗，請檢查錄音或重新嘗試')
  } finally {
    clearTimeout(timer)
    if (active?.controller === controller) active = null
    publishStatus()
  }
}

async function collectAudio(response, reqId, signal) {
  const rate = Number(response.headers.get('X-Sample-Rate'))
  if (rate !== 24000 || response.headers.get('X-Sample-Format') !== 's16le' || !response.body) {
    await response.body?.cancel(); throw fail('INVALID_AUDIO', '語音執行環境傳回無效音訊')
  }
  const chunks = []
  let size = 0, tail = Buffer.alloc(0)
  const reader = response.body.getReader()
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      const buffer = tail.length ? Buffer.concat([tail, Buffer.from(value)]) : Buffer.from(value)
      const length = buffer.length - (buffer.length % 2)
      tail = buffer.subarray(length)
      if (!length) continue
      const pcm = buffer.subarray(0, length)
      size += length
      if (size > MAX_RESULT_BYTES) throw fail('AUDIO_TOO_LARGE', '生成音訊超過 128 MB，請分段生成')
      chunks.push(pcm)
      emit('breeze:chunk', { reqId, pcmBase64: pcm.toString('base64'), sampleRate: rate, seconds: size / (rate * 2) })
      emit('breeze:progress', { reqId, phase: 'generating', seconds: size / (rate * 2) })
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  if (!size || tail.length) throw fail('INVALID_AUDIO', '生成音訊不完整')
  const bytes = Buffer.concat([wavHeader(size, rate), ...chunks])
  const resultId = randomUUID()
  results.clear()
  results.set(resultId, bytes)
  emit('breeze:progress', { reqId, phase: 'done', seconds: size / (rate * 2) })
  return { resultId, audioBase64: bytes.toString('base64'), mimeType: 'audio/wav', sampleRate: rate,
    duration: size / (rate * 2), bytes: bytes.length }
}

async function cancel(options = {}) {
  if (!active || (options.reqId && active.reqId !== options.reqId)) return { canceled: false }
  active.controller.abort(fail('CANCELED', '已停止語音生成'))
  // 殺掉我們的 server 才能連參考音編碼與模型載入一起停下。
  await stopRuntime()
  return { canceled: true }
}

async function pickAudio(options = {}) {
  if (!['reference', 'source'].includes(options.kind)) throw fail('INVALID_INPUT', '錄音用途不符')
  const selected = await dialog.showOpenDialog(parentWindow(), { title: options.kind === 'source' ? '選擇要轉換的錄音' : '選擇參考錄音',
    properties: ['openFile'], filters: [{ name: 'WAV 錄音', extensions: ['wav'] }] })
  if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true }
  const { bytes, meta } = await withTimeout(readWav(selected.filePaths[0]), '讀取錄音逾時')
  for (const [id, previous] of inputs) if (previous.kind === options.kind) inputs.delete(id)
  const audioId = randomUUID()
  const name = path.basename(selected.filePaths[0])
  inputs.set(audioId, { bytes, kind: options.kind })
  const transcript = options.kind === 'reference' ? await describeReference(bytes) : ''
  return { audioId, name, bytes: bytes.length, ...meta, transcript }
}

/**
 * 參考音的逐字稿用檔案轉錄同一顆 ASR 自動辨識，省掉手打。
 * 模型沒下載、辨識失敗或逾時都回空字串，由前端退回手動填寫。
 */
async function describeReference(bytes) {
  let samples
  try { samples = wavToMono16k(bytes) } catch { return '' }
  if (!samples.length) return ''
  let timer
  let value
  try {
    const { transcribe } = require('../asr-select')
    value = await Promise.race([transcribe('file', { samples, sampleRate: 16000 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TRANSCRIBE_TIMEOUT')), TRANSCRIBE_TIMEOUT_MS); timer.unref?.() })])
  } catch { return '' }
  finally { clearTimeout(timer) }
  if (typeof value !== 'string') return ''
  try {
    const { s2twp, shouldS2twpSource } = require('../opencc')
    if (shouldS2twpSource(value, 'zh-TW')) value = s2twp(value)
  } catch { /* 轉換失敗用原文，不退回空字串 */ }
  return value.trim().slice(0, 10000)
}

function publicVoice(value) {
  if (!value || typeof value !== 'object') throw fail('RUNTIME_ERROR', '聲音資料格式不符')
  return { id: voiceId(value.id), seconds: Number.isFinite(value.seconds) ? value.seconds : 0,
    saved: value.saved === true, refText: text(value.ref_text, '逐字稿', 10000) }
}

async function voices() {
  let entries
  try { entries = await fs.readdir(voicesDir(), { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw fail('READ_FAILED', '無法讀取保存的聲音') }
  const list = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,64}\.breeze$/.test(entry.name)) continue
    const id = entry.name.slice(0, -7)
    const filename = path.join(voicesDir(), entry.name)
    try {
      const info = await fs.stat(filename)
      if (info.size > MAX_AUDIO_BYTES) throw fail('INVALID_VOICE', '聲音資料過大')
      list.push(savedVoice(await fs.readFile(filename), id))
    } catch { list.push({ id, saved: true, seconds: 0, refText: '', invalid: true }) }
  }
  return list
}

async function saveVoice(options = {}) {
  const name = voiceId(options.name)
  const refText = text(options.refText, '參考錄音逐字稿', 10000, true)
  const audio = inputFor(options.refAudioId, 'reference')
  return editVoice(async (signal) => {
    if (await isFile(path.join(voicesDir(), `${name}.breeze`))) throw fail('VOICE_EXISTS', '這個聲音名稱已存在，請換一個名稱')
    await load(signal)
    const form = new FormData()
    form.set('name', name); form.set('ref_text', refText)
    form.set('ref_audio', new Blob([audio.bytes], { type: 'audio/wav' }), 'reference.wav')
    const deadline = AbortSignal.timeout(180000)
    try {
      const response = await request('/v1/voices', { method: 'POST', body: form,
        signal: AbortSignal.any([signal, deadline]) })
      return publicVoice({ ...(await response.json()), ref_text: refText, saved: true })
    } catch (error) {
      if (deadline.aborted || signal.aborted) {
        await stopRuntime(); throw fail('TIMEOUT', '保存聲音已停止或逾時')
      }
      throw error
    }
  })
}

async function removeVoice(options = {}) {
  const id = voiceId(options.id)
  return editVoice(async (signal) => {
    if (ready) {
      try { await request(`/v1/voices/${encodeURIComponent(id)}`, { method: 'DELETE', signal }) }
      catch (error) { if (error.code !== 'VOICE_MISSING') throw error }
    }
    try { await fs.unlink(path.join(voicesDir(), `${id}.breeze`)) }
    catch (error) { if (error.code !== 'ENOENT') throw fail('DELETE_FAILED', '聲音檔案無法刪除') }
    return { deleted: id }
  })
}

async function saveAudio(options = {}) {
  const bytes = results.get(options.resultId)
  if (!bytes) throw fail('AUDIO_MISSING', '語音結果已失效，請重新生成')
  const selected = await dialog.showSaveDialog(parentWindow(), { title: '儲存語音', defaultPath: 'Breeze-TTS.wav',
    filters: [{ name: 'WAV 音訊', extensions: ['wav'] }] })
  if (selected.canceled || !selected.filePath) return { canceled: true }
  await fs.writeFile(selected.filePath, bytes)
  return { saved: true }
}

async function shutdown() {
  active?.controller.abort(fail('CANCELED', '已停止語音生成'))
  await stopRuntime()
  inputs.clear(); results.clear()
}

module.exports = { init, status, generate, cancel, pickAudio, voices, saveVoice, removeVoice, saveAudio, shutdown }
