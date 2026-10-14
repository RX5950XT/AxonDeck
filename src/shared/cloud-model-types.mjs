export const MODEL_TYPES = Object.freeze({
  unknown: '待選用途', chat: '聊天／翻譯', image: '生圖（聊天）',
  asr: '語音轉文字', tts: '文字轉語音', unsupported: '其他／尚未支援'
})

// 能聽音訊不等於支援轉錄端點；有明確能力才分到對應頁面。
export function classifyModel(raw) {
  const id = typeof raw === 'string' ? raw : [raw?.id, raw?.slug, raw?.name].find((value) => typeof value === 'string') || ''
  const output = Array.isArray(raw?.architecture?.output_modalities) ? raw.architecture.output_modalities : []
  const endpoints = Array.isArray(raw?.supported_endpoints) ? raw.supported_endpoints.filter((value) => typeof value === 'string') : []
  if (output.includes('transcription') || endpoints.some((e) => /(?:^|\/)audio\/transcriptions$/.test(e))) return 'asr'
  if (endpoints.some((e) => /(?:^|\/)audio\/speech$/.test(e))) return 'tts'
  if (output.includes('embeddings') || output.includes('video')) return 'unsupported'
  if (output.includes('image')) return 'image'
  if (output.includes('audio') && !output.includes('text')) return 'tts'
  const name = id.toLowerCase()
  if (/(?:whisper|transcrib|(?:^|[-/])asr(?:[-/]|$))/.test(name)) return 'asr'
  if (/(?:^|[-/])tts(?:[-/]|$)|text-to-speech/.test(name)) return 'tts'
  if (/embedding|rerank|moderation|dall-e|gpt-image|realtime/.test(name)) return 'unsupported'
  if (output.includes('text')) return 'chat'
  // shortcut: 無能力欄位時只認常見文字系列，新系列留給使用者選用途。
  if (/^(?:[^/]+\/)?(?:gpt-(?:[345]|oss)|o[134](?:-|$)|claude-|gemini-|deepseek-|qwen[23](?:\.|-)|llama-)/.test(name)
    && !/audio|image|vision|omni/.test(name)) return 'chat'
  return 'unknown'
}
