import { electronAPI, showToast } from './app.js'
import { syncCustomSelects } from './custom-select.js'

const $ = (id) => document.getElementById(id)
let initialized = false
let models = []
let requestId = ''
let resultId = ''
let audioUrl = ''

async function call(name, options) {
  const response = await electronAPI.cloudTts[name](options)
  if (!response?.ok) throw new Error(response?.error?.message || '雲端語音操作失敗')
  return response.data
}

function busy(value) {
  $('cloudSpeechGenerate').disabled = value || !models.length
  $('cloudSpeechCancel').hidden = !value
  for (const id of ['cloudSpeechModel', 'cloudSpeechText', 'cloudSpeechVoice', 'cloudSpeechSpeed']) $(id).disabled = value
  syncCustomSelects()
}

export async function refreshCloudSpeech() {
  if (!$('cloudSpeechModel') || !electronAPI.cloudTts) return
  try {
    const status = await call('status')
    models = status.models
    const select = $('cloudSpeechModel')
    const previous = select.selectedOptions[0]?.dataset.key
    select.replaceChildren()
    models.forEach((model, index) => {
      const option = new Option(`${model.providerName} · ${model.modelId}`, String(index))
      option.dataset.key = JSON.stringify([model.providerId, model.modelId])
      select.add(option)
      if (option.dataset.key === previous) select.value = String(index)
    })
    $('cloudSpeechEmpty').hidden = Boolean(models.length)
    busy(Boolean(requestId) || status.busy)
  } catch (error) { $('cloudSpeechStatus').textContent = error.message }
}

async function generate() {
  const model = models[Number($('cloudSpeechModel').value)]
  if (!model || requestId) return
  const text = $('cloudSpeechText').value.trim()
  const voice = $('cloudSpeechVoice').value.trim()
  if (!text || !voice) { $('cloudSpeechStatus').textContent = '請填寫文字與聲音名稱'; return }
  requestId = crypto.randomUUID()
  busy(true)
  $('cloudSpeechStatus').textContent = '正在生成語音…'
  try {
    const data = await call('generate', { providerId: model.providerId, modelId: model.modelId, requestId,
      text, voice, speed: Number($('cloudSpeechSpeed').value) })
    resultId = data.resultId
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    audioUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0))], { type: data.mimeType }))
    $('cloudSpeechAudio').src = audioUrl
    $('cloudSpeechAudio').hidden = false
    $('cloudSpeechSave').disabled = false
    $('cloudSpeechStatus').textContent = '語音已完成，可試聽或儲存。這是 AI 生成的聲音。'
  } catch (error) { $('cloudSpeechStatus').textContent = error.message }
  finally { requestId = ''; busy(false) }
}

export function initCloudSpeech() {
  if (initialized || !$('cloudSpeechModel')) return
  initialized = true
  $('cloudSpeechGenerate').addEventListener('click', generate)
  $('cloudSpeechCancel').addEventListener('click', async () => {
    try { await call('cancel', { requestId }) } catch (error) { showToast(error.message, 'error') }
  })
  $('cloudSpeechSave').addEventListener('click', async () => {
    try { if ((await call('saveAudio', { resultId })).saved) showToast('語音已儲存') }
    catch (error) { showToast(error.message, 'error') }
  })
  void refreshCloudSpeech()
}
