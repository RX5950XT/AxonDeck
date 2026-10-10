'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const { tempDir } = require('./lib/test-temp')
const protocol = require('../src/main/breeze-tts/protocol')
const root = tempDir('breeze-tts-')
const model = path.join(root, 'model.gguf'), binary = path.join(root, 'server.exe')
fs.writeFileSync(model, 'test'); fs.writeFileSync(binary, 'test')
const wav = Buffer.concat([protocol.wavHeader(48000, 24000), Buffer.alloc(48000)])
const input = path.join(root, 'input.wav'), output = path.join(root, 'saved.wav')
fs.writeFileSync(input, wav)
let selected = input, spawnCount = 0, killed = 0, bodyMode = 'normal', posted, healthBad = false
let asrTranscript = '自動辨識你好', asrThrows = false
const asrCalls = []
const events = []
const sourcePath = path.resolve('src/main/breeze-tts/index.js')
const realRequire = createRequire(sourcePath)
const box = vm.createContext({ module: { exports: {} }, Buffer, Blob, FormData, Response, AbortSignal, AbortController,
  setTimeout, clearTimeout, process: { platform: 'linux' },
  require(id) {
    if (id === 'electron') return { app: { getPath: () => root }, BrowserWindow: { getFocusedWindow: () => null },
      dialog: { showOpenDialog: async () => ({ canceled: !selected, filePaths: [selected] }),
        showSaveDialog: async () => ({ filePath: output }) } }
    if (id === '../models') return { filePath: (key) => key === 'breezetts2q8' ? model : binary,
      MODELS: { breezetts2q8: { totalBytes: 4 }, breezeruntime: { archive: true, check: ['server.exe'] } }, modelDir: () => root }
    if (id === '../gpu-capability') return { detectGpuCapability: async () => ({ ok: false }) }
    if (id === '../asr-select') return { transcribe: async (scope, req) => {
      asrCalls.push({ scope, sampleRate: req?.sampleRate,
        tag: Object.prototype.toString.call(req?.samples), length: req?.samples?.length })
      if (asrThrows) throw new Error('no asr model')
      return asrTranscript
    } }
    if (id === 'child_process') return { spawn(executable, args, options) {
      spawnCount++; assert.equal(executable, binary); assert(args.includes('--cpu')); assert(args.includes('-1'))
      assert.equal(options.windowsHide, true); assert.equal(options.shell, false)
      const child = new EventEmitter(); child.pid = 123; child.exitCode = null
      child.kill = () => { killed++; child.exitCode = 0; child.emit('exit', 0) }
      return child
    } }
    return realRequire(id)
  },
  async fetch(url, options = {}) {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//)
    assert.equal(options.redirect, 'error')
    if (url.endsWith('/health')) return Response.json({ status: 'ok', sample_rate: healthBad ? 123 : 24000 })
    if (url.includes('/v1/voices/') && options.method === 'DELETE') return Response.json({ deleted: 'speaker' })
    if (url.endsWith('/v1/voices')) {
      const name = options.body.get('name'), transcript = options.body.get('ref_text')
      fs.mkdirSync(path.join(root, 'breeze-tts', 'voices'), { recursive: true })
      fs.writeFileSync(path.join(root, 'breeze-tts', 'voices', `${name}.breeze`), voiceBytes(transcript))
      return Response.json({ id: name, seconds: 1 })
    }
    posted = options.body
    if (bodyMode === 'reject') return new Response('private-user-path secret-token', { status: 500 })
    if (bodyMode === 'waiting') return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    const chunks = bodyMode === 'odd' ? [Uint8Array.from([1])] : [Uint8Array.from([1]), Uint8Array.from([2, 3, 4])]
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    } }), { headers: { 'X-Sample-Rate': '24000', 'X-Sample-Format': 's16le' } })
  }, ReadableStream
})
vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), box, { filename: sourcePath })
const service = box.module.exports
service.init({ send: (channel, payload) => events.push({ channel, payload }) })

function voiceBytes(transcript = 'hello') {
  const words = Buffer.from(transcript), bytes = Buffer.alloc(24 + words.length + 16 * 4 * 10)
  bytes.write('BRZV'); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(24000, 8)
  bytes.writeUInt32LE(16, 12); bytes.writeUInt32LE(10, 16); bytes.writeUInt32LE(words.length, 20)
  words.copy(bytes, 24); return bytes
}

async function run() {
  const base = { reqId: 'one', mode: 'design', text: '你好', instruction: '溫暖自然的聲音' }
  assert.throws(() => protocol.validate({ ...base, instruction: '' }), /聲音描述/)
  for (const options of [null, {}, { ...base, mode: 'bad' }, { ...base, topP: NaN },
    { ...base, seed: 1.5 }, { ...base, keepAcoustic: 16 }, { ...base, maxNewTokens: -1 },
    { ...base, temperature: '1' }, { ...base, topK: Infinity }, { ...base, text: '\0' }]) {
    assert.throws(() => protocol.validate(options), (error) => error.code === 'INVALID_INPUT')
  }
  assert.throws(() => protocol.voiceId('../outside'), /聲音名稱/)
  assert.equal(protocol.validate({ ...base, temperature: 0 }).temperature, '0')
  assert.equal(protocol.wavInfo(wav).duration, 1)
  assert.throws(() => protocol.wavInfo(wav.subarray(0, 43)), /WAV/)
  assert.throws(() => protocol.wavInfo(wav.subarray(0, wav.length - 1)), /不完整/)
  assert.equal(protocol.savedVoice(voiceBytes(), 'speaker').refText, 'hello')
  assert.throws(() => protocol.savedVoice(Buffer.alloc(24), 'speaker'), /聲音資料/)
  assert.equal((await service.status()).installed, true)
  fs.writeFileSync(model, '')
  assert.equal((await service.status()).modelInstalled, false, '0-byte 模型不得顯示已安裝')
  fs.writeFileSync(model, 'bad')
  assert.equal((await service.status()).modelInstalled, false, '大小不符的模型不得顯示已安裝')
  fs.writeFileSync(model, 'test')
  fs.writeFileSync(binary, '')
  assert.equal((await service.status()).runtimeInstalled, false, '0-byte 執行環境不得顯示已安裝')
  fs.writeFileSync(binary, 'test')
  assert.equal((await service.voices()).length, 0)
  assert.equal(spawnCount, 0, '開頁查詢不得載入模型')
  let reference = await service.pickAudio({ kind: 'reference' })
  const source = await service.pickAudio({ kind: 'source' })
  assert.equal(reference.duration, 1); assert.equal(reference.name, 'input.wav')
  assert(!('path' in reference))
  assert.equal(reference.transcript, '自動辨識你好', '選參考音自動帶入逐字稿')
  assert.equal(source.transcript, '', '變聲原錄音不辨識')
  assert.equal(asrCalls.length, 1); assert.equal(asrCalls[0].scope, 'file')
  assert.equal(asrCalls[0].sampleRate, 16000); assert.equal(asrCalls[0].tag, '[object Float32Array]')
  assert.equal(asrCalls[0].length, 16000, '24k 1 秒轉成 16k 16000 點')
  asrThrows = true
  assert.equal((await service.pickAudio({ kind: 'reference' })).transcript, '', '辨識失敗退回手動填寫')
  asrThrows = false
  asrTranscript = '欢迎使用文字转语音'
  reference = await service.pickAudio({ kind: 'reference' })
  assert.equal(reference.transcript, '歡迎使用文字轉語音', '簡體逐字稿自動轉台灣繁體')
  const mono16 = protocol.wavToMono16k(wav)
  assert.equal(mono16.length, 16000)
  assert.throws(() => protocol.wavToMono16k(wav.subarray(0, 43)), /WAV/)
  assert.throws(() => protocol.validate({ ...base, mode: 'clone', refAudioId: reference.audioId, refText: '' }), /自動辨識/)
  const result = await service.generate(base)
  assert.equal(spawnCount, 1)
  assert.equal(protocol.wavInfo(Buffer.from(result.audioBase64, 'base64')).duration, 4 / 48000)
  assert.equal(events.filter((item) => item.channel === 'breeze:chunk')[0].payload.pcmBase64, Buffer.from([1, 2, 3, 4]).toString('base64'))
  await service.saveAudio({ resultId: result.resultId })
  assert.equal(fs.readFileSync(output).length, result.bytes)
  await assert.rejects(service.generate({ ...base, mode: 'clone', refAudioId: '../../input.wav', refText: 'hello' }), /錄音已失效/)
  await service.generate({ ...base, mode: 'clone', refAudioId: reference.audioId, refText: 'hello' })
  assert.equal(posted.get('instruction'), null); assert(posted.get('ref_audio') instanceof Blob)
  await service.generate({ ...base, mode: 'direction', refAudioId: reference.audioId, refText: 'hello' })
  assert.equal(posted.get('instruction'), base.instruction)
  await service.generate({ ...base, mode: 'convert', sourceAudioId: source.audioId, refAudioId: reference.audioId,
    refText: 'hello', temperature: 0.3, topK: 1, keepAcoustic: 2 })
  assert(posted.get('source') instanceof Blob); assert.equal(posted.get('keep_acoustic'), '2')
  const saved = await service.saveVoice({ name: 'speaker', refAudioId: reference.audioId, refText: 'hello' })
  assert.equal(saved.id, 'speaker'); assert.equal((await service.voices())[0].saved, true)
  fs.writeFileSync(path.join(root, 'breeze-tts', 'voices', 'corrupt.breeze'), 'broken')
  assert.equal((await service.voices()).find((voice) => voice.id === 'corrupt').invalid, true, '壞聲音可列出供刪除')
  await service.removeVoice({ id: 'corrupt' })
  await assert.rejects(service.saveVoice({ name: 'speaker', refAudioId: reference.audioId, refText: 'hello' }), /已存在/)
  await service.generate({ ...base, mode: 'clone', voiceId: 'speaker' })
  assert.equal(posted.get('voice_id'), 'speaker'); assert.equal(posted.get('ref_audio'), null)
  await service.removeVoice({ id: 'speaker' }); assert.equal((await service.voices()).length, 0)
  bodyMode = 'reject'
  await assert.rejects(service.generate(base), (error) => error.userMessage && !error.userMessage.includes('secret-token'))
  bodyMode = 'odd'; await assert.rejects(service.generate(base), /不完整/)
  bodyMode = 'waiting'
  const pending = service.generate(base)
  while (!(await service.status()).ready) await new Promise((resolve) => setTimeout(resolve, 1))
  await assert.rejects(service.generate(base), /正在生成/)
  assert.equal((await service.cancel({ reqId: 'other' })).canceled, false)
  const rejection = assert.rejects(pending, /已停止/)
  await service.cancel({ reqId: 'one' }); await rejection
  assert.equal(killed, 1)
  bodyMode = 'normal'; healthBad = true
  await assert.rejects(service.generate(base), /版本不符/)
  assert.equal(killed, 2)
  healthBad = false
  await service.generate(base); await service.shutdown()
  assert.equal(killed, 3); assert.equal((await service.status()).ready, false)
  selected = null; assert.equal((await service.pickAudio({ kind: 'reference' })).canceled, true)
  console.log('PASS Breeze 四模式、參數/WAV/token守衛、stream odd bytes、聲音保存/永久刪除、lazy load、取消/重啟/清理')
}
run().catch(async (error) => { console.error(error); await service.shutdown(); process.exitCode = 1 })
