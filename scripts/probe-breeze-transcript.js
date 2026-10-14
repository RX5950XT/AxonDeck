// npx electron scripts/probe-breeze-transcript.js — 真 Q8 + 真本地 ASR：
// 選參考音後自動辨識逐字稿整條真路。用暫存 userData，models/hf-models 用
// junction 指正式資料（只讀不寫）；breeze/ASR server 都走隨機 loopback 埠，
// 不影響使用中的 App。ASR 模型沒下載會紅（代表退回路徑），不是靜默綠。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { app, dialog } = require('electron')
const { tempDir } = require('./lib/test-temp')
const root = tempDir('breeze-transcript-')
app.setPath('userData', root)
const formal = path.join(app.getPath('appData'), 'voiceink')

async function run() {
  for (const dir of ['models', 'hf-models']) {
    const src = path.join(formal, dir)
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(root, dir), 'junction')
  }
  const asrSelect = require('../src/main/asr-select')
  asrSelect.setStore({ get: (key, fallback) => fallback })
  const service = require('../src/main/breeze-tts')
  service.init({ send: () => {} })
  assert.equal((await service.status()).installed, true, '正式資料須有 Breeze Q8 與 runtime')
  const spoken = '今天的天氣很好，歡迎使用文字轉語音。'
  const started = Date.now()
  const design = await service.generate({ reqId: 'probe-design', mode: 'design',
    text: spoken, instruction: '清晰自然的臺灣女性聲音，語調溫暖友善。', seed: 42, cfgScale: 1 })
  const wavFile = path.join(root, 'design.wav')
  fs.writeFileSync(wavFile, Buffer.from(design.audioBase64, 'base64'))
  console.log(`design 真生成：${((Date.now() - started) / 1000).toFixed(1)} 秒，音訊 ${design.duration.toFixed(1)} 秒`)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wavFile] })
  const asrStarted = Date.now()
  const reference = await service.pickAudio({ kind: 'reference' })
  console.log(`pickAudio 含自動辨識：${((Date.now() - asrStarted) / 1000).toFixed(1)} 秒`)
  console.log(`逐字稿：${JSON.stringify(reference.transcript)}`)
  assert.equal(typeof reference.transcript, 'string')
  assert(reference.transcript.length > 0, '真 ASR 須辨識出逐字稿（空字串代表退回路徑）')
  await service.shutdown()
  await asrSelect.unload().catch(() => {})
  console.log('PASS 真參考音自動辨識逐字稿')
}

run().catch(async (error) => {
  console.error(error)
  try { await require('../src/main/breeze-tts').shutdown() } catch {}
  try { await require('../src/main/asr-select').unload() } catch {}
  process.exitCode = 1
})
