'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { tempDir } = require('./lib/test-temp')
const { downloadFile } = require('../src/main/hfmodels/download')
const dir = tempDir('breeze-models-')
const load = Module._load
Module._load = function (id, ...args) {
  return id === 'electron' ? { app: { getPath: () => dir } } : load.call(this, id, ...args)
}
const models = require('../src/main/models')
Module._load = load

async function main() {
  const model = models.MODELS.breezetts2q8
  assert.equal(model?.kind, 'tts')
  assert.equal(model.requires, 'breezeruntime')
  assert.equal(models.isLlmKey('breezetts2q8'), false)
  assert.equal(models.isAsrKey('breezetts2q8'), false)
  assert.equal(model.totalBytes, 3568844480)
  const runtime = models.MODELS.breezeruntime
  assert.match(runtime.binary, /breeze-server\.exe$/)
  const runtimeDir = models.modelDir('breezeruntime')
  for (const name of runtime.check) {
    const dest = path.join(runtimeDir, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'runtime')
  }
  assert.equal(models.isDownloaded('breezeruntime'), true)
  fs.rmSync(path.join(runtimeDir, runtime.check.find(name => name.endsWith('libbreeze.dll'))))
  assert.equal(models.isDownloaded('breezeruntime'), false, '缺 DLL 不算安裝完成')

  const payload = Buffer.from('complete model')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const dest = path.join(dir, 'pinned.gguf')
  await downloadFile({ url: 'https://example.test/model.gguf', dest, expectedBytes: payload.length,
    sha256, fetchImpl: async () => new Response(payload) })
  assert.deepEqual(fs.readFileSync(dest), payload)
  await assert.rejects(downloadFile({ url: 'https://example.test/model.gguf', dest,
    expectedBytes: payload.length, sha256: '0'.repeat(64), fetchImpl: async () => new Response(payload) }), /驗證失敗/)
  assert.equal(fs.existsSync(dest), false, '大小相同但 hash 不符仍刪除完整檔')
  fs.writeFileSync(dest, payload)
  fs.writeFileSync(`${dest}.part`, 'stale partial')
  const controller = new AbortController()
  const createReadStream = fs.createReadStream
  fs.createReadStream = function (...args) {
    if (args[0] === dest) controller.abort()
    return createReadStream.apply(this, args)
  }
  try {
    await assert.rejects(downloadFile({ url: 'https://example.test/model.gguf', dest,
      expectedBytes: payload.length, sha256, signal: controller.signal,
      fetchImpl: async () => { throw new Error('完整檔不應重抓') } }), /已取消/)
  } finally { fs.createReadStream = createReadStream }
  assert.equal(fs.existsSync(dest), false)
  assert.deepEqual(fs.readFileSync(`${dest}.part`), payload, 'Windows 取消 hash 時完整檔取代舊 .part，仍可續傳')

  const calls = []
  let cancel = false
  const modelFile = path.join(__dirname, '../src/main/models.js')
  const fixture = new Module(modelFile, module)
  fixture.filename = modelFile
  fixture.paths = Module._nodeModulePaths(path.dirname(modelFile))
  Module._load = function (id, ...args) {
    if (id === './hfmodels/download') return { downloadFile: async options => {
      calls.push(options.url)
      if (cancel) return new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(new Error('下載已取消')), { once: true }))
      fs.writeFileSync(options.dest, payload)
      options.onProgress({ received: payload.length })
      return { bytes: payload.length }
    } }
    if (id === 'child_process') return { spawn: () => {
      const child = new EventEmitter()
      process.nextTick(() => {
        for (const name of fixture.exports.MODELS.breezeruntime.check) {
          const file = path.join(fixture.exports.modelDir('breezeruntime'), name)
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, 'runtime')
        }
        child.emit('close', 0)
      })
      return child
    } }
    return id === 'electron' ? { app: { getPath: () => dir } } : load.call(this, id, ...args)
  }
  try { fixture._compile(fs.readFileSync(modelFile, 'utf8'), modelFile) }
  finally { Module._load = load }
  const api = fixture.exports
  api.MODELS.breezetts2q8.totalBytes = payload.length
  await api.download('breezetts2q8', () => {
    assert.equal(api.status().models.breezetts2q8.downloading, true)
    assert.equal(api.status().models.breezetts2q8.downloaded, false, 'hash 驗證前不標為已下載')
  })
  assert.match(calls[0], /windows-x64-vulkan\.zip$/)
  assert.match(calls[1], /q8_0\.gguf$/)
  assert.equal(api.isDownloaded('breezetts2q8'), true)
  fs.writeFileSync(api.filePath('breezetts2q8', 'gguf'), 'truncated')
  assert.equal(api.isDownloaded('breezetts2q8'), false, '不完整 GGUF 不算已安裝')
  await api.remove('breezeruntime')
  cancel = true
  const pending = api.download('breezetts2q8', () => {})
  while (calls.length < 3) await new Promise(resolve => setImmediate(resolve))
  api.cancelDownload('breezetts2q8')
  await assert.rejects(pending, /已取消/)
  assert.equal(api.status().models.breezeruntime.downloading, false, '取消模型也取消自己的 runtime 依賴')
  console.log('PASS Breeze registry：Q8、專用 runtime、DLL 完整性、SHA-256 驗證')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
