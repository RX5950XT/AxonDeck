'use strict'

/**
 * 中性 delta → Anthropic Messages 事件（SSE）與非串流回應。
 * CC Proxy 轉換閘道（OpenAI／Codex 上游）與 AGY 反代（Gemini 上游）共用；
 * 各自把上游格式拆成 Delta 後丟進 `apply`，stop_reason 對照表由呼叫端給。
 *
 * @typedef {{ text?: string, reasoning?: string,
 *   toolCall?: { id?: string, name: string, args?: string },
 *   usage?: { input?: number, output?: number, cached?: number }, finish?: string }} Delta
 */

const { randomUUID } = require('crypto')

const shortId = () => randomUUID().replace(/-/g, '').slice(0, 24)

/**
 * @param {string} model
 * @param {Record<string, string>} stopReasons 上游結束原因 → Anthropic stop_reason
 * @returns {object}
 */
function createCollector(model, stopReasons) {
  return {
    id: `msg_${shortId()}`,
    model,
    stopReasons,
    text: '',
    reasoning: '',
    calls: [],
    usage: null,
    finish: '',
    started: false,
    blockIndex: -1,
    blockType: ''
  }
}

/**
 * @param {string} type
 * @param {object} payload
 * @returns {string}
 */
function event(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * @param {object} collector
 * @returns {string}
 */
function closeBlock(collector) {
  if (collector.blockType === '') return ''
  const out = event('content_block_stop', { type: 'content_block_stop', index: collector.blockIndex })
  collector.blockType = ''
  return out
}

/**
 * @param {object} collector
 * @param {string} type
 * @param {object} block
 * @returns {string}
 */
function openBlock(collector, type, block) {
  let out = closeBlock(collector)
  collector.blockIndex += 1
  collector.blockType = type
  out += event('content_block_start', {
    type: 'content_block_start',
    index: collector.blockIndex,
    content_block: block
  })
  return out
}

/**
 * @param {object} collector
 * @returns {string}
 */
function messageStart(collector) {
  collector.started = true
  return event('message_start', {
    type: 'message_start',
    message: {
      id: collector.id,
      type: 'message',
      role: 'assistant',
      model: collector.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: collector.usage?.input ?? 0, output_tokens: 0 }
    }
  })
}

/**
 * 吃一個中性 delta，回傳要寫給客戶端的 Anthropic 事件（可能是空字串）。
 * @param {object} collector
 * @param {Delta} delta
 * @returns {string}
 */
function apply(collector, delta) {
  let out = ''
  if (delta.usage) collector.usage = delta.usage
  if (delta.finish) collector.finish = delta.finish

  const hasContent = delta.text || delta.reasoning || delta.toolCall
  if (!collector.started && hasContent) out += messageStart(collector)

  if (delta.reasoning) {
    if (collector.blockType !== 'thinking') {
      out += openBlock(collector, 'thinking', { type: 'thinking', thinking: '' })
    }
    collector.reasoning += delta.reasoning
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: collector.blockIndex,
      delta: { type: 'thinking_delta', thinking: delta.reasoning }
    })
  }

  if (delta.text) {
    if (collector.blockType !== 'text') {
      out += openBlock(collector, 'text', { type: 'text', text: '' })
    }
    collector.text += delta.text
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: collector.blockIndex,
      delta: { type: 'text_delta', text: delta.text }
    })
  }

  if (delta.toolCall) {
    const id = delta.toolCall.id || `toolu_${shortId()}`
    let args = {}
    try {
      args = delta.toolCall.args ? JSON.parse(delta.toolCall.args) : {}
    } catch {
      // 上游吐的 arguments 不是合法 JSON：給空物件比讓整條串流掛掉好
      args = {}
    }
    collector.calls.push({ id, name: delta.toolCall.name, args })
    // 上游一次給完整 args，不需要拆成多格 input_json_delta
    out += openBlock(collector, 'tool_use', { type: 'tool_use', id, name: delta.toolCall.name, input: {} })
    out += event('content_block_delta', {
      type: 'content_block_delta',
      index: collector.blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) }
    })
  }

  return out
}

/**
 * @param {object} collector
 * @returns {string}
 */
function stopReasonFor(collector) {
  if (collector.calls.length) return 'tool_use'
  return collector.stopReasons[collector.finish] || 'end_turn'
}

/** @param {object} collector */
function usageOf(collector) {
  return {
    input_tokens: collector.usage?.input ?? 0,
    output_tokens: collector.usage?.output ?? 0,
    ...(collector.usage?.cached ? { cache_read_input_tokens: collector.usage.cached } : {})
  }
}

/**
 * @param {object} collector
 * @returns {string}
 */
function closeStream(collector) {
  let out = collector.started ? '' : messageStart(collector)
  out += closeBlock(collector)
  out += event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReasonFor(collector), stop_sequence: null },
    // 用量多半最後才到，message_start 那時還是 0，收尾要補上輸入與快取
    usage: usageOf(collector)
  })
  out += event('message_stop', { type: 'message_stop' })
  return out
}

/**
 * 非串流客戶端要的完整回應。
 * @param {object} collector
 * @returns {object}
 */
function toResponse(collector) {
  const content = []
  if (collector.reasoning) content.push({ type: 'thinking', thinking: collector.reasoning })
  if (collector.text) content.push({ type: 'text', text: collector.text })
  for (const call of collector.calls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
  }
  if (!content.length) content.push({ type: 'text', text: '' })

  return {
    id: collector.id,
    type: 'message',
    role: 'assistant',
    model: collector.model,
    content,
    stop_reason: stopReasonFor(collector),
    stop_sequence: null,
    usage: usageOf(collector)
  }
}

/**
 * 串流中途出錯：Anthropic 的錯誤事件型別是 `error`。
 * 先把開著的 content block 收掉，否則照協議追蹤區塊狀態的客戶端會卡在半開。
 * @param {object} collector
 * @param {string} code
 * @returns {string}
 */
function errorStream(collector, code) {
  return closeBlock(collector) +
    event('error', { type: 'error', error: { type: 'api_error', message: code } })
}

module.exports = { createCollector, apply, closeStream, toResponse, errorStream }
