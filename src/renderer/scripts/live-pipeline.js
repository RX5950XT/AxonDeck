/**
 * AxonDeck - 即時字幕的辨識與翻譯流程（一場字幕一個實例，停止後整個丟掉）
 *
 * 同一句話還沒講完就先辨識整段音訊，每次多聽一點就重新辨識一次。後面的音訊會把前面聽錯的字
 * 修回來（實測「節點輕和信合」多聽兩秒變「節點親和性」），所以字幕可以一邊顯示一邊修正。
 * 講完才定稿：定稿的文字才進逐字稿、才當下一句的前文。
 *
 * 純資料進出，無 DOM 依賴 → `node scripts/test-live-pipeline.js` 可直測。
 */

const SAMPLE_RATE = 16000
const MIN_UTTERANCE_SAMPLES = SAMPLE_RATE / 4
/** 聽滿這麼長才開始第一次辨識：再短模型常回一個字，字幕只會閃 */
const MIN_INTERIM_SAMPLES = SAMPLE_RATE * 0.8
/** 比上次多聽這麼多才值得再辨識一次 */
const MIN_INTERIM_GROWTH = SAMPLE_RATE * 0.4
/** 兩次重新辨識的最短間隔。雲端每次都要傳整段音訊且計費，不跟本地一樣快 */
const INTERIM_GAP_MS = { local: 500, cloud: 1000 }
const INTERIM_BACKOFF_MAX_MS = 8000
/** 中途結果等不到就算了，不能佔著唯一的辨識名額讓定稿排隊 */
const INTERIM_TIMEOUT_MS = 8000
/** 定稿排隊的音訊上限；超過代表跟不上，最舊的用已經聽到的文字定稿 */
const MAX_PENDING_SAMPLES = SAMPLE_RATE * 30
const MAX_FAILURES = 3
const PROMPT_CHARS = 160

const INTERIM_TRANSLATE_GAP_MS = { local: 1000, cloud: 2000 }
const INTERIM_TRANSLATE_HOLD_MS = 5000
const MIN_INTERIM_TRANSLATE_LETTERS = 6
const MIN_TRANSLATE_LETTERS = 2
const MAX_HISTORY = 10
const CONTEXT_SEGMENTS = 2
const CONTEXT_MAX_CHARS = 320
const MAX_TRANSLATE_QUEUE = 5
const STOP_WAIT_MS = 15000

/** Whisper 把靜音或音樂聽成訓練資料裡的片尾字卡；只擋短句，長句可能真的在講這些 */
const WHISPER_PHANTOM = /Amara\.org|点赞|點贊|打赏|打賞|明[镜鏡]|[优優][优優][独獨]播|字幕[由製制]|Subtitles? by/i
const PHANTOM_MAX_CHARS = 40
/** 短句真的可能連講兩次（謝謝、對對對），夠長才算模型照抄前文 */
const ECHO_MIN_CHARS = 12

const letterCount = (text) => text.replace(/[^\p{L}]/gu, '').length
const trimContext = (text) => text.trim().slice(-CONTEXT_MAX_CHARS)

function isRepetitionLoop(text) {
  return /(.{1,6}?)(?:[，,、。.\s]*\1){7,}/.test(text)
}

/**
 * 模型聽錯的東西不進字幕。純符號、♪ 也擋：這類片段會讓小翻譯模型改走對話模式。
 * @param {string} raw
 * @param {string} prompt 這次送出的前文：模型照抄前文也算沒聽到東西
 * @returns {string}
 */
export function cleanTranscript(raw, prompt = '') {
  const text = String(raw || '').trim()
  if (letterCount(text) < MIN_TRANSLATE_LETTERS || isRepetitionLoop(text)) return ''
  if (text.length <= PHANTOM_MAX_CHARS && WHISPER_PHANTOM.test(text)) return ''
  return text.length >= ECHO_MIN_CHARS && prompt.endsWith(text) ? '' : text
}

/**
 * @param {string} text
 * @param {string} targetLang
 * @returns {boolean}
 */
export function needsTranslation(text, targetLang) {
  if (targetLang === 'auto') return false
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
 * @typedef {{ id: string, text: string, translation: string, translatedFrom: string, covered: number, final: boolean }} Line
 * @typedef {{ samples: Float32Array, line: Line, ended: boolean }} FinalJob
 * @typedef {{ speaking: boolean, bufferedSamples: number, snapshot: () => Float32Array | null }} VadView
 */

/**
 * @param {object} o
 * @param {'local'|'cloud'} o.asrEngine
 * @param {'local'|'cloud'} o.llmEngine
 * @param {string} o.targetLanguage
 * @param {number} o.hangoverSamples VAD 判定句尾要等的靜音長度
 * @param {(req: object) => Promise<string>} o.transcribe
 * @param {(text: string, lang: string, opts: object) => Promise<string>} o.translate
 * @param {(payload: object) => void} o.show 更新字幕視窗
 * @param {(key: string, source: string, translation: string) => void} o.log 寫逐字稿
 * @param {(message: string | null) => void} o.onError
 * @param {() => void} o.onFatal 連續辨識失敗，該停了
 * @param {(error: unknown) => string} o.errorText
 * @param {() => number} [o.now]
 */
export function createCaptionPipeline(o) {
  const now = o.now || Date.now
  const gap = INTERIM_GAP_MS[o.asrEngine] || INTERIM_GAP_MS.local
  const translateGap = INTERIM_TRANSLATE_GAP_MS[o.llmEngine] || INTERIM_TRANSLATE_GAP_MS.local

  let stopped = false
  let lineSeq = 0
  /** @type {Line | null} 還在聽的那一句 */
  let current = null
  /** @type {FinalJob[]} */
  let pending = []
  /** 辨識一次只跑一個：定稿優先，閒著才做中途結果 */
  let busy = false
  let failures = 0
  let nextInterimAt = 0
  let interimDelay = gap
  /** 定稿過的原文，當下一句的前文（只有雲端模型吃得進去，本地實測沒有影響） */
  let recentSource = ''

  /** @type {{ source: string, translation: string }[]} */
  let history = []
  /** @type {Line[]} */
  let translateQueue = []
  let translating = false
  let nextInterimTranslateAt = 0

  function newLine() {
    lineSeq += 1
    return { id: `b-${now()}-${lineSeq}`, text: '', translation: '', translatedFrom: '', covered: 0, final: false }
  }

  /** @param {Line} line */
  function show(line) {
    o.show({ id: line.id, source: line.text, translation: line.translation, action: 'upsert', interim: !line.final })
  }

  /**
   * @param {Float32Array} samples
   * @param {boolean} interim
   */
  async function recognize(samples, interim) {
    applySampleGain(samples)
    const prompt = o.asrEngine === 'cloud' ? recentSource : ''
    const raw = await o.transcribe({
      samples,
      sampleRate: SAMPLE_RATE,
      // lang 只決定輸出要不要轉繁體。辨識語言交給模型自己聽：目標語言是翻譯的目的地，
      // 當成辨識語言送出去會把英文聽成中文（實測 1.2 秒的英文變「今天我們會說」）
      lang: o.targetLanguage,
      autoDetect: true,
      ...(prompt ? { prompt } : {}),
      ...(interim && o.asrEngine === 'cloud' ? { timeoutMs: INTERIM_TIMEOUT_MS } : {})
    })
    return cleanTranscript(raw, prompt)
  }

  /** @param {VadView} vad 每個音訊 frame 呼叫一次 */
  function onSpeech(vad) {
    if (stopped || busy || pending.length || !vad.speaking) return
    const buffered = vad.bufferedSamples
    if (buffered < MIN_INTERIM_SAMPLES || now() < nextInterimAt) return
    if (current && buffered - current.covered < MIN_INTERIM_GROWTH) return
    const samples = vad.snapshot()
    if (samples) runInterim(samples)
  }

  /** @param {Float32Array} samples */
  async function runInterim(samples) {
    const line = current || (current = newLine())
    const started = now()
    busy = true
    try {
      const text = await recognize(samples, true)
      if (stopped) return
      line.covered = samples.length
      interimDelay = gap
      // 模型跑得比間隔慢就跟著放慢，CPU 跑不會把整台電腦佔滿
      nextInterimAt = now() + Math.max(gap, (now() - started) * 1.2)
      // 模型會在沒講完的片段後面也補句號，顯示出來像一句一句跳
      const heard = text.replace(/[。．.]+$/u, '')
      if (heard && heard !== line.text && !line.final) {
        line.text = heard
        show(line)
        pumpTranslate()
      }
    } catch {
      // 中途結果失敗不算錯：定稿會再辨識一次。429 之類就拉長間隔
      interimDelay = Math.min(INTERIM_BACKOFF_MAX_MS, interimDelay * 2)
      nextInterimAt = now() + interimDelay
    } finally {
      busy = false
      pumpFinal()
    }
  }

  /**
   * VAD 切出一句。continuing＝音訊還沒停，是太長被切開的。
   * @param {Float32Array} samples
   * @param {boolean} continuing
   */
  function pushUtterance(samples, continuing) {
    if (stopped) return
    const line = current || newLine()
    current = null
    nextInterimAt = 0
    if (samples.length < MIN_UTTERANCE_SAMPLES) return
    pending.push({ samples, line, ended: !continuing })
    let total = pending.reduce((sum, job) => sum + job.samples.length, 0)
    while (total > MAX_PENDING_SAMPLES && pending.length > 1) {
      const dropped = /** @type {FinalJob} */ (pending.shift())
      total -= dropped.samples.length
      finalize(dropped.line, dropped.line.text)
    }
    pumpFinal()
  }

  async function pumpFinal() {
    if (busy || stopped || pending.length === 0) return
    const job = /** @type {FinalJob} */ (pending.shift())
    busy = true
    try {
      // 句尾只多了靜音：中途結果已經聽完整句，不必再跑一次，字幕立刻定稿
      const heardAll = job.ended && job.line.text && job.line.covered >= job.samples.length - o.hangoverSamples
      const text = heardAll ? job.line.text : await recognize(job.samples, false)
      if (stopped) return
      finalize(job.line, text || job.line.text)
      failures = 0
      o.onError(null)
    } catch (error) {
      if (stopped) return
      console.error('處理語句失敗:', error)
      finalize(job.line, job.line.text)
      failures += 1
      o.onError(o.errorText(error))
      if (failures >= MAX_FAILURES) {
        o.onFatal()
        return
      }
    } finally {
      busy = false
    }
    pumpFinal()
  }

  /**
   * @param {Line} line
   * @param {string} text
   */
  function finalize(line, text) {
    if (!text) return
    line.text = text
    line.final = true
    recentSource = `${recentSource} ${text}`.trim().slice(-PROMPT_CHARS)
    if (!needsTranslation(text, o.targetLanguage)) {
      // 不 pushPair(原文,原文)：identity 前文會教 0.8B 模型「原樣輸出」，下一段日文被整段複誦
      line.translation = ''
      finishLine(line)
      return
    }
    if (line.translatedFrom === text) {
      history.push({ source: text, translation: line.translation })
      if (history.length > MAX_HISTORY) history.shift()
      finishLine(line)
      return
    }
    show(line)
    o.log(line.id, line.text, '')
    translateQueue.push(line)
    // 翻譯跟不上時丟最舊的，避免延遲無限增長（原文已經上屏）
    while (translateQueue.length > MAX_TRANSLATE_QUEUE) translateQueue.shift()
    pumpTranslate()
  }

  /** @param {Line} line */
  function finishLine(line) {
    show(line)
    o.log(line.id, line.text, line.translation)
  }

  /** @returns {Line | null} 還在聽的那句值不值得先翻一版 */
  function interimToTranslate() {
    const line = current
    if (!line?.text || line.text === line.translatedFrom || now() < nextInterimTranslateAt) return null
    if (letterCount(line.text) < MIN_INTERIM_TRANSLATE_LETTERS) return null
    return needsTranslation(line.text, o.targetLanguage) ? line : null
  }

  /** 只取有譯文、且非當前這句的成對前文，原文/譯文永遠對齊 */
  function translateContext(source) {
    const usable = history.filter((h) => h.translation && h.source !== source).slice(-CONTEXT_SEGMENTS)
    return {
      previousSource: trimContext(usable.map((h) => h.source).join(' ')),
      previousTranslation: trimContext(usable.map((h) => h.translation).join(' '))
    }
  }

  /**
   * @param {Line} line
   * @param {string} source
   * @param {string} translated
   */
  function applyFinalTranslation(line, source, translated) {
    // 空白或模型複誦原文：顯示原文、不寫進 history（否則會持續教模型複誦）
    const usable = translated && translated !== source ? translated : ''
    if (usable) line.translation = usable
    if (!translated) o.onError('翻譯回傳空白，顯示原文')
    history.push({ source, translation: usable })
    if (history.length > MAX_HISTORY) history.shift()
    finishLine(line)
  }

  async function pumpTranslate() {
    if (translating || stopped) return
    const finalLine = translateQueue.shift() || null
    const line = finalLine || interimToTranslate()
    if (!line) return
    translating = true
    const source = line.text
    const started = now()
    try {
      const translated = String(await o.translate(source, o.targetLanguage, {
        ...translateContext(source), mode: 'live', scope: 'live'
      }) || '').trim()
      if (stopped) return
      if (finalLine) {
        applyFinalTranslation(line, source, translated)
      } else {
        nextInterimTranslateAt = now() + Math.max(translateGap, (now() - started) * 1.2)
        if (translated && translated !== source) {
          line.translation = translated
          line.translatedFrom = source
          show(line)
        }
      }
    } catch (error) {
      if (stopped) return
      if (finalLine) {
        o.onError(`翻譯失敗，顯示原文：${o.errorText(error)}`)
        applyFinalTranslation(line, source, source)
      } else {
        nextInterimTranslateAt = now() + INTERIM_TRANSLATE_HOLD_MS
      }
    } finally {
      translating = false
      if (!stopped) pumpTranslate()
    }
  }

  /** 停止：還沒定稿的字先寫進逐字稿，等進行中的辨識結束（呼叫端之後才卸載模型） */
  async function stop() {
    if (stopped) return
    stopped = true
    for (const line of [...pending.map((job) => job.line), current]) {
      if (line?.text && !line.final) o.log(line.id, line.text, line.translation)
    }
    pending = []
    current = null
    translateQueue = []
    history = []
    const started = Date.now()
    while (busy && Date.now() - started < STOP_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  return { onSpeech, pushUtterance, stop }
}
