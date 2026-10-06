/** 真實本地翻譯：現行模型、舊 key 遷移、自動 GPU／CPU。npx electron scripts/e2e-local-translate-settings.js */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { tempDir, removeTree } = require('./lib/test-temp')
const profile = tempDir('axondeck-local-translate-')
app.setPath('userData', profile)
const realModels = path.join(app.getPath('appData'), 'voiceink', 'models')
fs.symlinkSync(realModels, path.join(profile, 'models'), 'junction')

app.whenReady().then(async () => {
  const models = require('../src/main/models')
  const gpu = require('../src/main/gpu-capability')
  if (process.argv.includes('--cpu')) {
    gpu.detectGpuCapability = async () => ({ ok: false, name: '模擬沒有合格 GPU' })
    require('../src/main/hfmodels/hardware').listDevices = async () => []
  }
  const llm = require('../src/main/local-llm')
  const available = models.LLM_MODEL_KEYS.filter((k) => models.isDownloaded(k))
  assert.ok(available.length, '必須有已安裝的翻譯模型')
  const data = { translator: 'local', llmGpu: false }
  const store = { get: (key, fallback) => data[key] ?? fallback }
  llm.setStore(store)
  const cap = await gpu.detectGpuCapability()
  console.log(`自動推論：${cap.ok ? 'GPU' : 'CPU'} ${cap.name}`)
  let checks = 0
  for (const key of available) {
    data.localTranslateModel = key
    const warm = await llm.warm()
    if (!warm.ok) console.error(require('../src/main/hfmodels/runtime').diagnostics().filter((s) => /error|unknown|preset|model|context|failed/i.test(s)).join('\n').replace(/[a-z0-9]{32,}/gi, '[redacted]'))
    assert.ok(warm.ok, warm.warnings.join('; '))
    const info = llm.getLoadInfo()
    assert.equal(info.key, key, '換模型必須真的換權重')
    assert.equal(info.intentGpu, cap.ok, '舊 llmGpu=false 不影響自動選擇')
    if (!cap.ok) assert.equal(info.backend, 'cpu')
    console.log(`PASS ${key} 自動載入：${info.backend} gpu=${info.gpu}`)
    for (const [mode, text] of [['file', 'The weather is nice today, so we went for a walk.'], ['live', 'Please close the window.']]) {
      const out = await llm.translate(store, text, 'zh-TW', { mode })
      assert.ok(out && out.trim() !== text && /[\u3400-\u9fff]/.test(out), `翻譯未成功：${out}`)
      console.log(`PASS ${key} ${mode} → ${out}`)
      checks++
    }
  }
  if (available.includes('indextranslate2b')) {
    data.localTranslateModel = 'qwen354b'
    assert.equal(llm.resolveLocalTranslateModel(store), 'indextranslate2b')
    console.log('PASS 舊 Qwen 設定讀成 Index')
    checks++
  }
  await llm.unload()
  console.log(`ALL PASS ${checks} translations/migrations`)
}).then(() => { require('../src/main/hfmodels').shutdown(); removeTree(profile); process.exit(0) }, (error) => {
  console.error(error)
  require('../src/main/hfmodels').shutdown()
  removeTree(profile)
  process.exit(1)
})
