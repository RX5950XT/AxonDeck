'use strict'

const MAX_AUDIO_BYTES = 64 * 1024 * 1024
const ASR_SAMPLE_RATE = 16000
const ASR_MAX_SECONDS = 120
const LIMITS = {
  cfgScale: ['cfg_scale', 0, 10], seed: ['seed', -2147483648, 2147483647, true],
  temperature: ['temperature', 0, 2], topK: ['top_k', 0, 1024, true],
  topP: ['top_p', 0, 1], repetitionPenalty: ['repetition_penalty', 0, 3],
  splitChars: ['split_chars', 0, 10000, true], maxNewTokens: ['max_new_tokens', 0, 30000, true],
  keepAcoustic: ['keep_acoustic', 0, 15, true]
}

function fail(code, userMessage) {
  return Object.assign(new Error(userMessage), { code, userMessage })
}

function text(value, label, max = 100000, required = false) {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) {
    throw fail('INVALID_INPUT', `${label}未填寫或長度不符`)
  }
  return value.trim()
}

function voiceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw fail('INVALID_INPUT', '聲音名稱只能用英文、數字、短橫線或底線，最多 64 字')
  }
  return value
}

function validate(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('INVALID_INPUT', '語音設定格式不符')
  if (!['design', 'clone', 'direction', 'convert'].includes(options.mode)) throw fail('INVALID_INPUT', '不支援的語音模式')
  const mode = options.mode
  const fields = { text: text(options.text, '文字', 100000, mode !== 'convert') }
  const instruction = text(options.instruction, '聲音描述', 4000, mode === 'design' || mode === 'direction')
  if (instruction && mode !== 'clone' && mode !== 'convert') fields.instruction = instruction
  if (mode !== 'design') {
    if (options.voiceId) fields.voice_id = voiceId(options.voiceId)
    else {
      if (typeof options.refAudioId !== 'string') throw fail('INVALID_INPUT', '請選擇參考錄音或已保存的聲音')
      try {
        fields.ref_text = text(options.refText, '參考錄音逐字稿', 10000, true)
      } catch {
        throw fail('INVALID_INPUT', '參考錄音還沒有逐字稿：選檔後會自動辨識，辨識不出來再手動填寫')
      }
    }
  }
  if (mode === 'convert' && typeof options.sourceAudioId !== 'string') throw fail('INVALID_INPUT', '請選擇要轉換的錄音')
  for (const [key, [field, min, max, integer]] of Object.entries(LIMITS)) {
    const value = options[key]
    if (value === undefined || value === '') continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw fail('INVALID_INPUT', '進階參數超出範圍')
    }
    if (mode !== 'convert' || ['cfgScale', 'seed', 'temperature', 'topK', 'keepAcoustic'].includes(key)) fields[field] = String(value)
  }
  return fields
}

function wavInfo(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw fail('INVALID_AUDIO', '請選擇完整的 WAV 錄音')
  }
  let format, dataBytes = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > bytes.length) throw fail('INVALID_AUDIO', 'WAV 錄音資料不完整')
    if (name === 'fmt ' && length >= 16) {
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), bits: bytes.readUInt16LE(start + 14) }
    }
    if (name === 'data') dataBytes += length
    offset = start + length + (length % 2)
  }
  if (!format || ![1, 3, 65534].includes(format.encoding) || !format.channels || !format.bits ||
      format.sampleRate < 8000 || format.sampleRate > 384000 || !format.byteRate || !dataBytes) {
    throw fail('INVALID_AUDIO', 'WAV 錄音須使用 PCM 或浮點音訊')
  }
  return { sampleRate: format.sampleRate, duration: dataBytes / format.byteRate }
}

/**
 * WAV → 本地 ASR 吃的 16kHz 單聲道 Float32。只取前 120 秒（跟 ASR 上限對齊），
 * 太長的參考音本來就不適合拿來克隆。丟進來的格式不支援就拋錯，由呼叫端退回手動填寫。
 */
function wavToMono16k(bytes, maxSeconds = ASR_MAX_SECONDS) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw fail('INVALID_AUDIO', '請選擇完整的 WAV 錄音')
  }
  let encoding = 0, channels = 0, sampleRate = 0, bits = 0
  const parts = []
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > bytes.length) throw fail('INVALID_AUDIO', 'WAV 錄音資料不完整')
    if (name === 'fmt ' && length >= 16 && !encoding) {
      encoding = bytes.readUInt16LE(start); channels = bytes.readUInt16LE(start + 2)
      sampleRate = bytes.readUInt32LE(start + 4); bits = bytes.readUInt16LE(start + 14)
    } else if (name === 'data') {
      parts.push(bytes.subarray(start, start + length))
    }
    offset = start + length + (length % 2)
  }
  if (!channels || !sampleRate || ![16, 32].includes(bits) || ![1, 3, 65534].includes(encoding) || !parts.length) {
    throw fail('INVALID_AUDIO', '參考音訊須是 16-bit 或 32-bit WAV')
  }
  const data = Buffer.concat(parts)
  const stride = (bits / 8) * channels
  const frames = Math.floor(data.length / stride)
  const take = Math.min(frames, Math.floor(sampleRate * maxSeconds))
  const mono = new Float32Array(take)
  for (let i = 0; i < take; i++) {
    let sum = 0
    for (let ch = 0; ch < channels; ch++) {
      const at = (i * channels + ch) * (bits / 8)
      const value = bits === 16 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at)
      sum += Math.max(-1, Math.min(1, value))
    }
    mono[i] = sum / channels
  }
  if (sampleRate === ASR_SAMPLE_RATE) return mono
  const outLength = Math.floor((take * ASR_SAMPLE_RATE) / sampleRate)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = (i * sampleRate) / ASR_SAMPLE_RATE
    const lo = Math.floor(pos), hi = Math.min(lo + 1, take - 1)
    out[i] = mono[lo] + (mono[hi] - mono[lo]) * (pos - lo)
  }
  return out
}

function wavHeader(byteLength, sampleRate) {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(byteLength + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36)
  header.writeUInt32LE(byteLength, 40)
  return header
}

function savedVoice(bytes, id) {
  if (bytes.length < 24 || bytes.toString('ascii', 0, 4) !== 'BRZV' || bytes.readUInt32LE(4) !== 1) {
    throw fail('INVALID_VOICE', '保存的聲音資料不完整')
  }
  const rate = bytes.readUInt32LE(8), books = bytes.readUInt32LE(12)
  const frames = bytes.readUInt32LE(16), length = bytes.readUInt32LE(20)
  if (rate !== 24000 || books !== 16 || !frames || length > 40000 || 24 + length + frames * books * 4 !== bytes.length) {
    throw fail('INVALID_VOICE', '保存的聲音資料格式不符')
  }
  return { id: voiceId(id), saved: true, seconds: frames / 12.5,
    refText: text(bytes.toString('utf8', 24, 24 + length), '逐字稿', 10000) }
}

module.exports = { fail, text, voiceId, validate, wavInfo, wavHeader, wavToMono16k, savedVoice, MAX_AUDIO_BYTES }
