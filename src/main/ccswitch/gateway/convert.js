'use strict'

/**
 * Anthropic Messages ⇄ OpenAI 的雙向轉換（純函式，可 node 直測）。
 *
 * 兩種上游形狀：
 * - **Responses**（Codex 的 `chatgpt.com/backend-api/codex`、xAI 的 `api.x.ai/v1`）
 * - **Chat Completions**（Ollama Cloud 的 `ollama.com/v1`）
 *
 * 往回走的方向只有一個：不管上游是哪一種，最後都要吐 Anthropic 的 SSE 事件，
 * 因為對面是 Claude Code。所以這裡把上游的串流先收斂成一組中性的 delta
 * （`{ text, reasoning, toolCall, usage, finish }`），再交給 `emitter` 產生 Anthropic 事件。
 */

const stream = require('../../anthropic-stream')

/** 工具參數的 JSON schema 只放行這些欄位（Gemini 那條教訓同理：多送會被上游 400） */
const SCHEMA_KEYS = new Set([
  'type', 'description', 'properties', 'required', 'items', 'enum',
  'additionalProperties', 'default', 'minimum', 'maximum', 'format'
])

/** Anthropic 的 stop_reason */
const STOP_REASONS = {
  stop: 'end_turn',
  completed: 'end_turn',
  length: 'max_tokens',
  max_output_tokens: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn'
}

/**
 * 剝掉模型名尾巴的 `[1m]`（`providers.resolveEnv` 加的 1M 宣告，跟 cc-switch 同一套約定）。
 *
 * **現行版本的 Claude Code 自己就會剝**（實測：`ANTHROPIC_MODEL=some-model[1m]` 送出去的是
 * `some-model`，而且它自己在 `anthropic-beta` 加上 `context-1m-2025-08-07`），所以這支在今天
 * 是空轉的。留著是因為**舊版會原樣送出**（cc-switch issue #3980 的 `claude-fable-5[1m]`），
 * 而上游一律不認——實測 Codex 回 400 `The 'gpt-5.6-sol[1m]' model is not supported`。
 * 成本是一次 regex，換掉「使用者的 CLI 比較舊就整條掛掉」。
 * @param {unknown} model
 * @returns {string}
 */
function stripContextMarker(model) {
  return String(model || '').replace(/\[1m\]$/i, '')
}

/**
 * ChatGPT Codex 後端的 Responses 端點不是公版（實測 `scripts/probe-ccswitch-codex.js`）：
 * - 不明寫 `store: false` → 400 `Store must be set to false`
 * - 帶 `max_output_tokens` 或 `temperature` → 400 `Unsupported parameter`
 *
 * 其餘走 Responses 的上游（Grok／Ollama Cloud／OpenCode Go）沒有這些限制，
 * 所以只對 Codex 那條路由套，不要改成全體通用。
 * @param {object} request
 * @returns {object}
 */
function forCodexBackend(request) {
  const out = { ...request, store: false }
  delete out.max_output_tokens
  delete out.temperature
  return out
}

// ===== Anthropic → 上游 =====

/**
 * `system` 可以是字串或 block 陣列。
 * @param {unknown} system
 * @returns {string}
 */
function systemToText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * `tool_result` 的內容可能是字串或 block 陣列。
 * @param {unknown} content
 * @returns {string}
 */
function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map((block) => (typeof block?.text === 'string' ? block.text : JSON.stringify(block)))
    .join('\n')
}

/**
 * 只留白名單欄位，並遞迴處理巢狀 schema。
 * @param {unknown} schema
 * @returns {object}
 */
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object' }
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue
    if (key === 'properties' && value && typeof value === 'object') {
      /** @type {Record<string, unknown>} */
      const props = {}
      for (const [name, child] of Object.entries(value)) props[name] = sanitizeSchema(child)
      out.properties = props
    } else if (key === 'items') {
      out.items = sanitizeSchema(value)
    } else {
      out[key] = value
    }
  }
  if (!out.type) out.type = 'object'
  return out
}

/**
 * Anthropic 的 tools → OpenAI 的 function 定義。
 * @param {unknown} tools
 * @returns {Array<object>}
 */
function toolsToFunctions(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : ''
    if (!name) continue
    out.push({
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: sanitizeSchema(tool.input_schema)
    })
  }
  return out
}

/**
 * 把 Anthropic 的訊息串攤平成 Responses 的 `input` 項目。
 *
 * `thinking` block **不回送上游**：沒有原始 signature 會被拒（跟 AGY 同一條）。
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
function messagesToResponsesInput(messages) {
  const input = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    const content = message?.content

    if (typeof content === 'string') {
      if (content) input.push({ role, content: [textPart(role, content)] })
      continue
    }
    if (!Array.isArray(content)) continue

    /** @type {Array<object>} */
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        parts.push(textPart(role, block.text))
      } else if (block?.type === 'image' && block.source?.type === 'base64') {
        // 只收 data URI；讓閘道去下載客戶端指定的 http URL 等於開一個 SSRF 跳板
        parts.push({
          type: 'input_image',
          image_url: `data:${block.source.media_type};base64,${block.source.data}`
        })
      } else if (block?.type === 'tool_use') {
        input.push({
          type: 'function_call',
          call_id: String(block.id || ''),
          name: String(block.name || ''),
          arguments: JSON.stringify(block.input ?? {})
        })
      } else if (block?.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: String(block.tool_use_id || ''),
          output: toolResultText(block.content)
        })
      }
      // thinking：刻意丟掉
    }
    if (parts.length) input.push({ role, content: parts })
  }
  return input
}

/**
 * @param {string} role
 * @param {string} text
 * @returns {object}
 */
function textPart(role, text) {
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text }
}

/**
 * Anthropic 的 tool_choice → OpenAI 的字串，或 `{ name }`（指定工具，由呼叫端包成各協議的格式）。
 * @param {unknown} choice
 * @returns {string|{ name: string }|null}
 */
function toolChoiceFor(choice) {
  const type = choice?.type
  if (type === 'any') return 'required'
  if (type === 'none' || type === 'auto') return type
  if (type === 'tool' && choice.name) return { name: String(choice.name) }
  return null
}

/**
 * Anthropic Messages → OpenAI Responses 請求。
 * @param {object} body
 * @param {string} model 上游真正要用的模型名
 * @returns {object}
 */
function toResponsesRequest(body, model) {
  const request = {
    model,
    input: messagesToResponsesInput(body?.messages),
    stream: true
  }
  const system = systemToText(body?.system)
  if (system) request.instructions = system

  const functions = toolsToFunctions(body?.tools)
  if (functions.length) {
    request.tools = functions.map((fn) => ({ type: 'function', ...fn }))
    const choice = toolChoiceFor(body?.tool_choice)
    request.tool_choice = choice?.name ? { type: 'function', name: choice.name } : choice || 'auto'
  }

  const maxTokens = Number(body?.max_tokens)
  if (Number.isFinite(maxTokens) && maxTokens >= 1) request.max_output_tokens = maxTokens
  const temperature = Number(body?.temperature)
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    request.temperature = temperature
  }
  // Anthropic 的 thinking 開關轉成 Responses 的 reasoning
  if (body?.thinking?.type === 'enabled') request.reasoning = { effort: 'medium' }
  return request
}

/**
 * Anthropic Messages → OpenAI Chat Completions 請求（Ollama Cloud 走這條）。
 * @param {object} body
 * @param {string} model
 * @returns {object}
 */
function toChatRequest(body, model) {
  /** @type {Array<object>} */
  const messages = []
  const system = systemToText(body?.system)
  if (system) messages.push({ role: 'system', content: system })

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    const content = message?.content
    if (typeof content === 'string') {
      if (content) messages.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) continue

    const texts = []
    const images = []
    const toolCalls = []
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        texts.push(block.text)
      } else if (block?.type === 'image' && block.source?.type === 'base64') {
        images.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } })
      } else if (block?.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id || ''),
          type: 'function',
          function: { name: String(block.name || ''), arguments: JSON.stringify(block.input ?? {}) }
        })
      } else if (block?.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id || ''),
          content: toolResultText(block.content)
        })
      }
    }
    if (texts.length || images.length || toolCalls.length) {
      const text = texts.join('\n\n')
      // 有圖才用多段 content；純文字維持字串，相容只吃字串的供應商
      const entry = { role, content: images.length ? [...(text ? [{ type: 'text', text }] : []), ...images] : text }
      if (toolCalls.length) entry.tool_calls = toolCalls
      messages.push(entry)
    }
  }

  const request = { model, messages, stream: true }
  const functions = toolsToFunctions(body?.tools)
  if (functions.length) {
    request.tools = functions.map((fn) => ({ type: 'function', function: fn }))
    const choice = toolChoiceFor(body?.tool_choice)
    if (choice) request.tool_choice = choice.name ? { type: 'function', function: { name: choice.name } } : choice
  }
  const maxTokens = Number(body?.max_tokens)
  if (Number.isFinite(maxTokens) && maxTokens >= 1) request.max_tokens = maxTokens
  const temperature = Number(body?.temperature)
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    request.temperature = temperature
  }
  return request
}

// ===== 上游 SSE → 中性 delta =====

/**
 * @typedef {object} Delta
 * @property {string} [text]
 * @property {string} [reasoning]
 * @property {{ id: string, name: string, args: string }} [toolCall] args 是完整 JSON 字串
 * @property {{ input: number, output: number, cached: number }} [usage]
 * @property {string} [finish]
 */

/**
 * Responses 協議的一格 SSE。
 * @param {object} payload
 * @param {{ calls: Map<string, object> }} state
 * @returns {Delta[]}
 */
function consumeResponses(payload, state) {
  const type = String(payload?.type || '')
  /** @type {Delta[]} */
  const out = []

  if (type === 'response.failed' || type === 'error') throw new Error('UPSTREAM_FAILED')
  if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
    out.push({ text: payload.delta })
  } else if (type === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string') {
    out.push({ reasoning: payload.delta })
  } else if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
    state.calls.set(String(payload.item.id || payload.output_index), {
      id: String(payload.item.call_id || payload.item.id || ''),
      name: String(payload.item.name || ''),
      args: ''
    })
  } else if (type === 'response.function_call_arguments.delta') {
    const call = state.calls.get(String(payload.item_id || payload.output_index))
    if (call && typeof payload.delta === 'string') call.args += payload.delta
  } else if (type === 'response.output_item.done' && payload.item?.type === 'function_call') {
    const key = String(payload.item.id || payload.output_index)
    const call = state.calls.get(key) || { id: '', name: '', args: '' }
    state.calls.delete(key)
    out.push({
      toolCall: {
        id: String(payload.item.call_id || call.id || ''),
        name: String(payload.item.name || call.name || ''),
        args: typeof payload.item.arguments === 'string' ? payload.item.arguments : call.args
      }
    })
  } else if (type === 'response.completed' || type === 'response.incomplete') {
    const usage = payload.response?.usage
    if (usage) {
      out.push({
        usage: {
          input: Number(usage.input_tokens) || 0,
          output: Number(usage.output_tokens) || 0,
          cached: Number(usage.input_tokens_details?.cached_tokens) || 0
        }
      })
    }
    out.push({ finish: type === 'response.completed' ? 'completed' : 'length' })
  }
  return out
}

/**
 * Chat Completions 協議的一格 SSE。
 * @param {object} payload
 * @param {{ calls: Map<string, object> }} state
 * @returns {Delta[]}
 */
function consumeChat(payload, state) {
  /** @type {Delta[]} */
  const out = []
  if (payload?.error) throw new Error('UPSTREAM_FAILED')
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null
  const delta = choice?.delta

  if (typeof delta?.content === 'string' && delta.content) out.push({ text: delta.content })
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
    out.push({ reasoning: delta.reasoning_content })
  }

  for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
    const key = String(call.index ?? 0)
    const entry = state.calls.get(key) || { id: '', name: '', args: '' }
    if (call.id) entry.id = String(call.id)
    if (call.function?.name) entry.name = String(call.function.name)
    if (typeof call.function?.arguments === 'string') entry.args += call.function.arguments
    state.calls.set(key, entry)
  }

  if (payload?.usage) {
    out.push({
      usage: {
        input: Number(payload.usage.prompt_tokens) || 0,
        output: Number(payload.usage.completion_tokens) || 0,
        cached: Number(payload.usage.prompt_tokens_details?.cached_tokens) || 0
      }
    })
  }

  if (choice?.finish_reason) {
    // Chat 的 tool call 是一路累加到結束才完整，收尾時一次吐出來
    for (const entry of state.calls.values()) {
      if (entry.name) out.push({ toolCall: { ...entry } })
    }
    state.calls.clear()
    out.push({ finish: String(choice.finish_reason) })
  }
  return out
}

/** @returns {{ calls: Map<string, object> }} */
function newConsumeState() {
  return { calls: new Map() }
}

// ===== 中性 delta → Anthropic 事件（共用 anthropic-stream.js） =====

/**
 * @param {string} model
 * @returns {object}
 */
const createCollector = (model) => stream.createCollector(model, STOP_REASONS)
const { apply, closeStream, toResponse, errorStream } = stream

module.exports = {
  stripContextMarker,
  forCodexBackend,
  SCHEMA_KEYS,
  STOP_REASONS,
  systemToText,
  toolResultText,
  sanitizeSchema,
  toolsToFunctions,
  messagesToResponsesInput,
  toResponsesRequest,
  toChatRequest,
  newConsumeState,
  consumeResponses,
  consumeChat,
  createCollector,
  apply,
  closeStream,
  toResponse,
  errorStream
}
