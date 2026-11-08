/**
 * 雲端文字轉語音（OpenAI 相容 /audio/speech）。畫面跟本機共用同一份稿子與播放列：
 * 這裡只管右側的模型／聲音欄位，以及把回來的 MP3 解成 24 kHz 單聲道 PCM，交給版本區存檔。
 */
import { electronAPI, openSettingsPage } from './app.js'
import { syncCustomSelects } from './custom-select.js'

const $ = (id) => document.getElementById(id)
const RATE = 24000
export const CLOUD_MAX_CHARS = 4096
let initialized = false
let models = []
let onChange = () => {}

async function call(name, options) {
  const response = await electronAPI.cloudTts[name](options)
  if (!response?.ok) throw new Error(response?.error?.message || '雲端語音操作失敗')
  return response.data
}

export function cloudReady() { return models.length > 0 }

/** 選取的模型（存草稿用）：[providerId, modelId] 的 JSON。 */
export function cloudModelKey() { return $('cloudSpeechModel').selectedOptions[0]?.dataset.key || '' }

export async function refreshCloudSpeech(preferredKey = '') {
  if (!$('cloudSpeechModel') || !electronAPI.cloudTts) return
  try {
    models = (await call('status')).models
    const select = $('cloudSpeechModel')
    const previous = preferredKey || cloudModelKey()
    select.replaceChildren()
    models.forEach((model, index) => {
      const option = new Option(`${model.providerName} · ${model.modelId}`, String(index))
      option.dataset.key = JSON.stringify([model.providerId, model.modelId])
      select.add(option)
      if (option.dataset.key === previous) select.value = String(index)
    })
    $('cloudSpeechEmpty').hidden = Boolean(models.length)
    for (const id of ['cloudSpeechModel', 'cloudSpeechVoice', 'cloudSpeechSpeed']) $(id).closest('.speech-field').hidden = !models.length
    syncCustomSelects()
  } catch (error) {
    models = []
    console.error('[cloud-speech] 讀取模型失敗:', error)
  }
  onChange()
}

/** 按下生成時拍下的設定：排隊時再改欄位不影響已排的。 */
export function cloudSnapshot() {
  const model = models[Number($('cloudSpeechModel').value)]
  if (!model) throw new Error('請先在設定加入文字轉語音的雲端模型。')
  const voice = $('cloudSpeechVoice').value.trim()
  if (!voice) throw new Error('請填寫聲音名稱。')
  return { providerId: model.providerId, modelId: model.modelId, voice, speed: Number($('cloudSpeechSpeed').value) }
}

/** MP3 → 24 kHz 單聲道 16-bit PCM（OfflineAudioContext 解碼時就會重新取樣）。 */
async function toPcm(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const buffer = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes.buffer)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  const view = new DataView(new ArrayBuffer(buffer.length * 2))
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    const value = Math.max(-1, Math.min(1, sum / channels.length))
    view.setInt16(i * 2, Math.round(value * 32767), true)
  }
  return new Uint8Array(view.buffer)
}

export async function generateCloud({ request, text, requestId }) {
  const data = await call('generate', { ...request, requestId, text })
  return toPcm(data.audioBase64)
}

export function cancelCloud(requestId) { return call('cancel', { requestId }) }

export function initCloudSpeech({ onStatus }) {
  if (initialized || !$('cloudSpeechModel')) return
  initialized = true
  onChange = onStatus
  $('cloudSpeechSettings').addEventListener('click', () => openSettingsPage('cloud'))
  document.addEventListener('settings-changed', () => void refreshCloudSpeech())
}
