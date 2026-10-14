'use strict'

const { randomUUID } = require('crypto')
const fs = require('../raw-fs').promises
const MAX_BYTES = 24 * 1024 * 1024
let store = null
let active = null
let result = null

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  error.userMessage = message
  throw error
}

function setStore(value) { store = value }
function providers() { return store?.get('cloudProviders', []) || [] }
function status() {
  const models = providers().flatMap((provider) => (provider.models || [])
    .filter((model) => model.type === 'tts')
    .map((model) => ({ providerId: provider.id, providerName: provider.name, modelId: model.id })))
  return { models, busy: Boolean(active) }
}

function validate(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INPUT', '語音設定無效')
  const { providerId, modelId, requestId, text, voice, speed } = options
  if (typeof requestId !== 'string' || !/^[\w-]{6,80}$/.test(requestId)) fail('INPUT', '語音請求無效')
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) fail('INPUT', '請輸入 1 到 4096 字的文字')
  if (typeof voice !== 'string' || !voice.trim() || voice.length > 120 || /[\r\n\x00]/.test(voice)) fail('INPUT', '請填寫有效的聲音名稱')
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4) fail('INPUT', '語速須介於 0.25 到 4')
  const provider = providers().find((item) => item.id === providerId)
  if (!provider?.models?.some((model) => model.id === modelId && model.type === 'tts')) fail('MODEL', '請先選擇文字轉語音模型')
  let url
  try { url = new URL(provider.apiUrl) } catch { fail('CONFIG', '供應商網址無效，請到設定檢查') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('CONFIG', '供應商網址無效，請到設定檢查')
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/audio\/speech$/, '')}/audio/speech`
  url.search = ''; url.hash = ''
  if (typeof provider.apiKey !== 'string' || !provider.apiKey.trim()) fail('CONFIG', '請先在設定填寫 API Key')
  return { url, key: provider.apiKey, requestId, body: { model: modelId, input: text, voice: voice.trim(), speed, response_format: 'mp3' } }
}

async function readAudio(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) fail('SIZE', '音訊超過 24 MB，請縮短文字')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_BYTES) fail('SIZE', '音訊超過 24 MB，請縮短文字')
    chunks.push(chunk)
  }
  const audio = Buffer.concat(chunks)
  if (!(audio.subarray(0, 3).toString() === 'ID3' || (audio.length > 1 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0))) {
    fail('FORMAT', '供應商沒有傳回 MP3 音訊')
  }
  return audio
}

async function generate(options) {
  const request = validate(options)
  if (active) fail('BUSY', '已有語音正在生成')
  const job = { id: request.requestId, controller: new AbortController(), canceled: false }
  active = job
  const timer = setTimeout(() => job.controller.abort(), 120000)
  try {
    const response = await fetch(request.url, { method: 'POST', redirect: 'error', signal: job.controller.signal,
      headers: { Authorization: `Bearer ${request.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) })
    if (!response.ok) {
      await response.body?.cancel()
      fail('UPSTREAM', response.status === 429 ? '供應商目前忙碌或額度不足，請稍後再試' : '供應商無法生成語音，請檢查模型與設定')
    }
    const audio = await readAudio(response)
    if (job.controller.signal.aborted) fail('CANCELED', '已取消語音生成')
    result = { id: randomUUID(), audio }
    // renderer 的 CSP 不收 data: 音訊，跟 Breeze 一樣回 base64 讓它轉 blob:
    return { resultId: result.id, audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' }
  } catch (error) {
    if (job.controller.signal.aborted) fail(job.canceled ? 'CANCELED' : 'TIMEOUT', job.canceled ? '已取消語音生成' : '語音生成逾時，請縮短文字後重試')
    if (error.userMessage) throw error
    fail('NETWORK', '無法連線到語音供應商，請稍後再試')
  } finally { clearTimeout(timer); job.controller.abort(); active = null }
}

function cancel(options) {
  if (!options || typeof options.requestId !== 'string') fail('INPUT', '語音請求無效')
  if (active?.id !== options.requestId) return { canceled: false }
  active.canceled = true
  active.controller.abort()
  return { canceled: true }
}

async function saveAudio(options) {
  if (!options || typeof options.resultId !== 'string' || options.resultId !== result?.id) fail('RESULT', '這段音訊已失效，請重新生成')
  const audio = result.audio
  const { dialog, BrowserWindow } = require('electron')
  const choice = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || undefined,
    { title: '儲存語音', defaultPath: '雲端語音.mp3', filters: [{ name: 'MP3 音訊', extensions: ['mp3'] }] })
  if (choice.canceled || !choice.filePath) return { saved: false }
  try { await fs.writeFile(choice.filePath, audio) } catch { fail('SAVE', '音訊儲存失敗，請選擇其他位置') }
  return { saved: true }
}

function shutdown() { active?.controller.abort(); result = null }

module.exports = { setStore, status, generate, cancel, saveAudio, shutdown }
