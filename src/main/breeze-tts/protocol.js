'use strict'

const MAX_AUDIO_BYTES = 64 * 1024 * 1024
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
      fields.ref_text = text(options.refText, '參考錄音逐字稿', 10000, true)
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

module.exports = { fail, text, voiceId, validate, wavInfo, wavHeader, savedVoice, MAX_AUDIO_BYTES }
