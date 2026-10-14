/**
 * AxonDeck - 即時字幕功能
 *
 * - 音訊：AudioContext(16kHz) 直接取 PCM → VAD 在停頓處切句 → ASR
 * - ASR 與翻譯管線分離
 * - openBatch 累積 → seal → translatePump
 * - 開始時 engine.acquire 預熱模型；停止時 release 卸載
 * - 雙語／僅翻譯顯示模式
 */

import { createVad } from './vad.js'
import {
  showToast,
  getSettings,
  electronAPI,
  cleanIpcError,
  ASR_MODEL_KEY,
  resolveTranslateModelKey
} from './app.js'
import { readScope, parseAsrValue, parseLlmValue, resolveScopedCloud, asrOptions, hasLlamaRuntime } from './model-picker.js'
import { syncCustomSelects } from './custom-select.js'
import { newTranscriptId, logTranscript, refreshLiveHistory } from './live-history.js'
import { openRecordingAudio } from './recording-audio.js'

// ===== DOM 元素 =====
let liveLanguage
let startLiveBtn
let stopLiveBtn
let liveStatus
let statusText
let liveEngine
let levelFill
let liveError
/** @type {HTMLSelectElement | null} */
let liveAudioSource

// ===== 狀態 =====
let isCapturing = false
let liveCapture = null
let isStopping = false
let settings = null
/** 這次擷取用的 ASR 是本地還是雲端（狀態列顯示用；來源是 `liveAsr`） */
let liveAsrEngine = 'local'
/** 雲端 ASR 時用的是哪一顆模型（顯示用） */
let liveAsrModelId = ''
let consecutiveFailures = 0
let engineAcquired = false
/** 進入分頁時背景預熱所持有的引擎 owner（與 engineAcquired 互斥：擷取開始即轉交） */
let prewarmed = false
/** 作廢 in-flight prewarm（切頁／失敗／開始擷取時遞增） */
let prewarmGen = 0
/** 防止並行兩次 prewarm */
let prewarmInFlight = false

/** @type {AudioContext | null} */
let audioCtx = null
/** @type {{ source: MediaStreamAudioSourceNode, processor: ScriptProcessorNode, mute: GainNode } | null} */
let audioGraph = null
/** @type {ReturnType<typeof createVad> | null} */
let vad = null

/** @type {Float32Array[]} 已切好、等待 ASR 的語句 */
let pendingUtterances = []
let isProcessing = false
let isStarting = false

/** @type {{ source: string, translation: string }[]} 原文/譯文成對，避免單邊過濾錯位 */
let history = []
const MAX_HISTORY_COUNT = 10
const CONTEXT_SEGMENTS = 2
const CONTEXT_MAX_CHARS = 320
const MIN_TRANSLATE_CHARS = 2
const MAX_BATCH_SEGMENTS = 2
const MAX_BATCH_CHARS = 120
const MAX_TRANSLATE_QUEUE = 5

let targetLanguage = 'zh-TW'
/** 這一場字幕寫進紀錄用的 id；沒在擷取時是空字串（晚到的結果不寫） */
let transcriptId = ''
/** 音源：system＝系統 loopback；mic＝麥克風；both＝合併成一條音訊軌 */
let liveSource = 'system'
/** @type {Promise<void>} */
let liveSourceReady = Promise.resolve()

let sessionEpoch = 0
let batchSeq = 0

/** @type {{ id: string, sources: string[], epoch: number } | null} */
let openBatch = null
/** @type {{ id: string, sources: string[], epoch: number }[]} */
let translateQueue = []
let isTranslating = false

/** sherpa 要 16kHz mono；AudioContext 直接開在這個取樣率就不必自己重採樣 */
const TARGET_SAMPLE_RATE = 16000
/** ScriptProcessor 緩衝大小（必須是 2 的冪）：2048 @16kHz = 128ms */
const FRAME_SIZE = 2048
const MAX_PENDING_UTTERANCES = 2
/** 送進 ASR 的最短語句（VAD 已擋過一次，這是防呆） */
const MIN_UTTERANCE_SAMPLES = TARGET_SAMPLE_RATE / 4

/**
 * 初始化即時字幕功能
 */
export function initLiveCaption() {
  liveLanguage = document.getElementById('liveLanguage')
  startLiveBtn = document.getElementById('startLiveBtn')
  stopLiveBtn = document.getElementById('stopLiveBtn')
  liveStatus = document.getElementById('liveStatus')
  statusText = liveStatus.querySelector('.status-text')
  liveEngine = document.getElementById('liveEngine')
  levelFill = document.getElementById('levelFill')
  liveError = document.getElementById('liveError')
  liveAudioSource = /** @type {HTMLSelectElement | null} */ (document.getElementById('liveAudioSource'))

  startLiveBtn.addEventListener('click', startCapture)
  stopLiveBtn.addEventListener('click', () => stopCapture())
  liveAudioSource?.addEventListener('change', onLiveSourceChange)
  liveLanguage?.addEventListener('change', onSharedLanguageChange)
  liveSourceReady = loadLiveSource()
  loadSharedLanguage()

  electronAPI.subtitle.onClosed(() => {
    if (isCapturing) stopCapture({ closeWindow: false })
  })

  document.addEventListener('settings-changed', async () => {
    // 擷取中改設定也要刷新快照，否則 renderer 判斷與 main 即時讀取的 store 脫鉤
    settings = await getSettings()
    // 未擷取且已預熱：重載以套用這一頁的 liveAsr / liveLlm
    if (isCapturing || isStarting || !electronAPI.engine) return
    // 語音轉文字頁在前景才重新預熱（開始字幕跟語音輸入在同一頁）
    const page = document.getElementById('page-stt')
    if (!page?.classList.contains('active')) return
    if (prewarmed || prewarmInFlight) {
      await cooldownEngine()
    }
    await prewarmEngine()
  })
}

/**
 * 進入即時字幕分頁時背景預熱模型，讓「開始字幕」近乎秒開。
 * 只在未擷取且未持有引擎時做；失敗（如模型未下載）僅記 log，不打擾使用者。
 * acquire 成功後才設 prewarmed，並以 prewarmGen 作廢過期的 in-flight 結果（防洩漏）。
 */
export async function prewarmEngine() {
  if (isCapturing || isStarting || isStopping || prewarmed || prewarmInFlight || !electronAPI.engine) return
  const gen = ++prewarmGen
  prewarmInFlight = true
  if (statusText && !isCapturing) statusText.textContent = '準備模型…'
  try {
    const scope = await readScope('live')
    const r = await electronAPI.engine.acquire('live', {
      asr: parseAsrValue(scope.asr).engine === 'local',
      llm: parseLlmValue(scope.llm).mode === 'local'
    })
    // 擷取已接手（或即將接手）同一個 live owner：不可 release
    if (isCapturing || engineAcquired || isStarting) {
      return
    }
    // 已作廢（切離分頁）：成功佔了 owner 要立刻放掉，避免無人 release
    if (gen !== prewarmGen) {
      if (r && r.ok) {
        await electronAPI.engine.release('live').catch(() => {})
      }
      return
    }
    prewarmed = !!(r && r.ok)
  } catch (e) {
    console.warn('[預熱] 失敗:', e)
    if (gen === prewarmGen) prewarmed = false
  } finally {
    prewarmInFlight = false
    // 預熱完成後若尚未開始擷取，還原狀態文字（勿覆蓋 startCapture 已設的文字）
    if (statusText && !isCapturing && !engineAcquired) statusText.textContent = '未啟動'
  }
}

/**
 * 離開即時字幕分頁且未擷取時卸載預熱的模型，釋放記憶體。
 */
export async function cooldownEngine() {
  prewarmGen++ // 作廢 in-flight prewarm
  if (isCapturing || isStarting || !electronAPI.engine) return
  if (!prewarmed) return
  prewarmed = false
  try {
    await electronAPI.engine.release('live')
  } catch (e) {
    console.warn('[卸載] 失敗:', e)
  }
}

const STT_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'auto'])

/** 目標語言跟檔案轉錄共用，記在 sttLanguage */
async function loadSharedLanguage() {
  try {
    const saved = await electronAPI.store.get('sttLanguage', 'zh-TW')
    if (!liveLanguage || isCapturing || isStarting || !STT_LANGS.has(saved)) return
    liveLanguage.value = saved
    syncCustomSelects()
  } catch {
    // 沒存過就用選單預設
  }
}

function onSharedLanguageChange() {
  if (!liveLanguage || isCapturing || isStarting) return
  const value = STT_LANGS.has(liveLanguage.value) ? liveLanguage.value : 'zh-TW'
  electronAPI.store.set('sttLanguage', value).catch(() => {})
}

/**
 * 記住的音源。store 沒這顆 key 或讀失敗就維持系統聲音（跟改版前一樣）。
 */
async function loadLiveSource() {
  try {
    const saved = await electronAPI.store.get('liveAudioSource', 'system')
    liveSource = ['mic', 'both'].includes(saved) ? saved : 'system'
  } catch {
    liveSource = 'system'
  }
  if (liveAudioSource && !isCapturing && !isStarting && !isStopping) {
    liveAudioSource.value = liveSource
    syncCustomSelects()
  }
  updateMeterTitle()
}

/** 字幕進行中不讓換音源：換的話要先停掉舊的那條，否則麥克風會開兩條關不掉 */
function onLiveSourceChange() {
  if (!liveAudioSource) return
  if (isCapturing || isStarting || isStopping) {
    liveAudioSource.value = liveSource
    syncCustomSelects()
    return
  }
  liveSource = ['mic', 'both'].includes(liveAudioSource.value) ? liveAudioSource.value : 'system'
  updateMeterTitle()
  electronAPI.store.set('liveAudioSource', liveSource).catch(() => {})
}

function updateMeterTitle() {
  const meter = liveStatus?.querySelector('.level-meter')
  if (meter) meter.title = liveSource === 'both' ? '系統＋麥克風音量' : liveSource === 'mic' ? '麥克風音量' : '系統音訊音量'
}

/**
 * 共用錄音的擷取與混音；字幕麥克風保留原本的降噪條件。
 * @param {'system'|'mic'|'both'} source
 */
async function openCaptureStream(source) {
  return openRecordingAudio(source, {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true
  })
}

async function closeCaptureStream() {
  const capture = liveCapture
  liveCapture = null
  if (!capture) return
  try { await capture.close() }
  catch (error) { console.warn('關閉字幕音源失敗:', error) }
}

/**
 * 開始擷取目前選的音源
 */
async function startCapture() {
  // 重入防護：按鈕 disabled 遲至音源到手後才設，雙擊會起兩條錄音管線
  if (isCapturing || isStarting || isStopping) return
  isStarting = true
  updateUI()
  try {
    await liveSourceReady
    const source = liveSource
    settings = await getSettings()
    targetLanguage = liveLanguage.value
    const needsTranslationBackend = targetLanguage !== 'auto'

    // 跟檔案轉錄共用同一份選擇（store 的 live 鍵已跟 file 對齊）
    const scope = await readScope('live')
    const asrChoice = parseAsrValue(scope.asr)
    const llmChoice = parseLlmValue(scope.llm)
    liveAsrEngine = asrChoice.engine
    liveAsrModelId = asrChoice.modelId || ''

    const status = await electronAPI.models.status()
    if (asrChoice.engine !== 'cloud') {
      const asrKey = asrChoice.modelKey || ASR_MODEL_KEY
      const asrDef = status.models[asrKey]
      if (!asrDef?.downloaded) {
        showToast(`本地語音模型（${asrDef?.label || asrKey}）尚未下載，請到 Local SI → 推薦下載`, 'error')
        return
      }
      if (asrDef.requires && !hasLlamaRuntime(status.models)) {
        showToast('還缺執行環境，請到 Local SI → 執行環境安裝', 'error')
        return
      }
    }
    if (asrChoice.engine === 'cloud' && !asrOptions(status.models, settings).find((o) => o.value === scope.asr)?.ready) {
      showToast('目前選用的雲端轉錄設定缺少 API URL 或 API Key，請到設定 → 雲端模型確認', 'error')
      return
    }
    if (needsTranslationBackend && llmChoice.mode === 'local') {
      const llmKey = resolveTranslateModelKey({ localTranslateModel: llmChoice.modelKey }, status.models)
      if (!status.models[llmKey]?.downloaded) {
        showToast('本地翻譯模型未下載，請先到 Local SI → 推薦下載', 'error')
        return
      }
    }
    if (needsTranslationBackend && llmChoice.mode === 'cloud' && !resolveScopedCloud(settings, scope.llm).ready) {
      showToast('雲端翻譯未設定，請在這頁挑「翻譯模型」', 'error')
      return
    }

    try {
      // 1) 先要音源（取消則不載模型），上一組一定先釋放。
      await closeCaptureStream()
      liveCapture = await openCaptureStream(source)
      const audioTracks = liveCapture.stream.getAudioTracks()
      if (audioTracks.length === 0) {
        throw new Error(source === 'mic' ? '無法取得麥克風' : '無法取得系統音訊')
      }
      const audioStream = new MediaStream(audioTracks)
      // 音訊來源被系統收回（切換輸出裝置、藍牙斷線、麥克風被拔）時主動停止
      liveCapture.tracks.forEach(t => t.addEventListener('ended', () => {
        if (isCapturing) stopCapture()
      }))

      // 2) 預熱模型（雲端 ASR 不載 sherpa）
      statusText.textContent = asrChoice.engine === 'cloud' && llmChoice.mode !== 'local'
        ? '準備中…'
        : '載入模型…'
      startLiveBtn.disabled = true
      const needAsr = asrChoice.engine !== 'cloud'
      const needLlm = needsTranslationBackend && llmChoice.mode === 'local'
      const warm = await electronAPI.engine.acquire('live', { asr: needAsr, llm: needLlm })
      if (!warm.ok) {
        throw new Error((warm.warnings && warm.warnings[0]) || '模型載入失敗')
      }
      engineAcquired = true
      prewarmed = false // 擷取接手引擎所有權；卸載改由 stopCapture 負責

      isCapturing = true
      consecutiveFailures = 0
      resetTranslateState()
      transcriptId = newTranscriptId()
      setError(null)
      updateUI()

      await electronAPI.subtitle.show()
      await startPcmCapture(audioStream)
    } catch (error) {
      console.error('開始擷取失敗:', error)
      await stopPcmCapture()
      // 只釋放本次擷取取得的引擎；保留背景 prewarm（取消權限不應拆掉預熱）
      if (engineAcquired) {
        await electronAPI.engine.release('live').catch(() => {})
        engineAcquired = false
      }
      await closeCaptureStream()
      if (error.name === 'NotAllowedError') {
        showToast(source === 'mic' ? '沒有麥克風權限' : '使用者取消了權限請求', 'error')
      } else if (error.name === 'NotFoundError' && source === 'mic') {
        showToast('找不到可用的麥克風', 'error')
      } else {
        showToast(`開始失敗: ${error.message}`, 'error')
      }
      isCapturing = false
      updateUI()
    }
  } finally {
    isStarting = false
    updateUI()
  }
}

function resetTranslateState() {
  sessionEpoch++
  batchSeq = 0
  openBatch = null
  translateQueue = []
  isTranslating = false
  history = []
}

/**
 * 直接從 MediaStream 取 16kHz mono PCM，避免 MediaRecorder 的 opus 編碼／解碼、
 * 固定 2 秒硬切，以及 stop→restart 之間的音訊缺口。
 *
 * ScriptProcessorNode 雖已 deprecated，但仍是 Electron 35 內建、唯一不需額外 worklet
 * 檔案與 CSP 改動的同步 PCM 邊界；128ms/frame 的字幕場景沒有主執行緒負載問題。
 * @param {MediaStream} stream
 */
async function startPcmCapture(stream) {
  audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  if (audioCtx.sampleRate !== TARGET_SAMPLE_RATE) {
    const actualRate = audioCtx.sampleRate
    await audioCtx.close()
    audioCtx = null
    throw new Error(`音訊取樣率初始化失敗（需要 ${TARGET_SAMPLE_RATE}Hz，實際 ${actualRate}Hz）`)
  }

  const source = audioCtx.createMediaStreamSource(stream)
  const processor = audioCtx.createScriptProcessor(FRAME_SIZE, 1, 1)
  // ScriptProcessor 必須接到 destination 才會持續觸發；gain=0 確保系統音訊不回放造成重音。
  const mute = audioCtx.createGain()
  mute.gain.value = 0
  source.connect(processor)
  processor.connect(mute)
  mute.connect(audioCtx.destination)

  vad = createVad({ sampleRate: audioCtx.sampleRate })
  processor.onaudioprocess = (event) => {
    if (!isCapturing || !vad) return
    // inputBuffer 由 Chromium 重用；VAD 會保留 frame，必須複製。
    const frame = new Float32Array(event.inputBuffer.getChannelData(0))
    const result = vad.push(frame)
    levelFill.style.width = Math.min(100, result.level * 400) + '%'
    if (result.utterance) enqueueUtterance(result.utterance)
  }

  audioGraph = { source, processor, mute }
  if (audioCtx.state === 'suspended') await audioCtx.resume()
}

/** 停止 PCM callback 並釋放唯一的 AudioContext。 */
async function stopPcmCapture() {
  if (audioGraph) {
    audioGraph.processor.onaudioprocess = null
    for (const node of [audioGraph.source, audioGraph.processor, audioGraph.mute]) {
      try { node.disconnect() } catch { /* already disconnected */ }
    }
    audioGraph = null
  }
  if (vad) {
    vad.reset()
    vad = null
  }
  if (audioCtx) {
    const ctx = audioCtx
    audioCtx = null
    try { await ctx.close() } catch (e) { console.warn('關閉 AudioContext 失敗:', e) }
  }
}

/**
 * ASR 正在跑時最多保留兩句，若再塞入則丟最舊的未處理句，避免字幕越積越慢。
 * @param {Float32Array} samples
 */
function enqueueUtterance(samples) {
  if (!(samples instanceof Float32Array) || samples.length < MIN_UTTERANCE_SAMPLES) return
  applySampleGain(samples)
  pendingUtterances.push(samples)
  while (pendingUtterances.length > MAX_PENDING_UTTERANCES) pendingUtterances.shift()
  pumpQueue()
}

async function pumpQueue() {
  if (isProcessing || pendingUtterances.length === 0) return
  isProcessing = true
  const samples = pendingUtterances.shift()
  try {
    await transcribeUtterance(samples)
    consecutiveFailures = 0
    setError(null)
  } catch (error) {
    console.error('處理語句失敗:', error)
    consecutiveFailures++
    setError(cleanIpcError(error))
    if (consecutiveFailures >= 3) {
      showToast('連續轉錄失敗，已停止字幕', 'error')
      stopCapture()
      return
    }
  } finally {
    isProcessing = false
  }
  pumpQueue()
}

/**
 * 低音量來源最多補 8×；VAD 在補增益前判斷，數位靜音不會被放大成語音。
 * @param {Float32Array} samples
 */
function applySampleGain(samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak >= 0.3 || peak === 0) return
  const gain = Math.min(0.9 / peak, 8)
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
}

/**
 * @param {Float32Array} samples
 */
async function transcribeUtterance(samples) {
  const epoch = sessionEpoch
  // 模型由 main 讀 store 決定（asrEngine ＋ asrModelKey），renderer 不指定
  const sourceText = (await electronAPI.localAsr.transcribe({
    samples,
    sampleRate: TARGET_SAMPLE_RATE,
    lang: targetLanguage
  }) || '').trim()

  // 停止／重開後才 resolve 的 stale ASR 結果不得再進管線（否則觸發翻譯並幽靈重載已卸載的 LLM）
  if (!isCapturing || epoch !== sessionEpoch || !sourceText) return

  if (isRepetitionLoop(sourceText)) {
    console.log('[過濾] 重複循環輸出:', sourceText.slice(0, 30))
    return
  }

  // 非語言性片段會讓小翻譯模型改走對話模式，進翻譯管線前丟棄。
  if (!hasLinguisticContent(sourceText)) {
    console.log('[過濾] 無語言內容:', JSON.stringify(sourceText.slice(0, 20)))
    return
  }

  handleAsrResult(sourceText)
}

/**
 * @param {string} sourceText
 */
function handleAsrResult(sourceText) {
  const shouldTranslate =
    targetLanguage !== 'auto' &&
    hasLinguisticContent(sourceText) &&
    needsTranslation(sourceText, targetLanguage)

  if (!shouldTranslate) {
    if (openBatch) {
      sealOpenBatch()
      pumpTranslate() // 必呼叫，避免佇列卡住
    }
    const id = nextBatchId()
    upsertSubtitle(id, sourceText, '')
    // 不 pushPair(原文,原文)：identity 前文會教 0.8B 模型「原樣輸出」，下一段日文被整段複誦（雙語變兩行日文）

    if (
      targetLanguage !== 'auto' &&
      !needsTranslation(sourceText, targetLanguage)
    ) {
      console.log('[略過翻譯] 偵測已是目標語:', sourceText.slice(0, 40))
    }
    return
  }

  if (!openBatch) {
    openBatch = { id: nextBatchId(), sources: [sourceText], epoch: sessionEpoch }
  } else {
    openBatch.sources.push(sourceText)
  }

  upsertSubtitle(openBatch.id, openBatch.sources.join(' '), '')

  const joined = openBatch.sources.join(' ')
  const shouldSeal =
    openBatch.sources.length >= MAX_BATCH_SEGMENTS ||
    joined.length >= MAX_BATCH_CHARS ||
    !isTranslating

  if (shouldSeal) sealOpenBatch()
  pumpTranslate()
}

function nextBatchId() {
  batchSeq += 1
  return `b-${sessionEpoch}-${batchSeq}`
}

function sealOpenBatch() {
  if (!openBatch || openBatch.sources.length === 0) {
    openBatch = null
    return
  }
  translateQueue.push(openBatch)
  openBatch = null
  // 翻譯跟不上時丟最舊的未處理批次，避免佇列與延遲無限增長（原文已即時上屏）
  while (translateQueue.length > MAX_TRANSLATE_QUEUE) translateQueue.shift()
}

async function pumpTranslate() {
  if (isTranslating || translateQueue.length === 0) return
  isTranslating = true

  const batch = translateQueue.shift()
  const epoch = batch.epoch
  const joinedSource = batch.sources.join(' ').trim()

  try {
    if (epoch !== sessionEpoch || !joinedSource) return

    const context = buildTranslateContext(joinedSource)
    const translated = (await electronAPI.translate(joinedSource, targetLanguage, {
      previousSource: context.previousSource,
      previousTranslation: context.previousTranslation,
      mode: 'live',
      scope: 'live'
    }) || '').trim()

    if (epoch !== sessionEpoch) return

    if (translated && translated !== joinedSource) {
      upsertSubtitle(batch.id, joinedSource, translated)
      pushPair(joinedSource, translated)
    } else {
      // 空白或模型複誦原文（echo）：顯示原文、不把 identity 譯文寫進 history（否則會持續教模型複誦）
      if (!translated) setError('翻譯回傳空白，顯示原文')
      pushPair(joinedSource, '')
    }
  } catch (error) {
    if (epoch !== sessionEpoch) return
    setError(`翻譯失敗，顯示原文：${cleanIpcError(error)}`)
    pushPair(joinedSource, '')
  } finally {
    // 舊 session 的翻譯晚回時不得清掉新 session 的鎖或觸發其 pump
    if (epoch === sessionEpoch) {
      isTranslating = false
      if (openBatch && openBatch.sources.length > 0) {
        sealOpenBatch()
      }
      pumpTranslate()
    }
  }
}

function upsertSubtitle(id, source, translation) {
  electronAPI.subtitle.update({
    id,
    source,
    translation,
    action: 'upsert'
  })
  logTranscript(transcriptId, id, source, translation)
}

function pushPair(source, translation) {
  history.push({ source, translation })
  if (history.length > MAX_HISTORY_COUNT) history.shift()
}

function buildTranslateContext(currentBatchSource) {
  // 只取有譯文、且非當前批次的成對前文，原文/譯文永遠對齊
  const usable = history
    .filter(h => h.translation && h.source !== currentBatchSource)
    .slice(-CONTEXT_SEGMENTS)
  return {
    previousSource: trimContext(usable.map(h => h.source).join(' ')),
    previousTranslation: trimContext(usable.map(h => h.translation).join(' '))
  }
}

function trimContext(text) {
  const t = (text || '').trim()
  if (t.length <= CONTEXT_MAX_CHARS) return t
  return t.slice(-CONTEXT_MAX_CHARS)
}

function isRepetitionLoop(text) {
  return /(.{1,6}?)(?:[，,、。.\s]*\1){7,}/.test(text)
}

/**
 * 是否含足夠語言性字元（字母／漢字／假名／諺文）。
 * 純符號、♪音樂、數字、標點、零寬/格式字元不算——這類片段會讓小翻譯模型改用對話模式。
 * @param {string} text
 */
function hasLinguisticContent(text) {
  return text.replace(/[^\p{L}]/gu, '').length >= MIN_TRANSLATE_CHARS
}

function needsTranslation(text, targetLang) {
  const cjkCount = (text.match(/[一-鿿]/g) || []).length
  const cjkRatio = cjkCount / Math.max(1, text.length)
  // 有假名/諺文即為日/韓文，即使漢字比例高也需翻成中文
  if (targetLang.startsWith('zh')) return /[ぁ-ヿ가-힯]/.test(text) || cjkRatio < 0.3
  if (targetLang === 'en') return cjkRatio > 0.1 || /[ぁ-ヿ가-힯]/.test(text)
  if (targetLang === 'ja') return !/[ぁ-ヿ]/.test(text)
  if (targetLang === 'ko') return !/[가-힯]/.test(text)
  return true
}

/**
 * @param {{closeWindow?: boolean}} options
 */
async function stopCapture({ closeWindow = true } = {}) {
  if (isStopping) return
  isStopping = true
  isCapturing = false
  updateUI()
  transcriptId = ''
  resetTranslateState()
  pendingUtterances = []
  await stopPcmCapture()

  await closeCaptureStream()

  // 等 in-flight ASR 結束再 release，配合 main 側 loadEnabled 避免幽靈重載
  const waitStart = Date.now()
  while (isProcessing && Date.now() - waitStart < 15000) {
    await new Promise((r) => setTimeout(r, 50))
  }

  if (engineAcquired) {
    try {
      await electronAPI.engine.release('live')
    } catch (e) {
      console.error('engine.release failed:', e)
    }
    engineAcquired = false
  }
  prewarmed = false // 擷取結束後引擎已卸；重新進分頁才再預熱

  try {
    if (closeWindow) await electronAPI.subtitle.close()
  } finally {
    isStopping = false
    updateUI()
    refreshLiveHistory()
  }
}

function updateUI() {
  startLiveBtn.classList.toggle('hidden', isCapturing)
  startLiveBtn.disabled = isStarting || isStopping
  stopLiveBtn.classList.toggle('hidden', !isCapturing)
  liveLanguage.disabled = isStarting || isCapturing || isStopping
  // 錄到一半換音源會再 getUserMedia 一條，舊的不一定關得掉。先停字幕再換。
  if (liveAudioSource) liveAudioSource.disabled = isStarting || isCapturing || isStopping
  updateMeterTitle()
  liveStatus.classList.toggle('active', isCapturing)
  statusText.textContent = isCapturing ? '擷取中' : isStarting ? '準備中…' : '未啟動'

  if (isCapturing) {
    liveEngine.textContent = liveAsrEngine === 'cloud'
      ? `· 雲端 ASR${liveAsrModelId ? `（${liveAsrModelId}）` : ''}`
      : '· 本地 Qwen3-ASR'
  } else {
    liveEngine.textContent = ''
    levelFill.style.width = '0%'
  }
}

function setError(message) {
  liveError.classList.toggle('hidden', !message)
  liveError.textContent = message || ''
}
