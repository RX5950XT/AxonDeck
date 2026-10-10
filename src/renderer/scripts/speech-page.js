import { electronAPI, switchPage } from './app.js'
import { askConfirm } from './app-dialog.js'
import { syncCustomSelects } from './custom-select.js'

const $ = (id) => document.getElementById(id)
let initialized = false
let mode = 'design'
let reference = null
let source = null
let requestId = ''
let resultId = ''
let audioUrl = ''
let installed = false
let serviceBusy = false
let savingVoice = false
let audioContext = null
let playAt = 0
let pcmTail = null
const playing = new Set()

function showError(error) {
  $('speechError').textContent = error?.message || '語音操作失敗，請稍後再試。'
  $('speechError').hidden = false
}

async function call(name, payload) {
  if (!electronAPI.breeze) throw new Error('語音生成需要在 AxonDeck 中使用。')
  const response = await electronAPI.breeze[name](payload)
  if (!response?.ok) throw new Error(response?.error?.message || '語音操作失敗。')
  return response.data
}

function paintStatus(status) {
  installed = Boolean(status.installed)
  serviceBusy = Boolean(status.busy)
  $('speechInstallNotice').hidden = installed
  $('speechModelStatus').textContent = status.busy ? '正在生成語音' : status.loading ? '正在載入模型…' : status.ready ? '模型已就緒 · 本機生成' : installed ? '已安裝 · 生成時載入' : '尚未下載'
  $('speechGenerate').disabled = !installed || serviceBusy || Boolean(requestId)
}

function setMode(next) {
  mode = next
  document.querySelectorAll('.speech-mode').forEach((button) => {
    const selected = button.dataset.mode === mode
    button.classList.toggle('active', selected)
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
    if (selected) $('speechForm').setAttribute('aria-labelledby', button.id)
  })
  const convert = mode === 'convert'
  $('speechForm').dataset.mode = mode
  $('speechVoiceLabel').textContent = convert ? '換成誰的聲音' : '參考聲音'
  $('speechGenerate').textContent = convert ? '開始變聲' : '生成語音'
  $('speechReference').hidden = mode === 'design'
  $('speechSource').hidden = !convert
  $('speechEvents').hidden = convert
  $('speechTextHint').hidden = !convert
  $('speechStreamLabel').hidden = convert
  $('speechInstructionGroup').hidden = mode === 'clone' || convert
  $('speechAcousticGroup').hidden = !convert
  $('speechTextLabel').textContent = convert ? '原錄音逐字稿（可不填）' : '想說的話'
  $('speechText').required = !convert
  $('speechText').placeholder = convert ? '寫下原錄音的內容，能讓變聲更準確。' : '你好，今天想用什麼聲音說故事？'
  $('speechInstructionLabel').textContent = mode === 'direction' ? '希望怎麼說' : '描述你想要的聲音'
  $('speechInstruction').placeholder = mode === 'direction' ? '慢慢說，語氣平靜而認真，最後一句帶一點笑意。' : '溫暖清晰的年輕女性聲音，像在和朋友聊天。'
  $('speechInstruction').required = mode === 'design' || mode === 'direction'
  $('speechTextHint').textContent = convert ? '變聲需要原錄音和目標聲音，整段完成後才能試聽。逐字稿可選填；歌曲可展開進階設定調整旋律。' : '支援中文與英文。點選標記插入游標位置，也能直接在台詞寫 [中文描述] 或 (English description)。'
  $('speechTemperature').value = convert ? '0.3' : '0.9'
  $('speechTopK').value = convert ? '1' : '50'
  for (const id of ['speechTopP', 'speechRepetition', 'speechSplit', 'speechMaxTokens']) {
    $(id).disabled = convert
    $(id).closest('label').hidden = convert
  }
}

function updateVoice() {
  const saved = Boolean($('speechVoice').value)
  $('speechNewReference').hidden = saved
  $('speechDeleteVoice').disabled = !saved || Boolean(requestId)
}

async function refreshVoices() {
  const voices = await call('voices')
  const select = $('speechVoice')
  const selected = select.value
  select.replaceChildren(new Option('新的參考音訊', ''))
  for (const voice of voices) {
    const option = new Option(`${voice.id} · ${voice.invalid ? '聲音檔損壞' : Number(voice.seconds || 0).toFixed(1) + ' 秒'}`, voice.id)
    option.disabled = voice.invalid === true
    select.add(option)
  }
  select.value = voices.some((voice) => voice.id === selected) ? selected : ''
  updateVoice()
  syncCustomSelects()
}

async function pickAudio(kind) {
  const auto = kind === 'reference'
  if (auto) $('speechProgress').textContent = '正在辨識參考音內容…'
  const audio = await call('pickAudio', { kind })
  if (!audio || audio.canceled) { if (auto) $('speechProgress').textContent = ''; return }
  const label = `${audio.name} · ${Number(audio.duration).toFixed(1)} 秒`
  if (auto) {
    reference = audio
    $('speechReferenceName').textContent = label
    if (audio.transcript) {
      $('speechRefText').value = audio.transcript
      $('speechProgress').textContent = '已自動填入逐字稿，檢查一下再生成。'
    } else $('speechProgress').textContent = ''
  } else {
    source = audio
    $('speechSourceName').textContent = label
  }
}

async function saveVoice() {
  if (!reference) throw new Error('請先選擇參考 WAV 音訊。')
  savingVoice = true
  setBusy(true)
  $('speechProgress').textContent = '正在編碼並保存聲音…'
  try {
    const voice = await call('saveVoice', { name: $('speechVoiceName').value.trim(), refAudioId: reference.audioId, refText: $('speechRefText').value.trim() })
    await refreshVoices()
    $('speechVoice').value = voice.id
    updateVoice()
    syncCustomSelects()
    $('speechProgress').textContent = '聲音已保存，下次可以直接使用。'
  } finally { savingVoice = false; setBusy(false) }
}

async function deleteVoice() {
  const id = $('speechVoice').value
  if (!id || !await askConfirm('刪除保存的聲音？', { desc: `「${id}」會從這台電腦移除。`, confirmText: '刪除', danger: true })) return
  await call('removeVoice', { id })
  await refreshVoices()
}

function stopStream() {
  for (const node of playing) { try { node.stop() } catch { /* 已播放完 */ } }
  playing.clear()
  pcmTail = null
  playAt = 0
}

function onChunk(chunk) {
  if (chunk.reqId !== requestId) return
  $('speechProgress').textContent = `已生成 ${Number(chunk.seconds || 0).toFixed(1)} 秒`
  if (mode === 'convert' || !$('speechStream').checked || !audioContext) return
  const data = Uint8Array.from(atob(chunk.pcmBase64), (c) => c.charCodeAt(0))
  const joined = new Uint8Array(data.length + (pcmTail === null ? 0 : 1))
  if (pcmTail !== null) joined[0] = pcmTail
  joined.set(data, pcmTail === null ? 0 : 1)
  pcmTail = joined.length % 2 ? joined[joined.length - 1] : null
  const length = Math.floor(joined.length / 2)
  if (!length) return
  const buffer = audioContext.createBuffer(1, length, chunk.sampleRate)
  const view = new DataView(joined.buffer)
  const samples = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
  const node = audioContext.createBufferSource()
  node.buffer = buffer
  node.connect(audioContext.destination)
  node.onended = () => playing.delete(node)
  playing.add(node)
  playAt = Math.max(playAt, audioContext.currentTime + 0.15)
  node.start(playAt)
  playAt += buffer.duration
}

function payload() {
  const values = {
    reqId: requestId, mode, text: $('speechText').value.trim(),
    instruction: (mode === 'design' || mode === 'direction') ? $('speechInstruction').value.trim() : '',
    cfgScale: Number($('speechCfg').value), seed: Number($('speechSeed').value),
    temperature: Number($('speechTemperature').value), topK: Number($('speechTopK').value)
  }
  if (mode !== 'design') {
    values.voiceId = $('speechVoice').value
    if (!values.voiceId) { values.refAudioId = reference?.audioId; values.refText = $('speechRefText').value.trim() }
  }
  if (mode === 'convert') { values.sourceAudioId = source?.audioId; values.keepAcoustic = Number($('speechAcoustic').value) }
  else {
    values.topP = Number($('speechTopP').value)
    values.repetitionPenalty = Number($('speechRepetition').value)
    values.splitChars = Number($('speechSplit').value)
    values.maxNewTokens = Number($('speechMaxTokens').value)
  }
  return values
}

function setBusy(busy) {
  document.querySelectorAll('#speechForm input, #speechForm textarea, #speechForm select, #speechForm button, .speech-mode').forEach((el) => { el.disabled = busy })
  $('speechCancel').hidden = !busy
  $('speechCancel').disabled = false
  $('speechGenerate').disabled = busy || serviceBusy || !installed
  $('speechGenerate').textContent = busy ? '生成中…' : mode === 'convert' ? '開始變聲' : '生成語音'
  if (!busy) {
    updateVoice()
    for (const id of ['speechTopP', 'speechRepetition', 'speechSplit', 'speechMaxTokens']) $(id).disabled = mode === 'convert'
  }
}

function showResult(result) {
  const data = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0))
  if (audioUrl) URL.revokeObjectURL(audioUrl)
  audioUrl = URL.createObjectURL(new Blob([data], { type: result.mimeType }))
  resultId = result.resultId
  $('speechPlayer').src = audioUrl
  $('speechPlayer').hidden = false
  $('speechExport').disabled = false
  $('speechResultTitle').textContent = '語音已生成'
  $('speechProgress').textContent = `${Number(result.duration).toFixed(1)} 秒 · ${result.sampleRate / 1000} kHz · WAV`
}

async function generate(event) {
  event.preventDefault()
  if (requestId) return
  $('speechError').hidden = true
  stopStream()
  $('speechPlayer').pause()
  requestId = crypto.randomUUID()
  const request = payload()
  setBusy(true)
  $('speechProgress').textContent = '正在準備模型…首次載入需要一點時間。'
  try {
    if (mode !== 'convert' && $('speechStream').checked) {
      audioContext ||= new AudioContext()
      await audioContext.resume()
    }
    showResult(await call('generate', request))
  } catch (error) {
    stopStream()
    showError(error)
    $('speechProgress').textContent = '生成已停止。'
  } finally { requestId = ''; setBusy(false) }
}

async function cancel() {
  if (!requestId && !savingVoice) return
  stopStream()
  await call('cancel', savingVoice ? {} : { reqId: requestId })
}

function action(id, fn) {
  $(id).addEventListener('click', async () => {
    $('speechError').hidden = true
    $(id).disabled = true
    try { await fn() } catch (error) { showError(error) }
    finally { $(id).disabled = false; updateVoice() }
  })
}

function init() {
  initialized = true
  $('speechForm').addEventListener('submit', generate)
  $('speechModelsBtn').addEventListener('click', () => switchPage('hfmodels', 'recommend'))
  document.querySelectorAll('.speech-mode').forEach((button) => {
    button.addEventListener('click', () => { setMode(button.dataset.mode); setBusy(false) })
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...document.querySelectorAll('.speech-mode')]
      const i = buttons.indexOf(button)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
      setMode(buttons[next].dataset.mode)
      buttons[next].focus()
    })
  })
  $('speechText').addEventListener('input', () => { $('speechCount').textContent = `${$('speechText').value.length} / 100000` })
  document.querySelectorAll('[data-event]').forEach((button) => button.addEventListener('click', () => {
    const text = $('speechText')
    if (text.value.length - (text.selectionEnd - text.selectionStart) + button.dataset.event.length > text.maxLength) return
    text.setRangeText(button.dataset.event, text.selectionStart, text.selectionEnd, 'end')
    text.dispatchEvent(new Event('input'))
    text.focus()
  }))
  $('speechVoice').addEventListener('change', updateVoice)
  $('speechPlayer').addEventListener('play', stopStream)
  action('speechPickReference', () => pickAudio('reference'))
  action('speechPickSource', () => pickAudio('source'))
  action('speechSaveVoice', saveVoice)
  action('speechDeleteVoice', deleteVoice)
  action('speechCancel', cancel)
  action('speechExport', async () => {
    const result = await call('saveAudio', { resultId })
    if (result.saved) $('speechProgress').textContent = 'WAV 已匯出。'
  })
  electronAPI.breeze?.onChunk(onChunk)
  electronAPI.breeze?.onStatus(paintStatus)
  electronAPI.breeze?.onProgress((data) => {
    if (data.reqId === requestId) $('speechProgress').textContent = data.phase === 'loading' ? '正在載入模型…' : `正在生成 · ${Number(data.seconds || 0).toFixed(1)} 秒`
  })
  window.addEventListener('beforeunload', () => { stopStream(); if (audioUrl) URL.revokeObjectURL(audioUrl); void audioContext?.close() })
  setMode('design')
}

export async function refreshSpeechPage() {
  if (!initialized) init()
  try {
    paintStatus(await call('status'))
    if (installed && !requestId) await refreshVoices()
  } catch (error) { showError(error) }
}
