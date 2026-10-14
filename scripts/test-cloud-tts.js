'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const service = require('../src/main/cloud-tts')
const { registerCloudTtsIpc } = require('../src/main/cloud-tts/ipc')

async function main() {
  let mode = 'ok'
  let received = null
  let onRequest = null
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = { path: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) }
    onRequest?.()
    if (mode === 'wait') return
    if (mode === 'error') { response.writeHead(401); response.end('secret-key-private-body'); return }
    if (mode === 'redirect') { response.writeHead(302, { Location: 'http://localhost:1/secrets' }); response.end(); return }
    if (mode === 'large') { response.writeHead(200, { 'Content-Length': String(25 * 1024 * 1024) }); response.flushHeaders(); return }
    response.end(mode === 'bad' ? '{"secret":"private"}' : Buffer.from('ID3test-audio'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const providers = [{ id: 'p1', name: '測試', apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-key',
    models: [{ id: 'tts-test', type: 'tts' }, { id: 'chat-test', type: 'chat' }] }]
  service.setStore({ get: () => providers })
  const request = { providerId: 'p1', modelId: 'tts-test', requestId: 'request-123', text: '你好', voice: 'alloy', speed: 1 }
  const handlers = new Map()
  registerCloudTtsIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, service, isMainSender: (event) => event.main })
  try {
    assert.deepEqual(service.status(), { models: [{ providerId: 'p1', providerName: '測試', modelId: 'tts-test' }], busy: false })
    assert.equal((await handlers.get('cloudTts:status')({ main: false })).error.code, 'FORBIDDEN')
    await assert.rejects(service.generate({ ...request, modelId: 'chat-test' }), { code: 'MODEL' })
    await assert.rejects(service.generate({ ...request, text: 'a'.repeat(4097) }), { code: 'INPUT' })
    await assert.rejects(service.generate({ ...request, speed: NaN }), { code: 'INPUT' })
    const audio = await service.generate(request)
    assert.equal(received.path, '/v1/audio/speech')
    assert.equal(received.auth, 'Bearer test-key')
    assert.deepEqual(received.body, { model: 'tts-test', input: '你好', voice: 'alloy', speed: 1, response_format: 'mp3' })
    assert.equal(audio.audioBase64, Buffer.from('ID3test-audio').toString('base64'))
    assert.equal(audio.mimeType, 'audio/mpeg')
    await assert.rejects(service.saveAudio({ resultId: 'other-result' }), { code: 'RESULT' })
    mode = 'error'
    const failure = await handlers.get('cloudTts:generate')({ main: true }, request)
    assert.equal(failure.error.code, 'UPSTREAM')
    assert.doesNotMatch(JSON.stringify(failure), /secret|test-key|private/)
    mode = 'bad'
    await assert.rejects(service.generate(request), { code: 'FORMAT' })
    mode = 'redirect'
    await assert.rejects(service.generate(request), { code: 'NETWORK' })
    mode = 'large'
    await assert.rejects(service.generate(request), { code: 'SIZE' })
    mode = 'wait'
    const started = new Promise((resolve) => { onRequest = resolve })
    const pending = service.generate(request)
    const canceled = assert.rejects(pending, { code: 'CANCELED' })
    await started
    await assert.rejects(service.generate({ ...request, requestId: 'second-request' }), { code: 'BUSY' })
    assert.equal(service.cancel({ requestId: 'wrong-request' }).canceled, false)
    assert.equal(service.status().busy, true)
    assert.equal(service.cancel({ requestId: request.requestId }).canceled, true)
    await canceled
    assert.equal(service.status().busy, false)
    console.log('PASS cloud TTS: routing, validation, safe errors, audio bounds, redirects, cancellation and IPC guard')
  } finally {
    service.shutdown()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
