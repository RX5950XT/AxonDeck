'use strict'

/**
 * Grok 反代測試：假上游＋真的本機 HTTP 服務（跟 Antigravity 共用的那一個，`grok-*` 才轉到 Grok），
 * 走過三種協議、分流與錯誤收斂（不需 electron、不打真上游；Antigravity 那邊注入成沒登入）
 *   node scripts/test-grok-proxy.js
 */

const assert = require('assert')
const http = require('http')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..', 'src', 'main', 'grokproxy')
const grokServer = require(path.join(ROOT, 'server'))
const server = require(path.join(ROOT, '..', 'agy', 'server'))
const catalog = require(path.join(ROOT, 'catalog'))
const logs = require(path.join(ROOT, 'logs'))
const openai = require(path.join(ROOT, 'openai'))

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL  ${name}\n        ${error.stack || error.message}`)
  }
}

const MODELS = {
  object: 'list',
  data: [
    { id: 'grok-4.7', name: 'Grok 4.7', context_window: 256000, api_backend: 'responses', reasoning_efforts: [{ id: 'xhigh' }, { id: 'high', default: true }, { id: 'medium' }, { id: 'low' }] },
    { id: 'grok-4.5', name: 'Grok 4.5', context_window: 256000, api_backend: 'responses', reasoning_efforts: [{ id: 'high' }, { id: 'low' }] }
  ]
}

/** 上游一次回應的 SSE：一段文字＋用量；toolCall 時多一個 function_call */
function sseFor(body) {
  const events = [{ type: 'response.created', response: { id: 'resp_1' } }]
  if (body.tools?.length) {
    events.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: body.tools[0].name } })
    events.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":"台北"}' })
    events.push({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: body.tools[0].name, arguments: '{"city":"台北"}' } })
  } else {
    events.push({ type: 'response.output_text.delta', delta: 'O' })
    events.push({ type: 'response.output_text.delta', delta: 'K' })
  }
  events.push({
    type: 'response.completed',
    response: { id: 'resp_1', object: 'response', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } }
  })
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const seen = []
let nextStatus = 0

function startMock() {
  return new Promise((resolve) => {
    const mock = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null })
        if (nextStatus) {
          res.writeHead(nextStatus, { 'Content-Type': 'application/json' })
          res.end('{"error":"secret upstream text"}')
          return
        }
        if (req.url === '/models') return void res.end(JSON.stringify(MODELS))
        if (req.url.startsWith('/billing')) return void res.end(JSON.stringify({ config: { creditUsagePercent: 42, currentPeriod: { end: '2026-11-20T03:33:28Z' } } }))
        if (req.url === '/responses') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(sseFor(JSON.parse(raw)))
          return
        }
        res.writeHead(404)
        res.end()
      })
    })
    mock.listen(0, '127.0.0.1', () => resolve(mock))
  })
}

const API_KEY = 'grok-test-key'

async function call(port, pathname, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) }
}

function dataFrames(sse) {
  return sse.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6))
    .filter((raw) => raw !== '[DONE]').map((raw) => JSON.parse(raw))
}

async function main() {
  console.log('Grok 反代')

  await test('Chat 請求轉 Responses：system→instructions、工具、強度', () => {
    const request = openai.toResponsesRequest({
      messages: [
        { role: 'system', content: '你是助理' },
        { role: 'user', content: [{ type: 'text', text: '天氣？' }, { type: 'image_url', image_url: { url: 'http://evil/x.png' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '晴' }
      ],
      tools: [{ type: 'function', function: { name: 'w', parameters: { type: 'object', $schema: 'x' } } }],
      max_tokens: 50,
      reasoning_effort: 'high'
    }, 'grok-4.7', 'low')
    assert.strictEqual(request.instructions, '你是助理')
    assert.deepStrictEqual(request.input[0].content, [{ type: 'input_text', text: '天氣？' }], 'http 圖片不送')
    assert.strictEqual(request.input[1].type, 'function_call')
    assert.strictEqual(request.input[2].type, 'function_call_output')
    assert.deepStrictEqual(request.tools[0].parameters, { type: 'object' })
    assert.strictEqual(request.max_output_tokens, 50)
    assert.deepStrictEqual(request.reasoning, { effort: 'low' }, '模型名的強度優先')
  })

  await test('模型名解析：本體、強度別名、未知 grok、非 grok 換預設', () => {
    const models = catalog.parseModels(MODELS)
    assert.deepStrictEqual(catalog.resolveModel('grok-4.7', models), { model: 'grok-4.7', mapped: 'grok-4.7', effort: '' })
    assert.deepStrictEqual(catalog.resolveModel('grok-4.5-low', models), { model: 'grok-4.5-low', mapped: 'grok-4.5', effort: 'low' })
    assert.strictEqual(catalog.resolveModel('grok-5', models).mapped, 'grok-5')
    assert.strictEqual(catalog.resolveModel('claude-opus-4-5[1m]', models).mapped, 'grok-4.7')
    assert.deepStrictEqual(models[1].efforts, ['high', 'low'])
  })

  const mock = await startMock()
  const dir = tempDir('grok-proxy-test-')
  logs.init({ userDataPath: dir })
  const fakeCredential = { acquire: async () => ({ token: 'tok', accountId: '' }), invalidate: () => {} }
  grokServer.configureUpstream({ baseUrl: `http://127.0.0.1:${mock.address().port}`, credential: fakeCredential })
  // Antigravity 沒登入：讀不到憑證，連上游都不會打
  server.configureUpstream({ baseUrl: 'http://127.0.0.1:9/v1internal', readCredential: async () => '' })
  catalog.reset()
  const started = await server.start({ port: 0, apiKey: API_KEY, logBodies: false })
  assert.ok(started.ok)
  const port = server.status().port

  try {
    await test('沒帶金鑰 401、/health 免金鑰', async () => {
      const bad = await call(port, '/v1/models', null, { Authorization: 'Bearer nope' })
      assert.strictEqual(bad.status, 401)
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      assert.strictEqual(health.status, 200)
    })

    await test('/v1/models 列出本體與強度別名、Antigravity 沒登入就不列，上游帶版本標頭', async () => {
      const result = await call(port, '/v1/models')
      const ids = result.json().data.map((row) => row.id)
      assert.ok(ids.includes('grok-4.7') && ids.includes('grok-4.7-xhigh') && ids.includes('grok-4.5-low'))
      assert.ok(ids.every((id) => id.startsWith('grok-')), ids.join())
      const upstreamCall = seen.find((row) => row.url === '/models')
      assert.strictEqual(upstreamCall.headers['x-grok-client-version'], '1.0.13')
      assert.strictEqual(upstreamCall.headers.authorization, 'Bearer tok')
    })

    await test('Chat 非串流：回 chat.completion 與用量', async () => {
      const result = await call(port, '/v1/chat/completions', { model: 'grok-4.7-low', messages: [{ role: 'user', content: 'hi' }] })
      assert.strictEqual(result.status, 200)
      const json = result.json()
      assert.strictEqual(json.choices[0].message.content, 'OK')
      assert.strictEqual(json.model, 'grok-4.7-low')
      assert.strictEqual(json.usage.prompt_tokens, 12)
      const sent = seen.filter((row) => row.url === '/responses').at(-1).body
      assert.strictEqual(sent.model, 'grok-4.7')
      assert.strictEqual(sent.stream, true)
      assert.deepStrictEqual(sent.reasoning, { effort: 'low' })
    })

    await test('Chat 串流＋工具呼叫：tool_calls、finish_reason、usage、[DONE]', async () => {
      const result = await call(port, '/v1/chat/completions', {
        model: 'grok-4.7', stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'user', content: '台北天氣' }],
        tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
      })
      const frames = dataFrames(result.text)
      assert.ok(result.text.trim().endsWith('data: [DONE]'))
      const call0 = frames.find((frame) => frame.choices?.[0]?.delta?.tool_calls)
      assert.strictEqual(call0.choices[0].delta.tool_calls[0].function.arguments, '{"city":"台北"}')
      assert.strictEqual(frames.find((frame) => frame.choices?.[0]?.finish_reason).choices[0].finish_reason, 'tool_calls')
      assert.strictEqual(frames.at(-1).usage.completion_tokens, 3)
    })

    await test('Anthropic 串流：message_start…message_stop', async () => {
      const result = await call(port, '/v1/messages', { model: 'grok-4.7', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
      assert.strictEqual(result.status, 200)
      assert.ok(result.text.includes('event: message_start') && result.text.includes('event: message_stop'))
      assert.ok(result.text.includes('"text":"O"'))
      assert.strictEqual(seen.filter((row) => row.url === '/responses').at(-1).body.model, 'grok-4.7')
    })

    await test('非 grok 模型分給 Antigravity：沒登入回 503，不打 Grok 上游', async () => {
      const before = seen.filter((row) => row.url === '/responses').length
      const result = await call(port, '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
      assert.strictEqual(result.status, 503, result.text)
      assert.strictEqual(seen.filter((row) => row.url === '/responses').length, before)
    })

    await test('Responses 非串流：回 completed 的 response 物件；串流原樣轉送', async () => {
      const once = await call(port, '/v1/responses', { model: 'grok-4.5-high', input: 'hi' })
      assert.strictEqual(once.json().status, 'completed')
      assert.deepStrictEqual(seen.filter((row) => row.url === '/responses').at(-1).body.reasoning, { effort: 'high' })
      const streamed = await call(port, '/v1/responses', { model: 'grok-4.7', input: 'hi', stream: true })
      assert.ok(streamed.text.includes('event: response.output_text.delta'))
      assert.ok(streamed.text.includes('event: response.completed'))
    })

    await test('count_tokens 粗估', async () => {
      const result = await call(port, '/v1/messages/count_tokens', { model: 'grok-4.7', messages: [{ role: 'user', content: 'x'.repeat(400) }] })
      assert.ok(result.json().input_tokens >= 100)
    })

    await test('上游 402 收斂成 502＋額度用完訊息，不透傳上游 body', async () => {
      nextStatus = 402
      try {
        const chat = await call(port, '/v1/chat/completions', { model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] })
        assert.strictEqual(chat.status, 502)
        assert.strictEqual(chat.json().error.code, 'QUOTA_EXHAUSTED')
        assert.ok(!chat.text.includes('secret upstream text'))
        const anth = await call(port, '/v1/messages', { model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] })
        assert.strictEqual(anth.json().type, 'error')
        nextStatus = 429
        const limited = await call(port, '/v1/chat/completions', { model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] })
        assert.strictEqual(limited.status, 429)
      } finally {
        nextStatus = 0
      }
    })

    await test('日誌：每個請求一列、記用量與對映模型', () => {
      const { logs: rows } = logs.list({ limit: 50 })
      const ok = rows.find((row) => row.model === 'grok-4.7-low')
      assert.strictEqual(ok.mappedModel, 'grok-4.7 · low')
      assert.strictEqual(ok.inputTokens, 12)
      assert.ok(rows.some((row) => row.protocol === 'responses'))
      assert.ok(rows.some((row) => row.errorCode === 'QUOTA_EXHAUSTED'))
      const stats = logs.stats({ range: '24h' })
      assert.ok(stats.summary.requests >= 8)
    })

    await test('型錄附帶每週額度', async () => {
      const result = await catalog.list({ force: true, options: grokServer.getUpstreamOptions() })
      assert.deepStrictEqual(result.quota, { usedPercent: 42, resetAt: '2026-11-20T03:33:28Z' })
      assert.strictEqual(result.models.length, 2)
    })
  } finally {
    await server.stop()
    mock.close()
    logs.close()
    removeTree(dir)
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
