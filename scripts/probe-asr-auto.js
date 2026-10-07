/** 真音訊驗兩顆 ASR 的 GPU／CPU；npx electron scripts/probe-asr-auto.js [--cpu]。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { app } = require('electron')
const { tempDir, removeTree } = require('./lib/test-temp')
const root = tempDir('axondeck-asr-auto-')
const sourceRoot = process.env.AXONDECK_ASAR || path.join(__dirname, '..')
const from = (file) => require(path.join(sourceRoot, 'src/main', file))
const liveRoot = path.join(app.getPath('appData'), 'voiceink')
app.setPath('userData', root)
const models = from('models')
const hf = from('hfmodels')
const hardware = from('hfmodels/hardware')
const asr = from('asr-select')
const cpu = process.argv.includes('--cpu')

function linkTree(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const a = path.join(source, entry.name), b = path.join(target, entry.name)
    if (entry.isDirectory()) linkTree(a, b)
    else try { fs.linkSync(a, b) } catch { fs.copyFileSync(a, b) }
  }
}

async function samplesOf() {
  const result = await from('edge-tts').synthesize({ text: '今天天氣很好，我們一起去公園散步吧。', voice: 'zh-TW-HsiaoChenNeural' })
  const bytes = Buffer.from(result.data)
  return new Promise((resolve, reject) => {
    const child = spawn(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], { windowsHide: true })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code) return reject(new Error(`ffmpeg exit ${code}`))
      const buf = Buffer.concat(chunks)
      resolve(Float32Array.from({ length: buf.length / 4 }, (_, i) => buf.readFloatLE(i * 4)))
    })
    child.stdin.end(bytes)
  })
}

app.whenReady().then(async () => {
  try {
    linkTree(path.join(liveRoot, 'models/llamaruntime'), models.modelDir('llamaruntime'))
    for (const key of models.ASR_MODEL_KEYS) {
      const source = path.join(liveRoot, 'models', key)
      if (fs.existsSync(source)) linkTree(source, models.modelDir(key))
    }
    if (!models.isDownloaded('qwen3asr')) {
      await models.download('qwen3asr', () => {})
      // 換版只加入 GGUF，不覆寫正在使用的舊 ONNX 檔案。
      for (const file of models.MODELS.qwen3asr.files) {
        const target = path.join(liveRoot, 'models/qwen3asr', file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(models.modelDir('qwen3asr'), file), target)
      }
    }
    if (cpu) hardware.listDevices = async () => []
    const data = { fileAsr: 'local:qwen3asr', liveAsr: 'local:qwen3asrgpu', hfModelsMax: 3 }
    asr.setStore({ get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value } })
    const samples = await samplesOf()
    console.log(`音訊 ${(samples.length / 16000).toFixed(1)} 秒，開始 ${cpu ? 'CPU' : 'GPU'} 驗證`)
    for (const scope of ['file', 'live']) {
      const result = await asr.warm(scope, scope === 'live' ? ['file'] : [])
      console.log(`載入 ${asr.currentKey(scope)}：${result.ok}`)
      assert.equal(result.ok, true, result.warnings.join('; '))
      const device = await hf.currentDevice()
      assert.equal(!!device, !cpu, '自動選擇的執行裝置')
      const text = await asr.transcribe(scope, { samples, sampleRate: 16000, lang: 'zh-TW' })
      assert.match(text, /公園.*散步/)
      assert.doesNotMatch(text, /气|们|园|<asr_text>/)
      console.log(`PASS ${asr.currentKey(scope)} ${device?.id || 'CPU'} ${text}`)
    }
    assert.equal(asr.pick('file').isLoaded(), true, '另一個 scope 不得卸載仍在使用的模型')
    console.log('ALL PASS')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    await asr.unload().catch(() => {})
    hf.shutdown()
    removeTree(root)
    app.exit(process.exitCode || 0)
  }
})
