#!/usr/bin/env node
/**
 * AxonDeck — Claude Code 轉換閘道的端到端回歸（node 直跑，自己開一個假上游）
 *
 * 驗的是整條路：Anthropic 請求 → 轉成 OpenAI 形狀送上游 → 上游 SSE → 轉回 Anthropic SSE。
 * 外加那幾條不能鬆的防護：只收本機 Host、強制金鑰、上游狀態碼不透傳、上游 body 不外洩。
 *
 * **不會打到真的 ChatGPT／xAI／Ollama**：上游是這支自己開的 mock。
 */

'use strict'

const http = require('http')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const server = require(path.join(ROOT, 'src/main/ccswitch/gateway/server.js'))
const modelsScan = require(path.join(ROOT, 'src/main/ccswitch/models-scan.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 假上游的下一次行為 */
let upstreamMode = 'ok'
/** 收到的請求（給斷言看轉換結果） */
let lastUpstream = null
let upstreamCalls = 0
/** 假的憑證模組記到的呼叫 */
const credentialCalls = []

const FAKE_UPSTREAM_SECRET = 'sk-upstream-should-never-leak'

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 假上游：Responses 協議。
 */
function startUpstream() {
  return new Promise((resolve) => {
    const instance = http.createServer((req, res) => {
      upstreamCalls++
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          lastUpstream = { path: req.url, headers: req.headers, body: JSON.parse(body || '{}') }
        } catch {
          lastUpstream = { path: req.url, headers: req.headers, body: null }
        }

        if (req.url === '/opencode-go' && (!req.headers['user-agent']?.startsWith('AxonDeck-CCSwitch/') ||
          req.headers['x-opencode-session'] !== 'claude-session-123456')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: FAKE_UPSTREAM_SECRET } }))
          return
        }

        if (upstreamMode === 'unauthorized-once' && upstreamCalls === 1) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: FAKE_UPSTREAM_SECRET } }))
          return
        }
        if (upstreamMode === 'server-error') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: FAKE_UPSTREAM_SECRET } }))
          return
        }
        const transientStatus = Number(upstreamMode.split('-')[1])
        if (upstreamMode.startsWith('transient-') &&
          (upstreamCalls === 1 || upstreamMode.endsWith('-always'))) {
          res.writeHead(transientStatus, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: FAKE_UPSTREAM_SECRET } }))
          return
        }
        if (upstreamMode === 'rate-limited') {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '42' })
          res.end(JSON.stringify({ error: { message: FAKE_UPSTREAM_SECRET } }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (upstreamMode === 'failed-terminal') {
          res.end(sseFrame({ type: 'response.completed', response: {
            status: 'failed', error: { message: FAKE_UPSTREAM_SECRET }
          } }))
          return
        }
        if (upstreamMode === 'empty-stream') { res.end(); return }
        if (req.url === '/commandcode') {
          res.write(sseFrame({ choices: [{ delta: { content: '你好' } }] }))
          if (upstreamMode !== 'truncated-stream') {
            res.write(sseFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
          }
          res.end()
          return
        }
        res.write(sseFrame({ type: 'response.output_text.delta', delta: '你好' }))
        if (upstreamMode === 'truncated-stream') { res.end(); return }
        res.write(sseFrame({ type: 'response.output_text.delta', delta: '，世界' }))
        res.write(sseFrame({
          type: 'response.completed',
          response: { usage: { input_tokens: 11, output_tokens: 7 } }
        }))
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    instance.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

/**
 * @param {number} port
 * @param {string} routePath
 * @param {object} body
 * @param {{ key?: string, host?: string, method?: string }} [options]
 */
function request(port, routePath, body, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? '' : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: routePath,
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(options.key === null ? {} : { 'x-api-key': options.key ?? 'gateway-key' }),
        ...(options.host ? { Host: options.host } : {})
      }
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function main() {
  const upstream = await startUpstream()
  const upstreamPort = upstream.address().port

  server.configure({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    credential: {
      acquire: async (provider, opts) => {
        credentialCalls.push({ provider, force: Boolean(opts?.force) })
        return { token: 'fake-token', accountId: 'acct_1' }
      },
      invalidate: (provider) => credentialCalls.push({ provider, invalidated: true })
    }
  })

  const { port } = await server.start({
    port: 0,
    apiKey: 'gateway-key',
    getProviderKey: async (key) => (
      { 'ollama-cloud': 'ollama-key', 'opencode-go': 'opencode-key', commandcode: 'command-key', p_custom1: 'custom-key' }[key] || ''
    ),
    // 自訂供應商不在 ROUTES 固定表裡，位址由 main 從 store 查回來（這裡模擬那一步）
    resolveRoute: async (key) => (key === 'p_custom1'
      ? { wire: 'responses', auth: 'key', url: `http://127.0.0.1:${upstreamPort}/custom` }
      : null)
  })

  const anthropicBody = {
    model: 'gpt-5.6-sol',
    max_tokens: 256,
    messages: [{ role: 'user', content: '嗨' }]
  }

  try {
    console.log('\n[A] 防護')
    const health = await request(port, '/health', null, { key: null, method: 'GET' })
    ok('/health 不需鑑權', health.status === 200 && JSON.parse(health.text).ok === true)

    const noKey = await request(port, '/codex/v1/messages', anthropicBody, { key: null })
    ok('沒帶金鑰回 401', noKey.status === 401, String(noKey.status))
    ok('401 是 Anthropic 的錯誤形狀', JSON.parse(noKey.text).type === 'error')

    const wrongKey = await request(port, '/codex/v1/messages', anthropicBody, { key: 'nope' })
    ok('金鑰不對回 401', wrongKey.status === 401)

    const badHost = await request(port, '/codex/v1/messages', anthropicBody, { host: 'evil.example.com' })
    ok('非本機 Host 擋掉（DNS rebinding）', badHost.status === 400, String(badHost.status))

    const unknown = await request(port, '/nope/v1/messages', anthropicBody)
    ok('未知路由回 404', unknown.status === 404)

    // 自訂供應商的路由段是 provider id（帶底線），查不到就是 404——
    // 路徑不是「想打哪就打哪」的入口，位址一律由 main 從 store 給
    const unknownCustom = await request(port, '/p_nosuch/v1/messages', anthropicBody)
    ok('查不到的自訂 provider id 回 404', unknownCustom.status === 404, String(unknownCustom.status))

    const wrongMethod = await request(port, '/codex/v1/messages', null, { method: 'GET' })
    ok('非 POST 回 405', wrongMethod.status === 405)

    const badJson = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/codex/v1/messages', method: 'POST',
        headers: { 'x-api-key': 'gateway-key', 'Content-Type': 'application/json' }
      }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.end('{ not json')
    })
    ok('壞 JSON 回 400', badJson.status === 400)

    console.log('\n[B] 串流轉換')
    upstreamMode = 'ok'
    upstreamCalls = 0
    const streamed = await request(port, '/codex/v1/messages', anthropicBody)
    ok('串流請求回 200', streamed.status === 200, String(streamed.status))
    ok('回的是 SSE', String(streamed.headers['content-type']).includes('text/event-stream'))
    ok('有 message_start', streamed.text.includes('event: message_start'))
    ok('有 message_stop', streamed.text.includes('event: message_stop'))
    ok('文字有轉過來', streamed.text.includes('你好'))
    const starts = (streamed.text.match(/event: content_block_start/g) || []).length
    const stops = (streamed.text.match(/event: content_block_stop/g) || []).length
    ok('區塊開關數量相等', starts === stops, `${starts} vs ${stops}`)

    ok('上游收到 Responses 形狀', Array.isArray(lastUpstream.body.input))
    ok('上游收到我們給的 token', lastUpstream.headers.authorization === 'Bearer fake-token')
    ok('Codex 有帶 account id 標頭', lastUpstream.headers['chatgpt-account-id'] === 'acct_1')
    // ChatGPT Codex 後端跟公版 Responses 不一樣（實測見 scripts/probe-ccswitch-codex.js）：
    // 少了 store:false 或多了 max_output_tokens／temperature 一律 400，經閘道之後只剩一句 502
    ok('Codex 有明寫 store:false', lastUpstream.body.store === false, JSON.stringify(lastUpstream.body.store))
    ok('Codex 不送 max_output_tokens', lastUpstream.body.max_output_tokens === undefined)
    ok('Codex 不送 temperature', lastUpstream.body.temperature === undefined)
    const codexProbe = modelsScan.probeBody('openai_responses', 'gpt-5.6-luna', true)
    ok('Codex 最小測試也用 input 陣列', Array.isArray(codexProbe.input))
    ok('Codex 最小測試必須串流，不能套公版非串流請求', codexProbe.stream === true)
    ok('Codex 最小測試仍保留後端限制', codexProbe.store === false &&
      !('max_output_tokens' in codexProbe) && !('temperature' in codexProbe))

    // Claude Code 宣告 1M 時模型名尾巴會帶 [1m]，上游不認得（400 model is not supported）
    const oneM = await request(port, '/codex/v1/messages', { ...anthropicBody, model: 'gpt-5.6-sol[1m]' })
    ok('宣告 1M 的請求照樣成功', oneM.status === 200, String(oneM.status))
    ok('送上游的模型名剝掉了 [1m]', lastUpstream.body.model === 'gpt-5.6-sol', String(lastUpstream.body.model))

    console.log('\n[C] 非串流')
    const nonStream = await request(port, '/codex/v1/messages', { ...anthropicBody, stream: false })
    const parsed = JSON.parse(nonStream.text)
    ok('非串流回 JSON', nonStream.status === 200 && parsed.type === 'message')
    ok('內容拼完整', parsed.content[0].text === '你好，世界')
    ok('usage 帶回來', parsed.usage.input_tokens === 11 && parsed.usage.output_tokens === 7)

    console.log('\n[D] 金鑰型路由（Ollama Cloud）')
    upstreamCalls = 0
    await request(port, '/ollama-cloud/v1/messages', { ...anthropicBody, stream: false })
    ok('Ollama 用使用者填的金鑰', lastUpstream.headers.authorization === 'Bearer ollama-key')
    ok('Ollama 收到 Responses 形狀', typeof lastUpstream.body.input === 'string' || Array.isArray(lastUpstream.body.input))

    console.log('\n[D1] OpenCode Go 對話識別')
    const go = await request(port, '/opencode-go/v1/messages', { ...anthropicBody, stream: false,
      metadata: { user_id: JSON.stringify({ device_id: 'not-forwarded', account_uuid: '', session_id: 'claude-session-123456' }) } })
    ok('OpenCode Go 收到客戶端名稱與對話識別，避免上游 400', go.status === 200, String(go.status))
    ok('OpenCode Go 沿用 Claude 的對話識別', lastUpstream.headers['x-opencode-session'] === 'claude-session-123456')
    ok('不轉送使用者與裝置識別', !JSON.stringify(lastUpstream).includes('not-forwarded'))
    let probeHeaders
    await modelsScan.testProvider({ presetId: 'opencode-go', apiKey: 'test-go-key',
      apiFormat: 'openai_responses', model: 'gpt-5.6-luna' }, { fetchImpl: async (_url, options) => {
      probeHeaders = options.headers
      return { ok: true, status: 200, body: { cancel: async () => {} } }
    } })
    ok('OpenCode OpenAI 測試送 Bearer，而非 Claude 專用 x-api-key',
      probeHeaders.Authorization === 'Bearer test-go-key' && !probeHeaders['x-api-key'])
    ok('最小測試也帶客戶端與對話識別', probeHeaders['User-Agent']?.startsWith('AxonDeck-CCSwitch/') &&
      /^[A-Za-z0-9_-]{6,128}$/.test(probeHeaders['x-opencode-session']))

    console.log('\n[D2] 自訂供應商（動態路由）')
    upstreamCalls = 0
    const custom = await request(port, '/p_custom1/v1/messages', { ...anthropicBody, stream: false })
    ok('自訂路由接得起來', custom.status === 200, String(custom.status))
    // 金鑰按 provider id 取：自訂是一筆一個端點，拿「這家的第一筆」會拿到別人的
    ok('用的是這一筆自己的金鑰', lastUpstream.headers.authorization === 'Bearer custom-key',
      String(lastUpstream.headers.authorization))
    ok('轉換照樣有做', JSON.parse(custom.text).content?.[0]?.text?.includes('你好'), custom.text.slice(0, 120))

    console.log('\n[E] 上游錯誤不外洩、狀態碼不透傳')
    upstreamMode = 'server-error'
    upstreamCalls = 0
    const failedCall = await request(port, '/codex/v1/messages', { ...anthropicBody, stream: false })
    ok('上游 500 收斂成 502', failedCall.status === 502, String(failedCall.status))
    ok('上游 body 沒有外洩', !failedCall.text.includes(FAKE_UPSTREAM_SECRET), failedCall.text.slice(0, 120))

    upstreamMode = 'rate-limited'
    upstreamCalls = 0
    const limited = await request(port, '/codex/v1/messages', { ...anthropicBody, stream: false })
    ok('429 原樣回', limited.status === 429)
    ok('429 帶 retry-after', limited.headers['retry-after'] === '42')
    ok('429 也不外洩上游 body', !limited.text.includes(FAKE_UPSTREAM_SECRET))
    ok('429 不自動重試', upstreamCalls === 1)

    console.log('\n[F] 暫時性錯誤只重試一次，且不更換憑證')
    for (const status of [502, 503, 504]) {
      for (const route of ['codex', 'ollama-cloud']) {
        upstreamMode = `transient-${status}`
        upstreamCalls = 0
        credentialCalls.length = 0
        const recovered = await request(port, `/${route}/v1/messages`, { ...anthropicBody, stream: false })
        ok(`${route} ${status} 重試後成功`, recovered.status === 200 && upstreamCalls === 2)
        ok(`${route} ${status} 不強制續期登入`, !credentialCalls.some(call => call.force || call.invalidated))
      }
    }
    upstreamMode = 'transient-503-always'
    upstreamCalls = 0
    const exhausted = await request(port, '/codex/v1/messages', { ...anthropicBody, stream: false })
    ok('持續 503 最多兩次且回安全 502', upstreamCalls === 2 && exhausted.status === 502 &&
      !exhausted.text.includes(FAKE_UPSTREAM_SECRET))

    console.log('\n[G] 不完整串流不能回成功')
    for (const mode of ['empty-stream', 'truncated-stream', 'failed-terminal']) {
      upstreamMode = mode
      upstreamCalls = 0
      const json = await request(port, '/codex/v1/messages', { ...anthropicBody, stream: false })
      ok(`${mode} 非串流回 502，不假裝成功`, json.status === 502)
      const sse = await request(port, '/codex/v1/messages', anthropicBody)
      ok(`${mode} 串流回錯誤且不送 message_stop`, sse.text.includes('event: error') &&
        !sse.text.includes('event: message_stop'))
      ok(`${mode} 不外洩上游錯誤`, !json.text.includes(FAKE_UPSTREAM_SECRET) &&
        !sse.text.includes(FAKE_UPSTREAM_SECRET))
      ok(`${mode} 不重播已開始的回應`, upstreamCalls === 2)
    }
    for (const stream of [true, false]) {
      upstreamMode = 'ok'
      const chat = await request(port, '/commandcode/v1/messages', { ...anthropicBody, stream })
      ok(`Chat stream=${stream} 正常完成`, chat.status === 200 && (stream
        ? chat.text.includes('event: message_stop') : JSON.parse(chat.text).content[0].text === '你好'))
      upstreamMode = 'truncated-stream'
      const chatCut = await request(port, '/commandcode/v1/messages', { ...anthropicBody, stream })
      ok(`Chat stream=${stream} 偵測截斷`, stream
        ? chatCut.text.includes('event: error') && !chatCut.text.includes('event: message_stop') : chatCut.status === 502)
    }
    console.log('\n[H] 上游 401 會換 token 重試一次')
    upstreamMode = 'unauthorized-once'
    upstreamCalls = 0
    credentialCalls.length = 0
    const retried = await request(port, '/codex/v1/messages', { ...anthropicBody, stream: false })
    ok('重試之後成功', retried.status === 200, String(retried.status))
    ok('上游被打了兩次', upstreamCalls === 2, String(upstreamCalls))
    ok('中間有作廢舊 token', credentialCalls.some((call) => call.invalidated))
    ok('第二次是強制換 token', credentialCalls.some((call) => call.force === true))
  } catch (error) {
    failed++
    console.log(`  FAIL 例外 — ${error.stack || error}`)
  } finally {
    await server.stop()
    await new Promise((resolve) => upstream.close(resolve))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
