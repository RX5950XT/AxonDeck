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
    if (!process.argv.includes('--cpu')) {
      const paragraphs = [
        'The village library opens at nine every morning. Students visit after school to read about science and history. Volunteers repaired the windows last summer and planted flowers outside the building.',
        'A farmer checks the soil before planting vegetables. Rainwater is collected in large tanks, and the workers use it during dry weeks. Fresh produce is sold at the market every Saturday morning.',
        'The old bridge crosses a narrow river near the station. Engineers inspected its supports in spring and replaced damaged boards. Walkers can now cross safely, while vehicles take the newer road.',
        'At the hospital, nurses prepare medicine before breakfast. Each patient receives a written schedule and can ask questions about treatment. Visitors must wash their hands before entering the rooms.',
        'The city bus arrives every twenty minutes during the day. Passengers can pay with a travel card or buy a ticket from the driver. The last bus leaves the central station at eleven in the evening.',
        'In the science classroom, children measure the temperature of water. Their teacher explains how to record observations and compare results. After the experiment, every group cleans its equipment.',
        'A family is planning a trip to the coast. They booked a small hotel near the beach and checked the weather forecast. Their children want to visit the museum, collect shells, and watch fishing boats.',
        'The community garden welcomes new members each month. People share tools and teach beginners how to grow herbs. At the end of autumn, everyone gathers to cook a meal using vegetables from the garden.'
      ]
      const article = paragraphs.map((text, i) => `${text} REF${String(i + 1).padStart(3, '0')}`).join('\n\n')
      const out = await llm.translate(store, article, 'zh-TW', { mode: 'file' })
      assert.ok(out?.trim() && out.trim() !== article.trim() && /[\u3400-\u9fff]/.test(out), '約 2000 字的本地翻譯應回傳中文')
      for (let i = 1; i <= paragraphs.length; i++) assert.ok(out.includes(`REF${String(i).padStart(3, '0')}`), `${key} 不得漏掉第 ${i} 段`)
      console.log(`PASS ${key} 長文 ${article.length} 字 → ${out.length} 字`)
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
