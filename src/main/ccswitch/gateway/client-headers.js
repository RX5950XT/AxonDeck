'use strict'

// OpenCode Go 要求可辨識的客戶端與穩定的對話 ID。
// Claude 新版的 metadata.user_id 是 JSON；舊版用 _session_ 後綴。
function sessionId(headers, body) {
  const candidates = [headers?.['x-opencode-session'], headers?.['x-claude-code-session-id'],
    headers?.['claude-code-session-id'], body?.metadata?.session_id]
  const userId = body?.metadata?.user_id
  if (typeof userId === 'string' && userId.length <= 4096) {
    try {
      candidates.push(JSON.parse(userId)?.session_id)
    } catch {
      candidates.push(userId.match(/_session_([A-Za-z0-9_-]+)$/)?.[1])
    }
  }
  return candidates.find((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(value)) || ''
}

function forOpenCode(headers = {}, body = {}) {
  const id = sessionId(headers, body)
  return { 'User-Agent': 'VoiceInk-CCSwitch/1.0', ...(id ? { 'x-opencode-session': id } : {}) }
}

module.exports = { sessionId, forOpenCode }
