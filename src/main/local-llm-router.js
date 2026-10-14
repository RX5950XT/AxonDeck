'use strict'

// 沿用 Local SI 的 router：卸載／換模型由子程序處理，避開 Windows 原生 context.dispose 當機。
const { app } = require('electron')
const hfmodels = require('./hfmodels')
const { readResponseText } = require('./usage/shared')

function messagesOf(history, input) {
  const messages = history.map((item) => ({
    role: item.type === 'model' ? 'assistant' : item.type,
    content: item.type === 'model' ? item.response.join('') : item.text
  }))
  return [...messages, { role: 'user', content: input }]
}

async function complete(key, history, input, options) {
  const endpoint = hfmodels.endpoint()
  if (!endpoint) throw new Error('本地推論執行環境已停止')
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: key, messages: messagesOf(history, input), stream: false,
      temperature: options.temperature ?? 0, max_tokens: options.maxTokens,
      repeat_penalty: options.repeatPenalty === false ? 1 : options.repeatPenalty?.penalty ?? 1,
      repeat_last_n: options.repeatPenalty?.lastTokens,
      dry_multiplier: options.dryRepeatPenalty?.strength,
      dry_base: options.dryRepeatPenalty?.base,
      dry_allowed_length: options.dryRepeatPenalty?.allowedLength,
      stop: options.customStopTriggers,
      reasoning: { exclude: true }, chat_template_kwargs: { enable_thinking: false }
    })
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`本地翻譯失敗（HTTP ${response.status}）`)
  }
  const text = await readResponseText(response, 4 * 1024 * 1024)
  let data
  try { data = JSON.parse(text) } catch { throw new Error('本地翻譯回應格式錯誤') }
  const choice = data?.choices?.[0]
  if (typeof choice?.message?.content !== 'string') throw new Error('本地翻譯回應格式錯誤')
  // 模型偶發吐無效 UTF-8，llama-server 轉成 \udcXX；成對的不動，只換孤立替代字。
  let responseText = ''
  for (const unit of choice.message.content) {
    const point = unit.codePointAt(0)
    responseText += point >= 0xD800 && point <= 0xDFFF ? '�' : unit
  }
  return { responseText, stopReason: choice.finish_reason === 'length' ? 'maxTokens' : 'eogToken' }
}

async function createSession(key, store) {
  hfmodels.init({ userDataPath: app.getPath('userData'), store })
  await hfmodels.writePresets()
  await hfmodels.ensureRuntime()
  const rows = await hfmodels.refreshModels()
  if (!rows.some((row) => row.id === key)) {
    await hfmodels.applyPresets()
  }
  if (!await hfmodels.loadModel(key)) throw new Error('本地翻譯模型載入失敗')
  const device = await hfmodels.currentDevice()
  let history = []
  const promptWithMeta = (input, options = {}) => complete(key, history, input, options)
  return {
    usedGpu: !!device, backend: device ? hfmodels.runtimeReady().backend.toLowerCase() : 'cpu',
    session: {
      setChatHistory: (value) => { history = [...value] },
      promptWithMeta,
      prompt: async (input, options) => (await promptWithMeta(input, options)).responseText,
      dispose: () => hfmodels.unloadModel(key)
    }
  }
}

module.exports = { createSession }
