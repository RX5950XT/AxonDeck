'use strict'
/**
 * 即時字幕 ASR 探針：打真的雲端與本地模型，回答三個會影響字幕準確度的問題。
 *   1. 把「翻譯目標語言」當 language 送出去，遇到外語音訊會怎樣
 *   2. 前文（prompt）有沒有被模型吃進去
 *   3. 同一句越聽越長時，前面的字會不會被後面的上下文修正；每次要多久
 *
 * 用法：node scripts/probe-live-asr.js [cloud] [local] [stream-cloud] [stream-local] [--model=qwen3asr|qwen3asrgpu]
 * 雲端用 %APPDATA%\voiceink\config.json 的 liveAsr 設定（會花極少量額度，每次印出 usage.cost）。
 * 本地自己開一顆 llama-server，結束時只收自己開的 pid。
 */
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir } = require('./lib/test-temp')

const SR = 16000
const CLIPS = {
  zh: { voice: 'zh-TW-HsiaoChenNeural', lang: 'zh-TW', text: '今天我們要討論 Kubernetes 的排程機制，特別是節點親和性和污點容忍度這兩個設定，它們會影響 Pod 被放到哪一台機器上。' },
  ja: { voice: 'ja-JP-NanamiNeural', lang: 'ja-JP', text: '本日の会議では、来月の製品発売に向けたスケジュールと、広告予算の配分について話し合います。' },
  en: { voice: 'en-US-AriaNeural', lang: 'en-US', text: 'In today\'s meeting we will review the launch schedule for next month, and discuss how the marketing budget should be allocated.' }
}
/** 模擬實際會送的東西：上一句字幕原文，不是整理過的詞表 */
const PROMPT = '我們的叢集跑在 Kubernetes 上，每個 Pod 都有設定資源限制和節點親和性。'

/** @returns {Promise<Record<string, Int16Array>>} */
async function makeClips(dir) {
  const { EdgeTTS } = require('node-edge-tts')
  const out = {}
  for (const [name, clip] of Object.entries(CLIPS)) {
    const mp3 = path.join(dir, `${name}.mp3`)
    await new EdgeTTS({ voice: clip.voice, lang: clip.lang, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' }).ttsPromise(clip.text, mp3)
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', mp3, '-f', 's16le', '-ac', '1', '-ar', String(SR), 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 })
    out[name] = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
  }
  return out
}

/** @param {Int16Array} pcm */
function toWav(pcm) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.byteLength, 4); head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(pcm.byteLength, 40)
  return Buffer.concat([head, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)])
}

const seconds = (pcm) => (pcm.length / SR).toFixed(1)

/** 走 OpenRouter 的 JSON 介面；同一把金鑰只留在這個函式裡 */
function cloudClient() {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'voiceink', 'config.json'), 'utf8'))
  const [, cloudId, ...rest] = String(config.liveAsr || '').split(':')
  const cloud = (config.asrClouds || []).find((c) => c.id === cloudId)
  if (!cloud?.apiKey) throw new Error('liveAsr 不是雲端設定或沒有金鑰')
  const model = rest.join(':')
  return async (pcm, { language, options } = {}) => {
    const started = Date.now()
    const res = await fetch(`${cloud.apiUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloud.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input_audio: { data: toWav(pcm).toString('base64'), format: 'wav' },
        ...(language ? { language } : {}),
        ...(options ? { provider: { options } } : {})
      })
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, ms: Date.now() - started, text: json.text ?? '', cost: json.usage?.cost, secs: json.usage?.seconds }
  }
}

async function runCloud(clips) {
  const call = cloudClient()
  const print = (label, r) => console.log(`  ${label}: HTTP ${r.status} ${r.ms}ms cost=${r.cost} billed=${r.secs}s\n    ${r.text}`)
  console.log('\n== 雲端：language 影響 ==')
  for (const name of ['ja', 'en', 'zh']) {
    print(`${name} language=zh（目前行為，目標語繁中）`, await call(clips[name], { language: 'zh' }))
    print(`${name} 不帶 language`, await call(clips[name]))
  }
  console.log('\n== 雲端：prompt 影響（provider.options）==')
  print('zh 無 prompt', await call(clips.zh))
  print('zh groq.prompt', await call(clips.zh, { options: { groq: { prompt: PROMPT } } }))
  print('靜音 groq.prompt（會不會把前文吐回來）', await call(new Int16Array(SR * 2), { options: { groq: { prompt: PROMPT } } }))
  print('en 配中文 prompt（換語言會不會被帶偏）', await call(clips.en, { options: { groq: { prompt: PROMPT } } }))
  print('ja 配中文 prompt', await call(clips.ja, { options: { groq: { prompt: PROMPT } } }))
  print('en 1.2s 配中文 prompt', await call(clips.en.subarray(0, Math.floor(SR * 1.2)), { options: { groq: { prompt: PROMPT } } }))
  console.log('== 雲端：很短的片段自動偵測語言 ==')
  for (const name of ['zh', 'ja', 'en']) {
    const part = clips[name].subarray(0, Math.floor(SR * 1.2))
    print(`${name} 1.2s language=zh`, await call(part, { language: 'zh' }))
    print(`${name} 1.2s 不帶`, await call(part))
  }
  console.log('\n== 雲端：越聽越長 ==')
  for (const ratio of [0.35, 0.6, 0.8, 1]) {
    const part = clips.zh.subarray(0, Math.floor(clips.zh.length * ratio))
    print(`zh 前 ${seconds(part)}s`, await call(part))
  }
}

async function startLocal(key) {
  const root = path.join(process.env.APPDATA, 'voiceink', 'models')
  const dir = path.join(root, key)
  const gguf = fs.readdirSync(dir).find((f) => f.endsWith('.gguf') && !f.startsWith('mmproj'))
  const mmproj = fs.readdirSync(dir).find((f) => f.startsWith('mmproj'))
  const port = 18000 + Math.floor(Math.random() * 2000)
  const child = spawn(path.join(root, 'llamaruntimecuda', 'llama-server.exe'), [
    '--host', '127.0.0.1', '--port', String(port), '-m', path.join(dir, gguf), '--mmproj', path.join(dir, mmproj),
    '--device', 'CUDA1', '--mmproj-device', 'CUDA1', '-c', '4096', '--reasoning', 'off'
  ], { stdio: 'ignore' })
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)
    if (up) return { port, child }
    await new Promise((r) => setTimeout(r, 500))
  }
  child.kill()
  throw new Error('llama-server 起不來')
}

async function runLocal(clips, key) {
  const { port, child } = await startLocal(key)
  const call = async (pcm, { language, prompt } = {}) => {
    const form = new FormData()
    form.append('model', key)
    form.append('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'audio.wav')
    form.append('response_format', 'json')
    if (language) form.append('language', language)
    if (prompt) form.append('prompt', prompt)
    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, { method: 'POST', body: form })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, ms: Date.now() - started, text: String(json.text ?? '') }
  }
  const print = (label, r) => console.log(`  ${label}: HTTP ${r.status} ${r.ms}ms\n    ${r.text}`)
  try {
    console.log(`\n== 本地 ${key}：language 影響 ==`)
    await call(clips.zh.subarray(0, SR)) // 第一次要配置 GPU，不算進計時
    for (const name of ['ja', 'en', 'zh']) {
      print(`${name} language=zh（目前行為）`, await call(clips[name], { language: 'zh' }))
      print(`${name} 不帶 language`, await call(clips[name]))
    }
    console.log(`\n== 本地 ${key}：prompt 影響 ==`)
    print('zh 無 prompt', await call(clips.zh))
    print('zh prompt＝前文', await call(clips.zh, { prompt: PROMPT }))
    console.log(`== 本地 ${key}：很短的片段 ==`)
    for (const name of ['zh', 'ja', 'en']) {
      const part = clips[name].subarray(0, Math.floor(SR * 1.2))
      print(`${name} 1.2s language=zh`, await call(part, { language: 'zh' }))
      print(`${name} 1.2s 不帶`, await call(part))
    }
    console.log(`\n== 本地 ${key}：越聽越長 ==`)
    for (const ratio of [0.2, 0.35, 0.5, 0.65, 0.8, 1]) {
      const part = clips.zh.subarray(0, Math.floor(clips.zh.length * ratio))
      print(`zh 前 ${seconds(part)}s`, await call(part))
    }
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { child.kill() }
  }
}

/** 真的 vad.js＋live-pipeline.js（ESM，比照 test-vad.js 用 vm 載入） */
function loadRendererModules() {
  const vm = require('node:vm')
  const read = (name) => fs.readFileSync(path.join(__dirname, '../src/renderer/scripts', name), 'utf8').replace(/^export /gm, '')
  const sandbox = { console, setTimeout, Date, Float32Array, String, Math }
  vm.createContext(sandbox)
  vm.runInContext(`${read('vad.js')}\n${read('live-pipeline.js')}\nglobalThis.mod = { createVad, createCaptionPipeline }`, sandbox)
  return sandbox.mod
}

/**
 * 依實際速度把音訊餵進真正的切句與辨識流程，印出字幕什麼時候出現、怎麼變。
 * 翻譯換成立刻回傳：這裡量的是辨識。
 * @param {Int16Array[]} parts
 * @param {'local'|'cloud'} asrEngine
 * @param {(req: { samples: Float32Array, prompt?: string }) => Promise<string>} transcribe
 */
async function streamThrough(parts, asrEngine, transcribe) {
  const { createVad, createCaptionPipeline } = loadRendererModules()
  const FRAME = 2048
  const started = Date.now()
  const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`
  const asr = { calls: 0, audioSeconds: 0, ms: [] }
  /** @type {Map<string, number>} */
  const firstShown = new Map()
  const pipeline = createCaptionPipeline({
    asrEngine, llmEngine: 'local', targetLanguage: 'auto', hangoverSamples: 7680,
    transcribe: async (req) => {
      const at = Date.now()
      asr.calls++
      asr.audioSeconds += req.samples.length / SR
      const text = await transcribe(req)
      asr.ms.push(Date.now() - at)
      return text
    },
    translate: async (text) => text,
    show: (p) => {
      if (!firstShown.has(p.id)) firstShown.set(p.id, Date.now() - started)
      console.log(`  ${stamp()} ${p.interim ? '聽' : '定'} ${p.source}`)
    },
    log: () => {},
    onError: (m) => { if (m) console.log(`  ${stamp()} 錯誤 ${m}`) },
    onFatal: () => console.log('  連續失敗'),
    errorText: (e) => e.message
  })
  const vad = createVad({ sampleRate: SR, hangoverMs: 480, maxUtteranceMs: 12000, softCutMs: 3000, relativeOff: 0.12 })
  const pause = new Int16Array(SR)
  const audio = parts.flatMap((p) => [p, pause])
  let sent = 0
  for (const part of audio) {
    for (let i = 0; i + FRAME <= part.length; i += FRAME) {
      const frame = Float32Array.from(part.subarray(i, i + FRAME), (v) => v / 32768)
      const result = vad.push(frame)
      if (result.utterance) pipeline.pushUtterance(result.utterance, vad.speaking)
      else pipeline.onSpeech(vad)
      sent += FRAME
      const wait = started + (sent / SR) * 1000 - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }
  await new Promise((r) => setTimeout(r, 2500))
  await pipeline.stop()
  const speech = parts.reduce((sum, p) => sum + p.length / SR, 0)
  const sorted = [...asr.ms].sort((a, b) => a - b)
  console.log(`  語音 ${speech.toFixed(1)}s，辨識 ${asr.calls} 次，送出音訊 ${asr.audioSeconds.toFixed(1)}s（${(asr.audioSeconds / speech).toFixed(1)} 倍）`)
  console.log(`  每次辨識中位數 ${sorted[Math.floor(sorted.length / 2)]}ms、最慢 ${sorted[sorted.length - 1]}ms；第一句 ${(firstShown.values().next().value / 1000).toFixed(1)}s 出字（舊流程第一句要等 ${Math.min(6, parts[0].length / SR).toFixed(1)}s 切段後才開始辨識）`)
}

async function runStreamCloud(clips) {
  console.log('\n== 串流：雲端（走 cloud-asr.js 真正送出去的請求）==')
  const cloudAsr = require('../src/main/cloud-asr')
  const config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'voiceink', 'config.json'), 'utf8'))
  const store = { get: (key, fallback) => (key in config ? config[key] : fallback) }
  await streamThrough([clips.zh, clips.en, clips.ja], 'cloud', (req) => cloudAsr.transcribeSamples(req, store, 'live'))
}

async function runStreamLocal(clips, key) {
  console.log(`\n== 串流：本地 ${key} ==`)
  const { port, child } = await startLocal(key)
  try {
    await streamThrough([clips.zh, clips.en, clips.ja], 'local', async (req) => {
      const pcm = Int16Array.from(req.samples, (v) => Math.max(-32768, Math.min(32767, v * 32768)))
      const form = new FormData()
      form.append('model', key)
      form.append('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'audio.wav')
      form.append('response_format', 'json')
      const res = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, { method: 'POST', body: form })
      const json = await res.json()
      return String(json.text ?? '').replace(/^[\s\S]*<asr_text>/, '')
    })
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { child.kill() }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const key = [...args].find((a) => a.startsWith('--model='))?.slice(8) || 'qwen3asr'
  const dir = tempDir('live-asr')
  const clips = await makeClips(dir)
  console.log(Object.entries(clips).map(([k, v]) => `${k}=${seconds(v)}s`).join(' '))
  if (args.has('cloud')) await runCloud(clips)
  if (args.has('local')) await runLocal(clips, key)
  if (args.has('stream-cloud')) await runStreamCloud(clips)
  if (args.has('stream-local')) await runStreamLocal(clips, key)
}

main().catch((e) => { console.error(e); process.exit(1) })
