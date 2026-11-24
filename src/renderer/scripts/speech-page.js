/**
 * 文字轉語音頁。左邊寫稿（整段／逐句／字幕配音／變聲），右邊選聲音與版本，底部播放列。
 * Breeze 的四種模式由畫面組合推出來：
 *   描述聲音＝design；用錄音的聲音＝clone，有填語氣＝direction；變聲＝convert。
 */
import { initCloudSpeech, refreshCloudSpeech, cloudReady, cloudSnapshot, cloudModelKey, generateCloud, cancelCloud, CLOUD_MAX_CHARS } from './cloud-speech.js'
import { electronAPI, switchPage } from './app.js'
import { askConfirm } from './app-dialog.js'
import { syncCustomSelects } from './custom-select.js'
import { splitSentences, parseSubtitles, formatTime, PRESETS, PRESET_SAMPLE } from './speech-script.js'
import { createPronounce } from './speech-pronounce.js'
import { createAudioInput } from './speech-audio-input.js'
import { createTakeDock } from './speech-takes.js'
import { createStream } from './speech-stream.js'
import { svgIcon } from './speech-wave.js'

const $ = (id) => document.getElementById(id)
const MODE_NAMES = { design: '聲音設計', clone: '語音克隆', direction: '語氣指導', convert: '變聲' }
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024
const LOCAL_MAX_CHARS = 100000
const PARAMS = ['speechCfg', 'speechSeed', 'speechTemperature', 'speechTopK', 'speechTopP', 'speechRepetition', 'speechSplit', 'speechMaxTokens', 'speechAcoustic']
const TEXT_PARAMS = ['speechTopP', 'speechRepetition', 'speechSplit', 'speechMaxTokens']
let engine = 'local'
let script = 'whole'
let voiceKind = 'describe'
let selectedVoice = ''
let presetLang = 'zh'
let reference = null
let source = null
let requestId = ''
let jobCloud = false
let job = false
// 生成中又按生成：當下的設定先拍下來排隊，做完這個接著做
const queue = []
let streaming = false
let stopped = false
let installed = false
let serviceBusy = false
let savingVoice = false
let inputBusy = false
let live = null
let subtitle = null
let savedVoices = []
let voicesLoaded = false
let draftTimer = 0
const speakerVoices = new Map()
let referenceInput, sourceInput, dock, pronounce

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

// ── 狀態 → 畫面 ──

const cloud = () => engine === 'cloud'
/** 雲端只有整段；其他生成方式的設定保留著，切回本機就還原。 */
const view = () => cloud() ? 'whole' : script
const kind = () => view() === 'convert' ? 'mine' : voiceKind

function currentMode() {
  if (view() === 'convert') return 'convert'
  if (kind() === 'describe') return 'design'
  return $('speechTone').value.trim() ? 'direction' : 'clone'
}

function pickRadios(selector, attr, value) {
  document.querySelectorAll(selector).forEach((button) => {
    const on = button.dataset[attr] === value
    button.classList.toggle('active', on)
    button.setAttribute('aria-checked', String(on))
    button.tabIndex = on ? 0 : -1
  })
}

function paintStatus(status) {
  installed = Boolean(status.installed)
  serviceBusy = Boolean(status.busy)
  $('speechModelStatus').textContent = `Breeze-TTS-2 · ${status.busy ? '正在生成' : status.loading ? '正在載入模型…' : status.ready ? '已就緒' : installed ? '已安裝，生成時載入' : '尚未下載'}`
  paint()
}

function paint() {
  // 讀檔／保存聲音時欄位先鎖住，不要被重畫解開
  if (inputBusy || savingVoice) return
  const now = view()
  const convert = now === 'convert'
  const form = $('speechForm')
  form.dataset.engine = engine
  form.dataset.script = now
  form.dataset.mode = currentMode()
  pickRadios('.speech-script-mode', 'script', now)
  pickRadios('#speechBackend button', 'backend', engine)
  pickRadios('#speechVoiceKind button', 'kind', kind())
  $('speechInstallNotice').hidden = cloud() || installed
  $('speechModelStatus').hidden = cloud()
  $('speechLocalVoice').hidden = cloud()
  $('speechCloudVoice').hidden = !cloud()
  document.querySelector('.speech-script-modes').hidden = cloud()
  $('speechText').hidden = now === 'subtitle'
  $('speechCues').hidden = now !== 'subtitle'
  $('speechImportSubtitle').hidden = now !== 'subtitle'
  $('speechEvents').hidden = cloud() || now === 'subtitle' || convert
  $('speechSource').hidden = !convert
  $('speechTextHint').hidden = !convert
  $('speechStreamLabel').hidden = cloud() || convert
  // 變聲一定要有目標聲音：只能用錄音的聲音
  document.querySelector('#speechVoiceKind [data-kind="describe"]').disabled = convert
  $('speechDescribe').hidden = kind() !== 'describe'
  $('speechReference').hidden = kind() !== 'mine'
  $('speechToneGroup').hidden = convert
  $('speechVoiceLabel').textContent = convert ? '換成誰的聲音' : '選一個聲音'
  $('speechAcousticGroup').hidden = !convert
  for (const id of TEXT_PARAMS) { $(id).disabled = convert; $(id).closest('label').hidden = convert }
  $('speechTextLabel').textContent = convert ? '原錄音逐字稿（可不填）' : '想說的話'
  $('speechText').placeholder = convert ? '原錄音逐字稿（可不填）：寫下原錄音的內容，能讓變聲更準確。' : '寫下想讓聲音說的話…'
  $('speechText').maxLength = cloud() ? CLOUD_MAX_CHARS : LOCAL_MAX_CHARS
  $('speechTextHint').textContent = '變聲需要原錄音和目標聲音，整段完成後才能試聽。逐字稿可選填；歌曲可展開進階設定調整旋律。'
  paintVoices()
  renderSpeakers()
  updateCount()
}

function canGenerate() {
  if (savingVoice || inputBusy) return false
  return cloud() ? cloudReady() : installed && (!serviceBusy || job)
}

function paintGenerate() {
  const button = $('speechGenerate')
  button.disabled = !canGenerate()
  $('speechCancel').hidden = !job && !savingVoice
  if (job) { button.textContent = queue.length ? `加入排隊 · 已排 ${queue.length} 個` : '加入排隊'; return }
  const count = view() === 'sentences' ? splitSentences($('speechText').value).length : view() === 'subtitle' ? subtitle?.cues.length || 0 : 0
  button.textContent = currentMode() === 'convert' ? '開始變聲' : count > 1 ? `生成語音 · ${count} 句` : '生成語音'
}

function updateCount() {
  const length = $('speechText').value.length
  const limit = cloud() ? CLOUD_MAX_CHARS : LOCAL_MAX_CHARS
  $('speechCount').textContent = view() === 'subtitle'
    ? (subtitle ? `${subtitle.cues.length} 句 · ${subtitle.speakers.filter(Boolean).length} 個角色` : '尚未匯入')
    : `${length} / ${limit}`
  $('speechCount').classList.toggle('over', view() !== 'subtitle' && length > limit)
  paintGenerate()
}

function setScript(next) {
  // 進出變聲時換一組取樣預設（變聲要低溫）；其他切換不動使用者調過的值
  if ((script === 'convert') !== (next === 'convert')) {
    $('speechTemperature').value = next === 'convert' ? '0.3' : '0.9'
    $('speechTopK').value = next === 'convert' ? '1' : '50'
  }
  script = next
  paint()
  saveDraft()
}

function setEngine(next) {
  engine = next
  paint()
  if (cloud()) void refreshCloudSpeech()
  saveDraft()
}

function setVoiceKind(next) { voiceKind = next; paint(); saveDraft() }

// ── 聲音清單 ──

function voiceRow(id, name, meta, invalid) {
  const row = document.createElement('li')
  const pick = document.createElement('button')
  pick.type = 'button'
  pick.className = 'speech-voice-pick'
  pick.setAttribute('role', 'radio')
  pick.dataset.voice = id
  pick.disabled = invalid
  pick.innerHTML = '<span class="voice-name"></span><span class="voice-meta"></span>'
  pick.querySelector('.voice-name').textContent = name
  pick.querySelector('.voice-meta').textContent = meta
  row.append(pick)
  if (id) {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn-icon voice-delete'
    remove.dataset.remove = id
    remove.setAttribute('aria-label', `刪除聲音「${id}」`)
    remove.title = '刪除這個聲音'
    remove.innerHTML = svgIcon('trash')
    row.append(remove)
  }
  return row
}

function renderVoices() {
  if (voicesLoaded && selectedVoice && !savedVoices.some((voice) => voice.id === selectedVoice && !voice.invalid)) selectedVoice = ''
  $('speechVoiceList').replaceChildren(
    ...savedVoices.map((voice) => voiceRow(voice.id, voice.id, voice.invalid ? '聲音檔損壞' : `${Number(voice.seconds || 0).toFixed(1)} 秒`, voice.invalid === true)),
    voiceRow('', '新的錄音', reference ? reference.name : '選檔或現場錄一段', false))
  paintVoices()
}

function paintVoices() {
  pickRadios('.speech-voice-pick', 'voice', selectedVoice)
  document.querySelectorAll('.speech-voice-pick').forEach((button) => {
    button.disabled = savedVoices.some((voice) => voice.id === button.dataset.voice && voice.invalid)
  })
  $('speechNewReference').hidden = Boolean(selectedVoice)
  const locked = job || savingVoice || inputBusy
  document.querySelectorAll('.voice-delete').forEach((button) => { button.disabled = locked })
  $('speechSaveVoice').disabled = locked
}

async function refreshVoices() {
  savedVoices = await call('voices')
  voicesLoaded = true
  renderVoices()
  renderSpeakers()
}

async function saveVoice() {
  if (!reference) throw new Error('請先選擇或錄一段參考音。')
  savingVoice = true
  setBusy(true)
  $('speechProgress').textContent = '正在編碼並保存聲音…'
  try {
    const voice = await call('saveVoice', { name: $('speechVoiceName').value.trim(), refAudioId: reference.audioId, refText: $('speechRefText').value.trim() })
    selectedVoice = voice.id
    await refreshVoices()
    $('speechProgress').textContent = '聲音已保存，下次可以直接點選。'
    saveDraft()
  } finally { savingVoice = false; setBusy(false) }
}

async function deleteVoice(id) {
  if (!id || !await askConfirm('刪除保存的聲音？', { desc: `「${id}」會從這台電腦移除。`, confirmText: '刪除', danger: true })) return
  await call('removeVoice', { id })
  for (const [speaker, voice] of speakerVoices) if (voice === id) speakerVoices.delete(speaker)
  if (selectedVoice === id) selectedVoice = ''
  await refreshVoices()
  saveDraft()
}

// ── 邊生成邊播放（speech-stream.js） ──

function stopStream() { live?.stop() }

function onChunk(chunk) {
  if (chunk.reqId !== requestId || !streaming) return
  live.push(chunk.pcmBase64, chunk.sampleRate)
}

// ── 生成 ──

/** 一句的請求內容。字幕角色指定了保存的聲音，就用那個聲音（描述聲音改成克隆，語氣指導照樣保留語氣）。 */
function payload({ text, speaker, seed }) {
  const assigned = speaker ? speakerVoices.get(speaker) : ''
  const mode = currentMode()
  const itemMode = assigned && mode === 'design' ? 'clone' : mode
  const values = {
    reqId: requestId, mode: itemMode, text: pronounce.apply(text),
    instruction: itemMode === 'design' ? $('speechInstruction').value.trim() : itemMode === 'direction' ? $('speechTone').value.trim() : '',
    cfgScale: Number($('speechCfg').value), seed: seed ?? Number($('speechSeed').value),
    temperature: Number($('speechTemperature').value), topK: Number($('speechTopK').value)
  }
  if (itemMode !== 'design') {
    values.voiceId = assigned || selectedVoice
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
  if (currentMode() === 'design') return PRESETS.find((preset) => preset[presetLang] === $('speechInstruction').value.trim())?.name || ''
  return selectedVoice || reference?.name || ''
}

/** 讀檔、錄音、保存聲音時：稿子與聲音欄位先鎖住；分頁與版本清單不受影響。 */
function setBusy(busy) {
  inputBusy = busy && !savingVoice
  document.querySelectorAll('#speechEditor :is(input, textarea, button), #speechVoicePanel :is(input, textarea, select, button)').forEach((el) => { el.disabled = busy })
  referenceInput?.setDisabled(busy)
  sourceInput?.setDisabled(busy)
  dock?.setBusy(busy)
  if (busy) { $('speechGenerate').textContent = savingVoice ? '保存聲音中…' : '處理錄音中…'; $('speechGenerate').disabled = true }
  $('speechCancel').hidden = !savingVoice && !job
  $('speechCancel').disabled = false
  if (!busy) {
    inputBusy = false
    paint()
    paintJob()
    syncCustomSelects()
  }
}

/** 排隊生成期間：稿子與設定照樣能改，只鎖住會動到進行中工作的東西（參考音、聲音清單、版本區）。 */
function paintJob() {
  if (!job) return
  referenceInput?.setDisabled(true)
  sourceInput?.setDisabled(true)
  dock?.setBusy(true)
  paintVoices()
  $('speechCancel').hidden = false
  $('speechCancel').disabled = false
  paintGenerate()
}

/** 把目前畫面上的設定拍成一個工作，排隊時改設定不會影響已排的。 */
function snapshot(items, { placement, title, redoSeed }) {
  if (cloud()) return { cloud: cloudSnapshot(), placement, title, items: items.map((item) => ({ ...item, text: pronounce.apply(item.text) })) }
  const convert = currentMode() === 'convert'
  return { placement, title, convert, stream: !convert && $('speechStream').checked,
    modeName: MODE_NAMES[currentMode()], voice: voiceLabel(),
    items: items.map((item) => item.reuse ? item : { ...item, request: payload({ text: item.text, speaker: item.speaker, seed: redoSeed }) }) }
}

async function enqueue(task) {
  queue.push(task)
  if (job) { paintJob(); return }
  job = true
  stopped = false
  stopStream() // 新的生成取代上一段還在播的；排隊中的接著上一個播
  $('speechError').hidden = true
  paintJob()
  try {
    while (queue.length && !stopped) {
      const next = queue.shift()
      await (next.cloud ? runCloudJob(next) : runJob(next))
    }
  } finally {
    queue.length = 0
    job = false
    dock.setProgress(null)
    setBusy(false)
  }
}

async function finishTake(parts, { placement, title, mode, voice }, failure, total) {
  try {
    const usable = parts.length && (!failure || parts.some((p) => p.resultId || p.pcm))
    if (usable) {
      const take = await call('saveTake', { parts, placement, title, mode, voice })
      await dock.refresh(take.id)
      const kept = parts.length < total ? `，保留了完成的 ${parts.length} 句` : ''
      $('speechProgress').textContent = failure || stopped ? `已停止${kept}。` : `${formatTime(take.duration)} · 24 kHz · 已存成新版本`
    } else $('speechProgress').textContent = failure ? '生成已停止。' : ''
    if (failure && !stopped) showError(failure)
  } catch (error) {
    showError(error)
  }
}

/**
 * 依序生成每一句，最後合成一個新版本。items 裡帶 reuse 的句子直接沿用舊版本。
 * 中途停止或出錯時，已完成的句子仍存成版本，不白做。
 */
async function runJob({ items, placement, title, convert, stream, modeName, voice }) {
  const fresh = items.filter((item) => !item.reuse).length
  const parts = []
  let done = 0
  let failure = null
  dock.pause()
  streaming = stream
  dock.setProgress(fresh > 1 ? 0 : -1)
  try {
    if (stream) await live.begin()
    $('speechProgress').textContent = '正在準備模型…首次載入需要一點時間。'
    for (const item of items) {
      if (stopped) break
      const meta = { text: item.text, speaker: item.speaker || '', at: item.at, gap: item.gap }
      if (item.reuse) { parts.push({ ...item.reuse, ...meta }); continue }
      requestId = crypto.randomUUID()
      live.sentence()
      done++
      $('speechProgress').textContent = fresh > 1 ? `正在生成第 ${done} / ${fresh} 句…` : '正在生成…'
      let result = await call('generate', { ...item.request, reqId: requestId })
      // 短句講完又冒出聲音＝模型沒停好在亂念，換種子重來（長稿本來就可能有長停頓，不判）
      for (let retry = 0; result.runaway && !convert && item.text.length <= 200 && retry < 2 && !stopped; retry++) {
        if (stream) live.rewind()
        result = await call('generate', { ...item.request, reqId: requestId, seed: Math.floor(Math.random() * 2147483647) })
      }
      parts.push({ resultId: result.resultId, ...meta })
      if (stream) live.endSentence(item.gap || 0)
      if (fresh > 1) dock.setProgress(done / fresh)
    }
  } catch (error) {
    failure = error
  } finally {
    requestId = ''
    // 生成完不切掉串流：已經排好的聲音會播完（取消時 cancel 已經停掉）
    if (streaming) live.end()
    streaming = false
  }
  await finishTake(parts, { placement, title, mode: modeName, voice }, failure, items.length)
  paintJob()
}

async function runCloudJob({ cloud: request, items, placement, title }) {
  const text = items[0].text
  let failure = null
  const parts = []
  dock.pause()
  dock.setProgress(-1)
  requestId = crypto.randomUUID()
  jobCloud = true
  $('speechProgress').textContent = `正在用 ${request.modelId} 生成…`
  try {
    parts.push({ pcm: await generateCloud({ request, text, requestId }), text, gap: 0 })
  } catch (error) { failure = error }
  finally { requestId = ''; jobCloud = false }
  await finishTake(parts, { placement, title, mode: '雲端', voice: request.voice }, failure, 1)
  paintJob()
}

function currentItems() {
  const now = view()
  if (now === 'convert') {
    if (!source) throw new Error('請先選擇要變聲的錄音。')
    if (!selectedVoice && !reference) throw new Error('請在右邊選一個目標聲音，或錄一段新的。')
    return [{ text: $('speechText').value.trim(), gap: 0 }]
  }
  if (!cloud() && kind() === 'mine' && !selectedVoice && !reference && !(now === 'subtitle' && speakerVoices.size)) {
    throw new Error('請在右邊選一個保存的聲音，或錄一段新的。')
  }
  if (now === 'subtitle') {
    if (!subtitle) throw new Error('請先匯入字幕檔。')
    return subtitle.cues.map((cue) => ({ text: cue.text, speaker: cue.speaker, at: cue.start, gap: 0 }))
  }
  const text = $('speechText').value.trim()
  if (!text) throw new Error('請先寫下想說的話。')
  if (cloud() && text.length > CLOUD_MAX_CHARS) throw new Error(`雲端一次最多 ${CLOUD_MAX_CHARS} 字，請縮短或改用本機。`)
  return now === 'sentences' ? splitSentences(text) : [{ text, gap: 0 }]
}

async function generate(event) {
  event?.preventDefault()
  if ((job && stopped) || $('speechGenerate').disabled) return
  let task
  try {
    const items = currentItems()
    const title = view() === 'subtitle' ? subtitle.name : (items[0]?.text || MODE_NAMES[currentMode()]).slice(0, 40)
    task = snapshot(items, { placement: view() === 'subtitle' ? 'cue' : 'sequence', title })
  } catch (error) { showError(error); return }
  $('speechError').hidden = true
  if (job) $('speechProgress').textContent = `已加入排隊，前面還有 ${queue.length + 1} 個。`
  await enqueue(task)
}

/** 只重做某一句：其他句沿用原版本，換個隨機種子避免念出一模一樣的結果。 */
async function redo(take, index, text) {
  if (job) return
  if (!text) { showError(new Error('這句不能是空的。')); return }
  if (cloud()) { showError(new Error('單句重做只支援本機生成，請先切回本機。')); return }
  const items = take.segments.map((segment, i) => ({ text: i === index ? text : segment.text, speaker: segment.speaker, at: segment.at, gap: segment.gap,
    reuse: i === index ? null : { takeId: take.id, index: i } }))
  await enqueue(snapshot(items, { placement: take.placement, title: take.title, redoSeed: Math.floor(Math.random() * 2147483647) }))
}

// ── 聲音範本 ──

function paintPresets() {
  const value = $('speechInstruction').value.trim()
  document.querySelectorAll('.speech-preset-use').forEach((button) => {
    button.setAttribute('aria-pressed', String(PRESETS[Number(button.dataset.index)][presetLang] === value))
  })
}

function usePreset(preset) {
  $('speechInstruction').value = preset[presetLang]
  paintPresets()
  saveDraft()
}

/** 試聽＝套用範本後用一句固定台詞生成（跟正式生成同一套參數，聽到的就是會得到的聲音）。 */
async function previewPreset(preset) {
  usePreset(preset)
  if (cloud() || $('speechGenerate').disabled || (job && stopped)) return
  if (job) $('speechProgress').textContent = `已加入排隊，前面還有 ${queue.length + 1} 個。`
  await enqueue(snapshot([{ text: PRESET_SAMPLE[presetLang], gap: 0 }], { placement: 'sequence', title: `試聽 · ${preset.name}` }))
}

function renderPresets() {
  $('speechPresetList').replaceChildren(...PRESETS.map((preset, index) => {
    const row = document.createElement('li')
    const use = document.createElement('button')
    use.type = 'button'
    use.className = 'speech-preset-use'
    use.dataset.index = String(index)
    use.textContent = preset.name
    use.title = preset[presetLang]
    use.addEventListener('click', () => usePreset(preset))
    const listen = document.createElement('button')
    listen.type = 'button'
    listen.className = 'btn-icon speech-preset-listen'
    listen.title = listen.ariaLabel = `試聽${preset.name}`
    listen.innerHTML = svgIcon('play')
    listen.addEventListener('click', () => void previewPreset(preset))
    row.append(use, listen)
    return row
  }))
  paintPresets()
}

async function cancel() {
  if (!job && !savingVoice) return
  stopped = true
  queue.length = 0
  stopStream()
  if (jobCloud) await cancelCloud(requestId)
  else await call('cancel', savingVoice ? {} : { reqId: requestId })
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
  paint()
}

function renderSpeakers() {
  const named = subtitle?.speakers.filter(Boolean) || []
  const hidden = view() !== 'subtitle' || !named.length
  $('speechSpeakers').hidden = hidden
  const signature = JSON.stringify([named, savedVoices.map((voice) => voice.id)])
  if (hidden || $('speechSpeakerList').dataset.signature === signature) return
  $('speechSpeakerList').dataset.signature = signature
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
    $('speechSpeakerList').dataset.signature = ''
    $('speechError').hidden = true
    renderCues()
  } catch (error) { showError(error) }
}

// ── 草稿：稿子與聲音設定自動保存，重開 App 接著寫 ──

function draft() {
  return { text: $('speechText').value, instruction: $('speechInstruction').value, tone: $('speechTone').value,
    engine, script, voiceKind, voice: selectedVoice, presetLang, stream: $('speechStream').checked,
    cloudModel: cloudModelKey(), cloudVoice: $('cloudSpeechVoice').value, cloudSpeed: Number($('cloudSpeechSpeed').value),
    params: Object.fromEntries(PARAMS.map((id) => [id, Number($(id).value)])) }
}

function saveDraft(now = false) {
  clearTimeout(draftTimer)
  const write = () => electronAPI.store?.set('speechDraft', draft()).catch((error) => console.error('[speech] 草稿保存失敗:', error))
  if (now) void write()
  else draftTimer = setTimeout(write, 600)
}

async function loadDraft() {
  let value = null
  try { value = await electronAPI.store.get('speechDraft', null) } catch (error) { console.error('[speech] 草稿讀取失敗:', error) }
  if (!value || typeof value !== 'object') { $('speechInstruction').value = PRESETS[0].zh; return '' }
  $('speechText').value = value.text || ''
  $('speechInstruction').value = value.instruction ?? PRESETS[0].zh
  $('speechTone').value = value.tone || ''
  engine = value.engine === 'cloud' ? 'cloud' : 'local'
  script = ['whole', 'sentences', 'subtitle', 'convert'].includes(value.script) ? value.script : 'whole'
  voiceKind = value.voiceKind === 'mine' ? 'mine' : 'describe'
  selectedVoice = value.voice || ''
  presetLang = value.presetLang === 'en' ? 'en' : 'zh'
  $('speechStream').checked = value.stream !== false
  if (value.cloudVoice) $('cloudSpeechVoice').value = value.cloudVoice
  if (Number.isFinite(value.cloudSpeed)) $('cloudSpeechSpeed').value = String(value.cloudSpeed)
  for (const id of PARAMS) if (Number.isFinite(value.params?.[id])) $(id).value = String(value.params[id])
  return value.cloudModel || ''
}

// ── 初始化 ──

function action(button, fn) {
  button.disabled = true
  $('speechError').hidden = true
  Promise.resolve().then(fn).catch(showError).finally(() => { button.disabled = false; paint() })
}

/** 單選群組的方向鍵（事件委派，動態產生的清單也適用）。 */
function radioKeys(container, selector, onPick) {
  container.addEventListener('keydown', (event) => {
    const button = event.target.closest(selector)
    if (!button || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...container.querySelectorAll(selector)].filter((b) => !b.disabled)
    const i = buttons.indexOf(button)
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (back ? -1 : 1) + buttons.length) % buttons.length
    onPick(buttons[next])
    buttons[next].focus()
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
      selectedVoice = ''
      renderVoices()
      $('speechRefText').value = audio.transcript || ''
      $('speechProgress').textContent = audio.transcript ? '已自動填入逐字稿，檢查一下再生成。' : '沒辨識出逐字稿，請手動填寫錄音內容。'
    } })
  sourceInput = createAudioInput({ root: $('speechSourceInput'), kind: 'source', pickId: 'speechPickSource', nameId: 'speechSourceName', call,
    onBusy: busy, onChange(audio) { source = audio; if (audio) $('speechProgress').textContent = '原錄音已就緒。' } })
  $('page-speech').addEventListener('speech-error', (event) => showError(event.detail))
}

function initControls() {
  const form = $('speechForm')
  form.addEventListener('submit', generate)
  // Ctrl+Enter 生成；單行欄位按 Enter 不要誤觸送出
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); void generate() }
    else if (event.target.matches('input')) event.preventDefault()
  })
  // 直接綁在稿子上：程式插入文字送的 input 事件不一定會冒泡
  $('speechText').addEventListener('input', () => { updateCount(); saveDraft() })
  form.addEventListener('input', (event) => {
    if (event.target.id === 'speechTone') { form.dataset.mode = currentMode(); paintGenerate() }
    if (event.target.id === 'speechInstruction') paintPresets()
    saveDraft()
  })
  form.addEventListener('change', () => saveDraft())
  for (const [container, selector, onPick] of [
    [document.querySelector('.speech-script-modes'), '.speech-script-mode', (b) => setScript(b.dataset.script)],
    [$('speechBackend'), 'button', (b) => setEngine(b.dataset.backend)],
    [$('speechVoiceKind'), 'button', (b) => setVoiceKind(b.dataset.kind)],
    [$('speechVoiceList'), '.speech-voice-pick', (b) => { selectedVoice = b.dataset.voice; paintVoices(); saveDraft() }]
  ]) {
    container.addEventListener('click', (event) => { const button = event.target.closest(selector); if (button && !button.disabled) onPick(button) })
    radioKeys(container, selector, onPick)
  }
  $('speechVoiceList').addEventListener('click', (event) => {
    const remove = event.target.closest('.voice-delete')
    if (remove) action(remove, () => deleteVoice(remove.dataset.remove))
  })
  $('speechModelsBtn').addEventListener('click', () => switchPage('hfmodels', 'recommend'))
  document.querySelectorAll('.speech-preset-lang button').forEach((button) => button.addEventListener('click', () => {
    presetLang = button.dataset.lang
    document.querySelectorAll('.speech-preset-lang button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    renderPresets()
    saveDraft()
  }))
  // 標記選單：點外面或按 Esc 收起
  document.addEventListener('pointerdown', (event) => { if (!$('speechEvents').contains(event.target)) $('speechEvents').open = false })
  $('speechEvents').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('speechEvents').open) { $('speechEvents').open = false; $('speechEvents').querySelector('summary').focus() }
  })
  document.querySelectorAll('[data-event]').forEach((button) => button.addEventListener('click', () => {
    const text = $('speechText')
    if (text.value.length - (text.selectionEnd - text.selectionStart) + button.dataset.event.length > text.maxLength) return
    text.setRangeText(button.dataset.event, text.selectionStart, text.selectionEnd, 'end')
    text.dispatchEvent(new Event('input', { bubbles: true }))
    text.focus()
  }))
  $('speechPlayer').addEventListener('play', stopStream)
  $('speechImportSubtitle').addEventListener('click', () => $('speechSubtitleFile').click())
  $('speechSubtitleFile').addEventListener('change', importSubtitle)
  $('speechSaveVoice').addEventListener('click', () => action($('speechSaveVoice'), saveVoice))
  $('speechCancel').addEventListener('click', () => action($('speechCancel'), cancel))
}

async function init() {
  initCloudSpeech({ onStatus: paint })
  initInputs()
  pronounce = createPronounce({ onError: showError })
  dock = createTakeDock({ call, onRedo: redo, onError: showError })
  live = createStream({ onChange: (on) => dock.setLive(on ? live : null) })
  initControls()
  electronAPI.breeze?.onChunk(onChunk)
  electronAPI.breeze?.onStatus(paintStatus)
  electronAPI.breeze?.onProgress((data) => {
    if (data.reqId !== requestId || data.phase !== 'generating') return
    const prefix = $('speechProgress').textContent.match(/^正在生成第 \d+ \/ \d+ 句/)?.[0] || '正在生成'
    $('speechProgress').textContent = `${prefix} · ${Number(data.seconds || 0).toFixed(1)} 秒`
  })
  window.addEventListener('beforeunload', () => {
    if (draftTimer) saveDraft(true)
    live.close(); dock.dispose(); referenceInput.dispose(); sourceInput.dispose()
  })
  const cloudModel = await loadDraft()
  renderPresets()
  document.querySelectorAll('.speech-preset-lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === presetLang)))
  renderVoices()
  paint()
  await Promise.all([pronounce.load(), refreshCloudSpeech(cloudModel)])
}

let starting = null
export async function refreshSpeechPage() {
  if (starting) void refreshCloudSpeech()
  else starting = init()
  await starting
  try {
    paintStatus(await call('status'))
    if (!job) await dock.refresh()
    if (installed && !job) await refreshVoices()
  } catch (error) { showError(error) }
}
