'use strict'

const { randomUUID } = require('crypto')
const { sanitizeSchema } = require('../ccswitch/gateway/convert')

/**
 * OpenAI Chat Completions ⇄ Responses（純函式，可 node 直測）。
 *
 * Grok 上游只收 Responses，所以 Chat 客戶端的請求在這裡轉過去；
 * 往回走的方向吃 `convert.consumeResponses` 收斂好的中性 delta，吐 Chat 的串流格式。
 */

/** @param {unknown} content */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
}

/**
 * user 的多段 content → Responses 的 input parts。圖片網址交給上游去抓，本機不下載。
 * @param {unknown} content
 * @returns {Array<object>}
 */
function userParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : []
  if (!Array.isArray(content)) return []
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
      parts.push({ type: 'input_text', text: part.text })
    } else if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && /^(data:image\/|https:\/\/)/i.test(url)) parts.push({ type: 'input_image', image_url: url })
    }
  }
  return parts
}

/**
 * @param {Array<object>} messages
 * @returns {{ instructions: string, input: Array<object> }}
 */
function messagesToInput(messages) {
  const system = []
  const input = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text) system.push(text)
    } else if (role === 'assistant') {
      const text = textOf(message.content)
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        input.push({
          type: 'function_call',
          call_id: String(call?.id || ''),
          name: String(call?.function?.name || ''),
          arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {})
        })
      }
    } else if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || ''),
        output: typeof message.content === 'string' ? message.content : textOf(message.content)
      })
    } else {
      const parts = userParts(message?.content)
      if (parts.length) input.push({ role: 'user', content: parts })
    }
  }
  return { instructions: system.join('\n\n'), input }
}

/** @param {unknown} choice */
function toolChoiceFor(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  const name = choice?.function?.name
  return typeof name === 'string' && name ? { type: 'function', name } : null
}

/**
 * Chat Completions 請求 → Responses 請求。
 * @param {object} body
 * @param {string} model 上游模型
 * @param {string} effort 從模型名拆出來的思考強度（優先於 body.reasoning_effort）
 * @returns {object}
 */
function toResponsesRequest(body, model, effort) {
  const { instructions, input } = messagesToInput(body?.messages)
  const request = { model, input, stream: true }
  if (instructions) request.instructions = instructions

  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool) => tool?.type === 'function' && typeof tool.function?.name === 'string' && tool.function.name)
    .map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: typeof tool.function.description === 'string' ? tool.function.description : '',
      parameters: sanitizeSchema(tool.function.parameters),
      strict: false
    }))
  if (tools.length) {
    request.tools = tools
    request.tool_choice = toolChoiceFor(body?.tool_choice) || 'auto'
  }

  const maxTokens = Number(body?.max_completion_tokens ?? body?.max_tokens)
  if (Number.isFinite(maxTokens) && maxTokens >= 1) request.max_output_tokens = Math.floor(maxTokens)
  const temperature = Number(body?.temperature)
  if (body?.temperature != null && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) request.temperature = temperature
  const topP = Number(body?.top_p)
  if (body?.top_p != null && Number.isFinite(topP) && topP > 0 && topP <= 1) request.top_p = topP

  const reasoning = effort || (typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : '')
  if (['xhigh', 'high', 'medium', 'low'].includes(reasoning)) request.reasoning = { effort: reasoning }
  return request
}

// ===== 中性 delta → Chat 串流 =====

/**
 * @param {string} model 回給客戶端的名字（它送來的那個）
 * @param {boolean} includeUsage
 */
function createCollector(model, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    created: Math.floor(Date.now() / 1000),
    model,
    includeUsage,
    started: false,
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: null,
    finish: ''
  }
}

function chunk(collector, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: collector.id,
    object: 'chat.completion.chunk',
    created: collector.created,
    model: collector.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`
}

/**
 * 吃一個中性 delta，回傳要寫給客戶端的 SSE（可能是空字串）。
 * @param {ReturnType<typeof createCollector>} collector
 * @param {{ text?: string, reasoning?: string, toolCall?: { id: string, name: string, args: string }, usage?: object, finish?: string }} delta
 * @returns {string}
 */
function apply(collector, delta) {
  let out = ''
  if (!collector.started && (delta.text || delta.reasoning || delta.toolCall)) {
    collector.started = true
    out += chunk(collector, { role: 'assistant', content: '' })
  }
  if (delta.text) {
    collector.text += delta.text
    out += chunk(collector, { content: delta.text })
  }
  if (delta.reasoning) {
    collector.reasoning += delta.reasoning
    out += chunk(collector, { reasoning_content: delta.reasoning })
  }
  if (delta.toolCall) {
    const index = collector.toolCalls.length
    const call = { id: delta.toolCall.id || `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: delta.toolCall.name, arguments: delta.toolCall.args || '{}' } }
    collector.toolCalls.push(call)
    out += chunk(collector, { tool_calls: [{ index, ...call }] })
  }
  if (delta.usage) collector.usage = delta.usage
  if (delta.finish) collector.finish = delta.finish
  return out
}

function finishReason(collector) {
  if (collector.toolCalls.length) return 'tool_calls'
  return collector.finish === 'length' ? 'length' : 'stop'
}

function usageOf(collector) {
  const input = collector.usage?.input || 0
  const output = collector.usage?.output || 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(collector.usage?.cached ? { prompt_tokens_details: { cached_tokens: collector.usage.cached } } : {})
  }
}

/** @param {ReturnType<typeof createCollector>} collector */
function closeStream(collector) {
  let out = ''
  if (!collector.started) out += chunk(collector, { role: 'assistant', content: '' })
  out += chunk(collector, {}, finishReason(collector))
  if (collector.includeUsage) {
    out += `data: ${JSON.stringify({
      id: collector.id, object: 'chat.completion.chunk', created: collector.created, model: collector.model, choices: [], usage: usageOf(collector)
    })}\n\n`
  }
  return `${out}data: [DONE]\n\n`
}

/** @param {ReturnType<typeof createCollector>} collector */
function toResponse(collector) {
  const message = { role: 'assistant', content: collector.text || (collector.toolCalls.length ? null : '') }
  if (collector.reasoning) message.reasoning_content = collector.reasoning
  if (collector.toolCalls.length) message.tool_calls = collector.toolCalls
  return {
    id: collector.id,
    object: 'chat.completion',
    created: collector.created,
    model: collector.model,
    choices: [{ index: 0, message, finish_reason: finishReason(collector) }],
    usage: usageOf(collector)
  }
}

/** 已經回過 200 之後的錯誤：用一格 error 告知，再收尾 */
function errorStream(collector, code) {
  return `data: ${JSON.stringify({ error: { message: `上游串流中斷（${code}）`, type: 'api_error', code } })}\n\ndata: [DONE]\n\n`
}

module.exports = {
  apply,
  closeStream,
  createCollector,
  errorStream,
  messagesToInput,
  toResponse,
  toResponsesRequest
}
