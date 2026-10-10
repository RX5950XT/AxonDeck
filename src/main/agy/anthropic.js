'use strict'

const stream = require('../anthropic-stream')
const {
  finishReasonOf,
  firstCandidate,
  schemaFor,
  splitParts,
  unwrapEnvelope,
  usageFrom
} = require('./gemini')
const { allowsZeroThinkingBudget, supportsThinking } = require('./model-map')

const MAX_OUTPUT_TOKENS = 65536
const DEFAULT_MAX_TOKENS = 8192

/** Gemini → Anthropic 的 stop_reason */
const STOP_REASONS = Object.freeze({
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  BLOCKLIST: 'refusal'
})

// ===== 請求：Anthropic → Gemini =====

function systemToText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string'
      ? block.text
      : JSON.stringify(block)))
    .join('\n')
}

/**
 * 一則 Anthropic message 的 content blocks → Gemini parts。
 * tool_result 出現在 user 訊息裡，但 Gemini 的 functionResponse 需要工具「名稱」而非 id，
 * 所以要靠 toolNames（前面 assistant 的 tool_use 記下來的 id→name）補齊。
 */
function blocksToParts(content, toolNames) {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []

  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue

    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ text: block.text })
      continue
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      // 歷史思考內容不回送上游：沒有原始 signature，送回去只會被拒
      continue
    }
    if (block.type === 'image') {
      const source = block.source
      if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        parts.push({ inlineData: { mimeType: source.media_type, data: source.data } })
      }
      continue
    }
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
      if (typeof block.id === 'string') toolNames.set(block.id, block.name)
      const args = block.input && typeof block.input === 'object' ? block.input : {}
      // Claude 模型的上游把 functionCall／functionResponse 轉回 tool_use／tool_result，id 是必填
      parts.push({ functionCall: { name: block.name, args, ...(typeof block.id === 'string' && block.id ? { id: block.id } : {}) } })
      continue
    }
    if (block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const name = toolNames.get(id) || 'tool'
      parts.push({
        functionResponse: { name, response: { content: toolResultText(block.content) }, ...(id ? { id } : {}) }
      })
    }
  }
  return parts
}

function toolsToDeclarations(tools, mapped) {
  if (!Array.isArray(tools)) return null
  const declarations = []
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) continue
    // server 端內建工具（web_search 之類）沒有 input_schema，跳過
    if (typeof tool.type === 'string' && tool.type.startsWith('web_')) continue
    const declaration = { name: tool.name }
    if (typeof tool.description === 'string' && tool.description) {
      declaration.description = tool.description.slice(0, 4000)
    }
    const parameters = schemaFor(tool.input_schema, mapped)
    if (parameters) declaration.parameters = parameters
    declarations.push(declaration)
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : null
}

function buildGenerationConfig(body, mapped) {
  const config = {}
  const temperature = Number(body.temperature)
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    config.temperature = temperature
  }
  const topP = Number(body.top_p)
  if (Number.isFinite(topP) && topP >= 0 && topP <= 1) config.topP = topP

  const maxTokens = Number(body.max_tokens)
  config.maxOutputTokens = Number.isFinite(maxTokens) && maxTokens >= 1
    ? Math.min(Math.floor(maxTokens), MAX_OUTPUT_TOKENS)
    : DEFAULT_MAX_TOKENS

  if (Array.isArray(body.stop_sequences)) {
    const sequences = body.stop_sequences.filter((s) => typeof s === 'string' && s).slice(0, 5)
    if (sequences.length) config.stopSequences = sequences
  }

  if (supportsThinking(mapped)) {
    const enabled = body.thinking?.type === 'enabled' || mapped.endsWith('-thinking')
    if (enabled) {
      const budget = Number(body.thinking?.budget_tokens)
      config.thinkingConfig = Number.isFinite(budget) && budget > 0
        ? { includeThoughts: true, thinkingBudget: Math.floor(budget) }
        : { includeThoughts: true }
    } else {
      // 同 openai.js：thinking-only 模型收到 budget 0 會 400
      config.thinkingConfig = allowsZeroThinkingBudget(mapped)
        ? { includeThoughts: false, thinkingBudget: 0 }
        : { includeThoughts: false }
    }
  }
  return config
}

/**
 * @param {object} body Anthropic /v1/messages 請求
 * @param {string} mapped 映射後的上游模型
 */
function toGeminiRequest(body, mapped) {
  const inner = {}
  const toolNames = new Map()

  const system = systemToText(body.system)
  if (system) inner.systemInstruction = { role: 'user', parts: [{ text: system }] }

  const tools = toolsToDeclarations(body.tools, mapped)
  if (tools) {
    inner.tools = tools
    const choice = body.tool_choice?.type
    if (choice === 'none') inner.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    else if (choice === 'any') inner.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
    else if (choice === 'tool' && body.tool_choice.name) {
      // 指定某個工具：只給 ANY 的話模型可以挑別的工具
      inner.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [String(body.tool_choice.name)] } }
    }
  }

  inner.generationConfig = buildGenerationConfig(body, mapped)

  const contents = []
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue
    const parts = blocksToParts(message.content, toolNames)
    if (!parts.length) continue
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  inner.contents = contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }]
  return inner
}

// ===== 回應：Gemini → Anthropic =====

/** @param {string} model */
const createCollector = (model) => stream.createCollector(model, STOP_REASONS)
const { closeStream, toResponse, errorStream } = stream

/** 吃一格上游 SSE，拆成中性 delta 交給 anthropic-stream，回傳要往客戶端寫的事件（可能是空字串） */
function consume(collector, payload) {
  const inner = unwrapEnvelope(payload)
  if (!inner) return ''
  const usage = usageFrom(inner) || undefined
  const candidate = firstCandidate(inner)
  if (!candidate) return stream.apply(collector, { usage })

  const { text, reasoning, calls } = splitParts(candidate)
  // Gemini 一格裡依序是 thinking → 正文 → 工具；用量與結束原因跟第一個 delta 一起送
  const deltas = [{ usage, finish: finishReasonOf(candidate) || undefined, reasoning }, { text },
    ...calls.map((call) => ({ toolCall: { name: call.name, args: JSON.stringify(call.args) } }))]
  return deltas.map((delta) => stream.apply(collector, delta)).join('')
}

module.exports = {
  closeStream,
  consume,
  createCollector,
  errorStream,
  toGeminiRequest,
  toResponse
}
