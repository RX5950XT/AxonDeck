/** 本地 ASR：兩顆推薦模型共用 Local SI 的 llama-server router。 */
const { app } = require('electron')
const models = require('./models')
const hfmodels = require('./hfmodels')
const { float32ToWav, normalizeSamples } = require('./cloud-asr')
const { s2twp, shouldS2twpSource } = require('./opencc')
const MAX_SAMPLES = 16000 * 120

function stripAsrTags(text) {
  if (typeof text !== 'string') return ''
  const marker = text.indexOf('<asr_text>')
  const body = marker >= 0 ? text.slice(marker + '<asr_text>'.length) : text
  return body.replace(/<\/asr_text>\s*$/, '').trim()
}

function toAsrLang(lang) {
  if (typeof lang !== 'string' || !lang || lang === 'auto') return undefined
  if (lang === 'zh-TW' || lang === 'zh-CN') return 'zh'
  return /^[a-z]{2}$/i.test(lang) ? lang.toLowerCase() : undefined
}

async function transcribeModel(key, req) {
  const rate = Number(req?.sampleRate) || 16000
  if (rate !== 16000) throw new Error(`不支援的 sampleRate: ${rate}`)
  const samples = normalizeSamples(req?.samples)
  if (!samples.length) return ''
  if (samples.length > MAX_SAMPLES) throw new Error('音訊過長（上限兩分鐘）')
  const endpoint = hfmodels.endpoint()
  if (!endpoint) throw new Error('本地推論執行環境已停止')
  const form = new FormData()
  form.append('model', key)
  form.append('file', new Blob([float32ToWav(samples, rate)], { type: 'audio/wav' }), 'audio.wav')
  form.append('response_format', 'json')
  const lang = toAsrLang(req?.lang)
  if (lang) form.append('language', lang)
  let res
  try {
    res = await fetch(`${endpoint.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      body: form, signal: AbortSignal.timeout(120000)
    })
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? '本地轉錄逾時' : '本地轉錄連線失敗，請重新開始轉錄')
  }
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`本地轉錄失敗（HTTP ${res.status}）`)
  }
  let json
  try { json = await res.json() } catch { throw new Error('本地轉錄回應不是有效 JSON') }
  if (typeof json?.text !== 'string') throw new Error('本地轉錄回應格式錯誤')
  const text = stripAsrTags(json.text)
  return text && shouldS2twpSource(text, req?.lang) ? s2twp(text) : text
}

function createAsr(key) {
  if (!models.isAsrKey(key)) throw new Error('未知的本地語音模型')
  let store = null
  let loaded = false
  let pending = null
  let generation = 0
  async function warm() {
    if (loaded && hfmodels.endpoint()) return { ok: true, warnings: [] }
    if (pending) return pending
    const started = generation
    pending = (async () => {
      try {
        if (!models.isDownloaded(key)) throw new Error('本地語音模型尚未下載，請到 Local SI → 推薦下載')
        hfmodels.init({ userDataPath: app.getPath('userData'), store })
        await hfmodels.writePresets()
        await hfmodels.ensureRuntime()
        const rows = await hfmodels.refreshModels()
        if (!rows.some((row) => row.id === key)) await hfmodels.applyPresets()
        if (started !== generation) return { ok: false, warnings: ['模型載入已取消'] }
        if (!await hfmodels.loadModel(key)) throw new Error('本地語音模型載入失敗')
        if (started !== generation) {
          await hfmodels.unloadModel(key)
          return { ok: false, warnings: ['模型載入已取消'] }
        }
        loaded = true
        return { ok: true, warnings: [] }
      } catch (e) {
        loaded = false
        return { ok: false, warnings: [e.message] }
      }
    })()
    try { return await pending } finally { pending = null }
  }
  return {
    ASR_MODEL_KEY: key,
    setStore: (value) => { store = value },
    warm,
    isLoaded: () => loaded && !!hfmodels.endpoint(),
    unload: async () => {
      generation++
      loaded = false
      await pending
      if (hfmodels.endpoint()) await hfmodels.unloadModel(key)
      return { ok: true, warnings: [] }
    },
    transcribe: async (req) => {
      const result = await warm()
      if (!result.ok) throw new Error(result.warnings[0])
      return transcribeModel(key, req)
    }
  }
}

module.exports = { ...createAsr('qwen3asrgpu'), createAsr, stripAsrTags, toAsrLang }
