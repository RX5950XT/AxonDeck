import { initCloudSpeech, refreshCloudSpeech } from './cloud-speech.js'
import { electronAPI, switchPage } from './app.js'
import { askConfirm } from './app-dialog.js'
import { syncCustomSelects } from './custom-select.js'
import { splitSentences, parseSubtitles, applyPronunciations, formatTime } from './speech-script.js'
import { createAudioInput } from './speech-audio-input.js'
import { createTakeDock } from './speech-takes.js'
import { svgIcon } from './speech-wave.js'

const $ = (id) => document.getElementById(id)
const MODE_NAMES = { design: '聲音設計', clone: '語音克隆', direction: '語氣指導', convert: '變聲' }
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024
let initialized = false
let mode = 'design'
let script = 'whole'
let scriptBeforeConvert = ''
let reference = null
let source = null
let requestId = ''
let job = false
let stopped = false
let installed = false
let serviceBusy = false
let savingVoice = false
let audioContext = null
let playAt = 0
let pcmTail = null
let subtitle = null
let savedVoices = []
let pronunciations = []
const speakerVoices = new Map()
const playing = new Set()
let referenceInput, sourceInput, dock

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
  $('speechGenerate').disabled = !installed || serviceBusy || job
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
  // 變聲只能整段；切回其他模式時還原原本的生成方式
  if (convert && script !== 'whole') { scriptBeforeConvert = script; setScript('whole') }
  else if (!convert && scriptBeforeConvert) { setScript(scriptBeforeConvert); scriptBeforeConvert = '' }
  $('speechForm').dataset.mode = mode
  $('speechVoiceLabel').textContent = convert ? '換成誰的聲音' : '參考聲音'
  $('speechReference').hidden = mode === 'design'
  $('speechSource').hidden = !convert
  $('speechEvents').hidden = convert || script === 'subtitle'
  $('speechTextHint').hidden = !convert
  $('speechStreamLabel').hidden = convert
  $('speechInstructionGroup').hidden = mode === 'clone' || convert
  $('speechAcousticGroup').hidden = !convert
  $('speechTextLabel').textContent = convert ? '原錄音逐字稿（可不填）' : '想說的話'
  $('speechText').placeholder = convert ? '原錄音逐字稿（可不填）：寫下原錄音的內容，能讓變聲更準確。' : '你好，今天想用什麼聲音說故事？'
  $('speechInstructionLabel').textContent = mode === 'direction' ? '希望怎麼說' : '描述你想要的聲音'
  $('speechInstruction').placeholder = mode === 'direction' ? '慢慢說，語氣平靜而認真，最後一句帶一點笑意。' : '溫暖清晰的年輕女性聲音，像在和朋友聊天。'
  $('speechTextHint').textContent = convert ? '變聲需要原錄音和目標聲音，整段完成後才能試聽。逐字稿可選填；歌曲可展開進階設定調整旋律。' : '支援中文與英文。點選標記插入游標位置，也能直接在台詞寫 [中文描述] 或 (English description)。'
  $('speechTemperature').value = convert ? '0.3' : '0.9'
  $('speechTopK').value = convert ? '1' : '50'
  for (const id of ['speechTopP', 'speechRepetition', 'speechSplit', 'speechMaxTokens']) {
    $(id).disabled = convert
    $(id).closest('label').hidden = convert
  }
  document.querySelectorAll('.speech-script-mode').forEach((button) => { button.disabled = convert && button.dataset.script !== 'whole' })
  paintGenerateLabel()
}

function setScript(next) {
  script = next
  $('speechForm').dataset.script = script
  document.querySelectorAll('.speech-script-mode').forEach((button) => {
    const selected = button.dataset.script === script
    button.classList.toggle('active', selected)
    button.setAttribute('aria-checked', String(selected))
    button.tabIndex = selected ? 0 : -1
  })
  const sub = script === 'subtitle'
  $('speechText').hidden = sub
  $('speechCues').hidden = !sub
  $('speechImportSubtitle').hidden = !sub
  $('speechSpeakers').hidden = !sub || !subtitle
  $('speechEvents').hidden = sub || mode === 'convert'
  updateCount()
  paintGenerateLabel()
}

function paintGenerateLabel() {
  if (job) return
  const count = script === 'sentences' ? splitSentences($('speechText').value).length : script === 'subtitle' ? subtitle?.cues.length || 0 : 0
  $('speechGenerate').textContent = mode === 'convert' ? '開始變聲' : count > 1 ? `生成語音 · ${count} 句` : '生成語音'
}

function updateCount() {
  $('speechCount').textContent = script === 'subtitle'
    ? (subtitle ? `${subtitle.cues.length} 句 · ${subtitle.speakers.filter(Boolean).length} 個角色` : '尚未匯入')
    : `${$('speechText').value.length} / 100000`
  paintGenerateLabel()
}

function updateVoice() {
  const saved = Boolean($('speechVoice').value)
  $('speechNewReference').hidden = saved
  $('speechDeleteVoice').disabled = !saved || job
}

async function refreshVoices() {
  savedVoices = await call('voices')
  const select = $('speechVoice')
  const selected = select.value
  select.replaceChildren(new Option('新的參考音訊', ''))
  for (const voice of savedVoices) {
    const option = new Option(`${voice.id} · ${voice.invalid ? '聲音檔損壞' : Number(voice.seconds || 0).toFixed(1) + ' 秒'}`, voice.id)
    option.disabled = voice.invalid === true
    select.add(option)
  }
  select.value = savedVoices.some((voice) => voice.id === selected) ? selected : ''
  updateVoice()
  renderSpeakers()
  syncCustomSelects()
}

async function saveVoice() {
  if (!reference) throw new Error('請先選擇或錄一段參考音。')
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
  for (const [speaker, voice] of speakerVoices) if (voice === id) speakerVoices.delete(speaker)
  await refreshVoices()
}

// ── 串流試聽 ──

function stopStream() {
  for (const node of playing) { try { node.stop() } catch { /* 已播放完 */ } }
  playing.clear()
  pcmTail = null
  playAt = 0
}

function onChunk(chunk) {
  if (chunk.reqId !== requestId) return
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

// ── 生成 ──

/** 一句的請求內容。字幕角色指定了保存的聲音，就用那個聲音克隆（語氣指導照樣保留描述）。 */
function payload({ text, speaker, seed }) {
  const assigned = speaker ? speakerVoices.get(speaker) : ''
  const itemMode = assigned && mode === 'design' ? 'clone' : mode
  const values = {
    reqId: requestId, mode: itemMode, text: applyPronunciations(text, pronunciations),
    instruction: (itemMode === 'design' || itemMode === 'direction') ? $('speechInstruction').value.trim() : '',
    cfgScale: Number($('speechCfg').value), seed: seed ?? Number($('speechSeed').value),
    temperature: Number($('speechTemperature').value), topK: Number($('speechTopK').value)
  }
  if (itemMode !== 'design') {
    values.voiceId = assigned || $('speechVoice').value
    if (!values.voiceId) { values.refAudioId = reference?.audioId; values.refText = $('speechRefText').value.trim() }
  }
  if (itemMode === 'convert') { values.sourceAudioId = source?.audioId; values.keepAcoustic = Number($('speechAcoustic').value) }
  else {
    values.topP = Number($('speechTopP').value)
    values.repetitionPenalty = Number($('speechRepetition').value)
    values.splitChars = Number($('speechSplit').value)
    values.maxNewTokens = Number($('speechMaxTokens').value)
  }
  return values
}

function voiceLabel() {
  if (mode === 'design') return ''
  return $('speechVoice').value || reference?.name || ''
}

function setBusy(busy) {
  document.querySelectorAll('#speechForm input, #speechForm textarea, #speechForm select, #speechForm button, .speech-mode').forEach((el) => { el.disabled = busy })
  referenceInput?.setDisabled(busy)
  sourceInput?.setDisabled(busy)
  dock?.setBusy(busy)
  $('speechCancel').hidden = !busy
  $('speechCancel').disabled = false
  $('speechGenerate').disabled = busy || serviceBusy || !installed
  if (busy) $('speechGenerate').textContent = '生成中…'
  if (!busy) {
    updateVoice()
    // 只還原「依模式停用」的欄位，不重跑 setMode（那會把使用者調過的 Temperature 蓋回預設）
    for (const id of ['speechTopP', 'speechRepetition', 'speechSplit', 'speechMaxTokens']) $(id).disabled = mode === 'convert'
    document.querySelectorAll('.speech-script-mode').forEach((button) => { button.disabled = mode === 'convert' && button.dataset.script !== 'whole' })
    paintGenerateLabel()
  }
}

/**
 * 依序生成每一句，最後合成一個新版本。items 裡帶 reuse 的句子直接沿用舊版本。
 * 中途停止或出錯時，已完成的句子仍存成版本，不白做。
 */
async function runJob(items, { placement, title, redoSeed }) {
  const fresh = items.filter((item) => !item.reuse).length
  const parts = []
  let done = 0
  let failure = null
  job = true
  stopped = false
  setBusy(true)
  $('speechError').hidden = true
  dock.pause()
  stopStream()
  try {
    if (mode !== 'convert' && $('speechStream').checked) {
      audioContext ||= new AudioContext()
      await audioContext.resume()
    }
    $('speechProgress').textContent = '正在準備模型…首次載入需要一點時間。'
    for (const item of items) {
      if (stopped) break
      const meta = { text: item.text, speaker: item.speaker || '', at: item.at, gap: item.gap }
      if (item.reuse) { parts.push({ ...item.reuse, ...meta }); continue }
      requestId = crypto.randomUUID()
      done++
      $('speechProgress').textContent = fresh > 1 ? `正在生成第 ${done} / ${fresh} 句…` : '正在生成…'
      const result = await call('generate', payload({ text: item.text, speaker: item.speaker, seed: redoSeed }))
      parts.push({ resultId: result.resultId, ...meta })
    }
  } catch (error) {
    failure = error
  } finally { requestId = '' }
  try {
    const usable = parts.length && (!failure || parts.some((p) => p.resultId))
    if (usable) {
      const take = await call('saveTake', { parts, placement, title, mode: MODE_NAMES[mode], voice: voiceLabel() })
      await dock.refresh(take.id)
      // 結果區在稿子下面，做完捲過去讓人馬上看到（減少動態時直接跳）
      $('speechDockBody').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      const kept = parts.length < items.length ? `，保留了完成的 ${parts.length} 句` : ''
      $('speechProgress').textContent = failure || stopped ? `已停止${kept}。` : `${formatTime(take.duration)} · 24 kHz · 已存成新版本`
    } else $('speechProgress').textContent = failure ? '生成已停止。' : ''
    if (failure && !stopped) showError(failure)
  } catch (error) {
    showError(error)
  } finally {
    job = false
    stopStream()
    setBusy(false)
  }
}

function currentItems() {
  if (mode === 'convert') return [{ text: $('speechText').value.trim(), gap: 0 }]
  if (script === 'subtitle') {
    if (!subtitle) throw new Error('請先匯入字幕檔。')
    return subtitle.cues.map((cue) => ({ text: cue.text, speaker: cue.speaker, at: cue.start, gap: 0 }))
  }
  const text = $('speechText').value.trim()
  if (!text) throw new Error('請先寫下想說的話。')
  return script === 'sentences' ? splitSentences(text) : [{ text, gap: 0 }]
}

async function generate(event) {
  event.preventDefault()
  if (job) return
  let items
  try { items = currentItems() } catch (error) { showError(error); return }
  const title = script === 'subtitle' ? subtitle.name : (items[0]?.text || MODE_NAMES[mode]).slice(0, 40)
  await runJob(items, { placement: script === 'subtitle' ? 'cue' : 'sequence', title })
}

/** 只重做某一句：其他句沿用原版本，換個隨機種子避免念出一模一樣的結果。 */
async function redo(take, index, text) {
  if (job) return
  if (!text) { showError(new Error('這句不能是空的。')); return }
  const items = take.segments.map((segment, i) => ({ text: i === index ? text : segment.text, speaker: segment.speaker, at: segment.at, gap: segment.gap,
    reuse: i === index ? null : { takeId: take.id, index: i } }))
  await runJob(items, { placement: take.placement, title: take.title, redoSeed: Math.floor(Math.random() * 2147483647) })
}

async function cancel() {
  if (!job && !savingVoice) return
  stopped = true
  stopStream()
  await call('cancel', savingVoice ? {} : { reqId: requestId })
}

// ── 字幕 ──

function renderCues() {
  const list = $('speechCueList')
  $('speechCuesEmpty').hidden = Boolean(subtitle)
  $('speechCuesInfo').hidden = !subtitle
  if (subtitle) $('speechCuesInfo').textContent = `${subtitle.name} · ${subtitle.cues.length} 句 · 依字幕時間排好，前一句還沒講完會往後順延。`
  list.replaceChildren(...(subtitle?.cues || []).map((cue) => {
    const row = document.createElement('li')
    row.innerHTML = '<span class="seg-time"></span><span class="seg-speaker"></span><p class="seg-text"></p>'
    row.querySelector('.seg-time').textContent = formatTime(cue.start)
    row.querySelector('.seg-speaker').textContent = cue.speaker
    row.querySelector('.seg-speaker').hidden = !cue.speaker
    row.querySelector('.seg-text').textContent = cue.text
    return row
  }))
  renderSpeakers()
  updateCount()
}

function renderSpeakers() {
  const named = subtitle?.speakers.filter(Boolean) || []
  $('speechSpeakers').hidden = script !== 'subtitle' || !named.length
  $('speechSpeakerList').replaceChildren(...named.map((speaker) => {
    const row = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = speaker
    const select = document.createElement('select')
    select.className = 'input'
    select.setAttribute('aria-label', `${speaker}的聲音`)
    select.add(new Option('跟著下方設定', ''))
    for (const voice of savedVoices.filter((v) => !v.invalid)) select.add(new Option(voice.id, voice.id))
    select.value = speakerVoices.get(speaker) || ''
    select.addEventListener('change', () => {
      if (select.value) speakerVoices.set(speaker, select.value)
      else speakerVoices.delete(speaker)
    })
    row.append(label, select)
    return row
  }))
  syncCustomSelects()
}

async function importSubtitle() {
  const input = $('speechSubtitleFile')
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    if (file.size > MAX_SUBTITLE_BYTES) throw new Error('字幕檔超過 2 MB。')
    const parsed = parseSubtitles(file.name, await file.text())
    subtitle = { ...parsed, name: file.name }
    speakerVoices.clear()
    $('speechError').hidden = true
    renderCues()
  } catch (error) { showError(error) }
}

// ── 讀音字典 ──

function renderPronunciations() {
  $('speechPronounceCount').textContent = String(pronunciations.length)
  $('speechPronounceCount').hidden = !pronunciations.length
  $('speechPronounceList').replaceChildren(...pronunciations.map((item, index) => {
    const row = document.createElement('li')
    row.innerHTML = `<span class="pron-word"></span><span aria-hidden="true">→</span><span class="pron-sound"></span><button type="button" class="btn-icon">${svgIcon('trash')}</button>`
    row.querySelector('.pron-word').textContent = item.word
    row.querySelector('.pron-sound').textContent = item.sound
    const remove = row.querySelector('button')
    remove.setAttribute('aria-label', `移除「${item.word}」的讀音`)
    remove.addEventListener('click', () => { pronunciations = pronunciations.filter((_, i) => i !== index); void savePronunciations() })
    return row
  }))
}

async function savePronunciations() {
  renderPronunciations()
  try { await electronAPI.store.set('speechPronunciations', pronunciations) } catch (error) { showError(error) }
}

function addPronunciation() {
  const word = $('speechPronounceWord').value.trim()
  const sound = $('speechPronounceSound').value.trim()
  if (!word || !sound) { showError(new Error('原字和念法都要填。')); return }
  pronunciations = [...pronunciations.filter((item) => item.word !== word), { word, sound }]
  $('speechPronounceWord').value = ''
  $('speechPronounceSound').value = ''
  void savePronunciations()
  $('speechPronounceWord').focus()
}

function togglePronounce() {
  const panel = $('speechPronounce')
  const text = $('speechText')
  const selected = text.value.slice(text.selectionStart, text.selectionEnd).trim()
  if (selected && selected.length <= 50) { panel.hidden = false; $('speechPronounceWord').value = selected; $('speechPronounceSound').focus() }
  else panel.hidden = !panel.hidden
  $('speechPronounceBtn').setAttribute('aria-expanded', String(!panel.hidden))
}

// ── 初始化 ──

function action(id, fn) {
  $(id).addEventListener('click', async () => {
    $('speechError').hidden = true
    $(id).disabled = true
    try { await fn() } catch (error) { showError(error) }
    finally { $(id).disabled = false; updateVoice() }
  })
}

function radioKeys(selector, onPick) {
  document.querySelectorAll(selector).forEach((button) => {
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...document.querySelectorAll(selector)].filter((b) => !b.disabled)
      const i = buttons.indexOf(button)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
      onPick(buttons[next])
      buttons[next].focus()
    })
  })
}

function initInputs() {
  const busy = (on, message) => {
    setBusy(on)
    if (on) $('speechProgress').textContent = message
  }
  referenceInput = createAudioInput({ root: $('speechReferenceInput'), kind: 'reference', pickId: 'speechPickReference', nameId: 'speechReferenceName', call,
    onBusy: busy, onChange(audio) {
      reference = audio
      if (!audio) return
      $('speechRefText').value = audio.transcript || ''
      $('speechProgress').textContent = audio.transcript ? '已自動填入逐字稿，檢查一下再生成。' : '沒辨識出逐字稿，請手動填寫錄音內容。'
    } })
  sourceInput = createAudioInput({ root: $('speechSourceInput'), kind: 'source', pickId: 'speechPickSource', nameId: 'speechSourceName', call,
    onBusy: busy, onChange(audio) { source = audio; if (audio) $('speechProgress').textContent = '原錄音已就緒。' } })
  $('page-speech').addEventListener('speech-error', (event) => showError(event.detail))
}

async function loadPronunciations() {
  try {
    const value = await electronAPI.store.get('speechPronunciations', [])
    pronunciations = Array.isArray(value) ? value.filter((item) => item?.word && item?.sound) : []
  } catch (error) { console.error('[speech] 讀音字典讀取失敗:', error); pronunciations = [] }
  renderPronunciations()
}

function init() {
  initCloudSpeech()
  const applyBackend = () => {
    const cloud = $('speechBackend').value === 'cloud'
    $('speechLocalPanel').hidden = cloud
    $('speechCloudPanel').hidden = !cloud
    if (cloud) void refreshCloudSpeech()
  }
  $('speechBackend').addEventListener('change', applyBackend)
  // 模組晚載入：初始化前就切過的值也要套用
  applyBackend()
  document.addEventListener('settings-changed', () => void refreshCloudSpeech())
  initialized = true
  initInputs()
  dock = createTakeDock({ call, onRedo: redo, onError: showError })
  $('speechForm').addEventListener('submit', generate)
  $('speechModelsBtn').addEventListener('click', () => switchPage('hfmodels', 'recommend'))
  document.querySelectorAll('.speech-mode').forEach((button) => {
    button.addEventListener('click', () => { setMode(button.dataset.mode); setBusy(false) })
  })
  radioKeys('.speech-mode', (button) => setMode(button.dataset.mode))
  document.querySelectorAll('.speech-script-mode').forEach((button) => button.addEventListener('click', () => { scriptBeforeConvert = ''; setScript(button.dataset.script) }))
  radioKeys('.speech-script-mode', (button) => setScript(button.dataset.script))
  $('speechText').addEventListener('input', updateCount)
  document.querySelectorAll('[data-event]').forEach((button) => button.addEventListener('click', () => {
    const text = $('speechText')
    if (text.value.length - (text.selectionEnd - text.selectionStart) + button.dataset.event.length > text.maxLength) return
    text.setRangeText(button.dataset.event, text.selectionStart, text.selectionEnd, 'end')
    text.dispatchEvent(new Event('input'))
    text.focus()
  }))
  $('speechVoice').addEventListener('change', updateVoice)
  $('speechPlayer').addEventListener('play', stopStream)
  $('speechImportSubtitle').addEventListener('click', () => $('speechSubtitleFile').click())
  $('speechSubtitleFile').addEventListener('change', importSubtitle)
  $('speechPronounceBtn').addEventListener('click', togglePronounce)
  $('speechPronounceAdd').addEventListener('click', addPronunciation)
  $('speechPronounceSound').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addPronunciation() } })
  action('speechSaveVoice', saveVoice)
  action('speechDeleteVoice', deleteVoice)
  action('speechCancel', cancel)
  electronAPI.breeze?.onChunk(onChunk)
  electronAPI.breeze?.onStatus(paintStatus)
  electronAPI.breeze?.onProgress((data) => {
    if (data.reqId !== requestId || data.phase !== 'generating') return
    const prefix = $('speechProgress').textContent.match(/^正在生成第 \d+ \/ \d+ 句/)?.[0] || '正在生成'
    $('speechProgress').textContent = `${prefix} · ${Number(data.seconds || 0).toFixed(1)} 秒`
  })
  window.addEventListener('beforeunload', () => {
    stopStream(); dock.dispose(); referenceInput.dispose(); sourceInput.dispose(); void audioContext?.close()
  })
  setMode('design')
  setScript('whole')
  void loadPronunciations()
}

export async function refreshSpeechPage() {
  if (!initialized) init()
  await refreshCloudSpeech()
  try {
    paintStatus(await call('status'))
    if (!job) await dock.refresh()
    if (installed && !job) await refreshVoices()
  } catch (error) { showError(error) }
}
