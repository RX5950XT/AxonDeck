'use strict'

/**
 * 文字轉語音頁的草稿（store key speechDraft）：稿子、聲音設定、進階參數。
 * renderer 可被 XSS 影響，寫入前只留已知欄位並限制長度與範圍。
 */

const PARAMS = ['speechCfg', 'speechSeed', 'speechTemperature', 'speechTopK', 'speechTopP', 'speechRepetition', 'speechSplit', 'speechMaxTokens', 'speechAcoustic']
const pick = (value, list, fallback) => list.includes(value) ? value : fallback
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''

function sanitizeSpeechDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const params = {}
  for (const key of PARAMS) {
    const number = value.params?.[key]
    if (typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 2147483648) params[key] = number
  }
  const speed = Number(value.cloudSpeed)
  return {
    text: str(value.text, 100000),
    instruction: str(value.instruction, 4000),
    tone: str(value.tone, 4000),
    engine: pick(value.engine, ['local', 'cloud'], 'local'),
    script: pick(value.script, ['whole', 'sentences', 'subtitle', 'convert'], 'whole'),
    voiceKind: pick(value.voiceKind, ['describe', 'mine'], 'describe'),
    voice: /^[A-Za-z0-9_-]{1,64}$/.test(value.voice) ? value.voice : '',
    presetLang: pick(value.presetLang, ['zh', 'en'], 'zh'),
    stream: value.stream !== false,
    cloudModel: str(value.cloudModel, 600),
    cloudVoice: str(value.cloudVoice, 120).replace(/[\r\n\x00]/g, ''),
    cloudSpeed: speed >= 0.25 && speed <= 4 ? speed : 1,
    params
  }
}

module.exports = { sanitizeSpeechDraft }
