// npx electron scripts/probe-breeze-tts.js
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { app } = require('electron')
const { tempDir } = require('./lib/test-temp')
const { wavInfo } = require('../src/main/breeze-tts/protocol')
const root = tempDir('breeze-real-')
app.setPath('userData', root)
const cache = process.env.BREEZE_QA_CACHE || 'D:\\axondeck-breeze-qa-cache'
const outputDir = path.join(cache, `outputs-${Date.now()}`)
let selected = '', output = '', chunkCount = 0
const sourcePath = path.resolve(__dirname, '../src/main/breeze-tts/index.js')
const backendRequire = createRequire(sourcePath)
const box = vm.createContext({ module: { exports: {} }, Buffer, Blob, FormData, AbortSignal, AbortController,
  fetch, setTimeout, clearTimeout, process, require(id) {
    if (id === 'electron') return { app, BrowserWindow: { getFocusedWindow: () => null }, dialog: {
      showOpenDialog: async () => ({ filePaths: [selected] }), showSaveDialog: async () => ({ filePath: output })
    } }
    return backendRequire(id)
  } })
vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), box, { filename: sourcePath })
const service = box.module.exports
service.init({ send(channel, payload) {
  if (channel === 'breeze:chunk') chunkCount++
  if (channel === 'breeze:progress' && payload.phase !== 'generating') console.log(payload.reqId, payload.phase)
} })

function metrics(bytes) {
  let peak = 0, sum = 0
  for (let index = 44; index + 1 < bytes.length; index += 2) {
    const sample = bytes.readInt16LE(index) / 32768
    peak = Math.max(peak, Math.abs(sample)); sum += sample * sample
  }
  const rms = Math.sqrt(sum / ((bytes.length - 44) / 2))
  assert(peak > 0.01 && rms > 0.002 && peak <= 1, '音訊須有可聽振幅，不能只有靜音')
  return { peak, rms }
}

async function generate(mode, options) {
  const start = Date.now(), before = chunkCount
  const result = await service.generate({ reqId: mode, mode, seed: 42, cfgScale: 1, ...options })
  const bytes = Buffer.from(result.audioBase64, 'base64')
  assert.equal(wavInfo(bytes).sampleRate, 24000)
  assert(result.duration > 0.3 && result.duration < 60)
  assert(chunkCount > before, '須收到真正 PCM chunks')
  const filename = path.join(outputDir, `${mode}-${Date.now()}.wav`)
  fs.writeFileSync(filename, bytes)
  console.log(JSON.stringify({ mode, elapsedMs: Date.now() - start, duration: result.duration, chunks: chunkCount - before, ...metrics(bytes) }))
  return { ...result, filename }
}

async function run() {
  const models = require('../src/main/models')
  fs.mkdirSync(path.join(root, 'models'), { recursive: true })
  fs.symlinkSync(cache, models.modelDir('breezetts2q8'), 'junction')
  fs.symlinkSync(path.join(cache, 'runtime'), models.modelDir('breezeruntime'), 'junction')
  fs.mkdirSync(outputDir)
  assert.equal((await service.status()).installed, true)
  assert.equal((await service.voices()).length, 0)
  assert.equal((await service.status()).ready, false, '開頁不得預先載模型')
  const spoken = '今天的天氣很好，歡迎使用文字轉語音。'
  const design = await generate('design', { text: spoken, instruction: '清晰自然的臺灣女性聲音，語調溫暖友善。' })
  selected = design.filename
  const reference = await service.pickAudio({ kind: 'reference' })
  const referenceFields = { refAudioId: reference.audioId, refText: spoken }
  const clone = await generate('clone', { ...referenceFields, text: 'Hello, this is a cloned voice speaking English.' })
  await generate('direction', { ...referenceFields, text: '(sigh) 請輕聲告訴我，一切都會慢慢變好。',
    instruction: 'Speak slowly in a gentle whisper, sounding reassuring.' })
  selected = clone.filename
  const source = await service.pickAudio({ kind: 'source' })
  await generate('convert', { ...referenceFields, sourceAudioId: source.audioId, text: 'Hello, this is a cloned voice speaking English.',
    temperature: 0.3, topK: 1, keepAcoustic: 0 })
  const voice = await service.saveVoice({ name: 'probe_speaker', ...referenceFields })
  assert.equal(voice.id, 'probe_speaker')
  assert.equal((await service.voices())[0].id, voice.id)
  await generate('clone', { voiceId: voice.id, text: '這是一段使用已保存聲音生成的新錄音。' })
  await service.shutdown()
  assert.equal((await service.voices())[0].id, voice.id, '保存聲音須跨runtime重啟保留')
  await service.removeVoice({ id: voice.id })
  assert.equal((await service.voices()).length, 0)
  await generate('design', { text: '準備測試中途停止。', instruction: '清晰的中文聲音。' })
  let chunks = 0
  service.init({ send(channel) { if (channel === 'breeze:chunk') chunks++ } })
  const pending = service.generate({ reqId: 'cancel', mode: 'design', text: spoken.repeat(100), instruction: '溫柔的臺灣女性聲音。' })
  const rejected = assert.rejects(pending, (error) => error.code === 'CANCELED')
  const deadline = Date.now() + 60000
  while (!chunks && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert(chunks > 0, '收到PCM才中斷取消')
  await service.cancel({ reqId: 'cancel' }); await rejected
  assert.equal((await service.status()).ready, false)
  service.init({ send(channel) { if (channel === 'breeze:chunk') chunkCount++ } })
  await generate('design', { text: '停止之後，還可以重新生成。', instruction: '清晰的中文聲音。' })
  console.log('PASS 真 Q8 四模式、vocal tag、PCM串流、保存/重啟/刪除、中途取消/重新生成；輸出：', outputDir)
  console.log('注意：振幅/WAV檢查證明產物有效；音色相似度、語意完整性未以人工聽音評分。')
}
app.whenReady().then(run).then(async () => { await service.shutdown(); app.exit(0) }).catch(async (error) => {
  console.error(error); await service.shutdown(); app.exit(1)
})
