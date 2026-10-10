'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const { tempDir } = require('./lib/test-temp')
const protocol = require('../src/main/pdf-translate/protocol')
const { registerPdfTranslateIpc } = require('../src/main/pdf-translate/ipc')

const root = tempDir('pdf-translate-')
const input = path.join(root, 'source.pdf')
const resultFile = path.join(root, 'translated.pdf')
const sourceBytes = Buffer.from('%PDF-1.7\noriginal source\n%%EOF')
fs.writeFileSync(input, sourceBytes)
let ready = true, mode = 'normal', destination = resultFile, child, translated = [], released = 0
let engineReady = true
const events = []
const settings = { translator: 'local', localTranslateModel: 'linguaforge08q4' }
const source = path.resolve('src/main/pdf-translate/index.js')
const realRequire = createRequire(source)
const modelKeys = ['paddleocrvl16', 'ppdoclayoutv3', 'pdfruntime', 'llamaruntime']
const box = vm.createContext({ module: { exports: {} }, Buffer, structuredClone, setTimeout, clearTimeout,
  __dirname: path.dirname(source),
  AbortController, process: { platform: 'linux', env: {} },
  require(id) {
    if (id === 'electron') return { app: { getPath: () => root }, dialog: {
      showOpenDialog: async () => ({ filePaths: [input] }),
      showSaveDialog: async () => ({ filePath: destination, canceled: !destination }) } }
    if (id === '../models') return { MODELS: Object.fromEntries(modelKeys.map((key) => [key, { label: key }])),
      isDownloaded: () => ready, modelDir: (key) => path.join(root, key) }
    if (id === './runtime') return { pythonExe: () => 'python.exe' }
    if (id === '../hfmodels') return { init() {}, writePresets: async () => {}, ensureRuntime: async () => {},
      refreshModels: async () => [{ id: 'paddleocrvl16' }],
      endpoint: () => ({ baseUrl: 'http://127.0.0.1:1234', apiKey: 'private-runtime-key' }) }
    if (id === '../engine') return { setStore() {}, acquire: async () => ({ ok: engineReady }), release: async () => { released++ } }
    if (id === '../model-scope') return { readLlm: (store) => ({ mode: 'local', modelKey: store.get('fileLlm').split(':')[1] }) }
    if (id === '../local-llm') return { setStore() {}, resolveLocalTranslateModel: (store) => store.get('localTranslateModel'),
      translate: async (store, text, lang, opts) => {
        translated.push({ text, lang, key: store.get('fileLlm'), signal: opts.signal })
        if (mode === 'wait') await new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })
        })
        return text === 'Hello' ? '你好' : '譯文'
      } }
    if (id === 'child_process') return { spawn(exe, args, options) {
      assert.equal(exe, 'python.exe'); assert.equal(options.shell, false); assert.equal(options.windowsHide, true)
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter()
      child.pid = 123; child.exitCode = null
      child.kill = () => { child.exitCode = -1; child.emit('close', -1) }
      let config
      child.stdin.write = (line) => {
        const message = JSON.parse(line)
        if (!config) {
          config = message
          assert.equal(config.endpoint.baseUrl, 'http://127.0.0.1:1234/v1')
          assert.notEqual(config.inputPath, input)
          queueMicrotask(() => {
            if (mode === 'protocol') child.stdout.emit('data', Buffer.from('private upstream body\n'))
            else {
              child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'progress', page: 1, pages: 250, stage: 'ocr' }) + '\n'))
              child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'translate', id: 0, text: 'Hello' }) + '\n'))
            }
          })
        } else {
          assert.equal(message.id, 0); assert.equal(message.text, '你好')
          fs.writeFileSync(config.outputPath, '%PDF-1.7\ntranslated\n%%EOF')
          const bytes = Buffer.from(JSON.stringify({ type: 'done', pages: 250, translatedBlocks: 1,
            warnings: [{ code: 'overflow', count: 1 }, { code: 'private-body', count: 1 }] }) + '\n')
          // 真 UTF-8 字節拆片，而不是假定每次 stdout 都是一整行。
          child.stdout.emit('data', bytes.subarray(0, 13)); child.stdout.emit('data', bytes.subarray(13))
          child.exitCode = 0; child.emit('close', 0)
        }
      }
      return child
    } }
    return realRequire(id)
  }, queueMicrotask
})
vm.runInContext(fs.readFileSync(source, 'utf8'), box, { filename: source })
const service = box.module.exports
service.init({ store: { get: (key, fallback) => settings[key] ?? fallback },
  send: (channel, payload) => events.push({ channel, payload }) })

async function waitFor(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`test timeout: ${JSON.stringify(service.status())}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function verifyPdfOwnership() {
  let loaded = false, asrCalls = 0
  const llm = { setStore() {}, isLoaded: () => loaded,
    warm: async () => { loaded = true; return {} }, unload: async () => { loaded = false; return {} } }
  const asr = { setStore() {}, isLoaded: () => false,
    warm: async () => { asrCalls++; return {} }, unload: async () => ({}) }
  const context = vm.createContext({ module: { exports: {} }, require: (id) => {
    if (id === './local-llm') return llm
    if (id === './asr-select') return asr
    if (id === './model-scope') return { readLlm: () => ({ mode: 'off' }) }
    throw new Error(id)
  } })
  vm.runInContext(fs.readFileSync(path.resolve('src/main/engine.js'), 'utf8'), context)
  const engine = context.module.exports
  await engine.acquire('translate', { llm: true })
  await engine.acquire('pdf', { llm: true })
  await engine.release('translate')
  assert.equal(engine.status().llmLoaded, true, '文字翻譯切頁後，PDF 還在用的模型不能卸載')
  assert.equal(engine.status().users.pdf, true)
  assert.equal(asrCalls, 0, 'PDF 不載入語音模型')
  await engine.release('pdf')
  assert.equal(engine.status().llmLoaded, false, '最後一個 PDF 工作結束才卸載')
}

async function run() {
  await verifyPdfOwnership()
  assert.throws(() => protocol.validateOptions({}), /選擇 PDF/)
  assert.throws(() => protocol.validateOptions({ fileId: 'a'.repeat(36), targetLang: 'xx' }), /語言/)
  const long = 'A'.repeat(2200) + '。' + '𠮷'.repeat(1800)
  const chunks = protocol.splitText(long)
  assert.equal(chunks.join(''), long); assert(chunks.every((text) => text.length <= 1800 && !/[\uD800-\uDBFF]$/.test(text)))
  await assert.rejects(service.inspect('../bad.pdf'), /PDF/)
  const invalid = path.join(root, 'fake.pdf'); fs.writeFileSync(invalid, 'not a PDF document')
  await assert.rejects(service.inspect(invalid), /不是 PDF/)
  const textAsImage = path.join(root, 'evil.jpg'); fs.writeFileSync(textAsImage, 'not an image')
  await assert.rejects(service.inspect(textAsImage), /PDF 或圖片/)
  const pdfAsImage = path.join(root, 'mismatch.png'); fs.writeFileSync(pdfAsImage, sourceBytes)
  await assert.rejects(service.inspect(pdfAsImage), /PDF 或圖片/)
  const png = path.join(root, 'scan.png')
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]))
  const shot = await service.inspect(png)
  assert.equal(shot.kind, 'image'); assert(!('path' in shot))
  const info = await service.inspect(input)
  assert.equal(info.name, 'source.pdf'); assert(!('path' in info))
  ready = false
  assert.throws(() => service.start({ fileId: info.fileId, targetLang: 'zh-TW' }), /Local SI/)
  ready = true
  const job = service.start({ fileId: info.fileId, targetLang: 'zh-TW' })
  settings.localTranslateModel = 'indextranslate2b'
  assert.throws(() => service.start({ fileId: info.fileId, targetLang: 'zh-TW' }), /正在處理/)
  assert.throws(() => service.assertIdle(), /正在處理/)
  await waitFor(() => service.status().job.state === 'done')
  assert.equal(translated[0].key, 'local:linguaforge08q4')
  assert.equal(service.status().job.pages, 250)
  assert.deepEqual(JSON.parse(JSON.stringify(service.status().job.warnings)), [{ code: 'overflow', count: 1 }])
  assert(!JSON.stringify(events).includes('private-runtime-key'))
  assert.equal(released, 1)
  destination = input
  await assert.rejects(service.save(job.jobId), /新的檔名/)
  assert(fs.readFileSync(input).equals(sourceBytes))
  const link = path.join(root, 'source-link.pdf')
  fs.symlinkSync(input, link)
  destination = link
  await assert.rejects(service.save(job.jobId), /新的檔名/)
  destination = resultFile
  assert.equal((await service.save(job.jobId)).saved, true)
  assert.match(fs.readFileSync(resultFile, 'utf8'), /translated/)
  assert(fs.readFileSync(input).equals(sourceBytes))
  // 剪貼簿貼上：二進位樣本程式產生，不憑記憶貼。
  const crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c }
  const crc32 = (buffer) => { let crc = -1; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8); return (crc ^ -1) >>> 0 }
  const pngChunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 4 + body.length)
    return out
  }
  const shotBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), pngChunk('IEND', Buffer.alloc(0))])
  const shotUrl = `data:image/png;base64,${shotBytes.toString('base64')}`
  const jpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00])
  const clipDir = path.join(root, 'pdf-translate')
  const clipFiles = () => new Set(fs.existsSync(clipDir) ? fs.readdirSync(clipDir) : [])
  const beforePaste = clipFiles()
  const pasted = await service.pasteImage({ name: '../../shot.png', dataUrl: shotUrl })
  assert.equal(pasted.kind, 'image'); assert.equal(pasted.name, 'shot.png'); assert(!('path' in pasted))
  assert.equal([...clipFiles()].filter((name) => !beforePaste.has(name)).length, 1)
  const mismatched = await service.pasteImage({ name: 'a.png', dataUrl: `data:image/png;base64,${jpegBytes.toString('base64')}` })
  assert.match(mismatched.name, /\.jpg$/, '副檔名跟檔頭走，不跟宣稱走')
  assert.equal([...clipFiles()].filter((name) => !beforePaste.has(name)).length, 1, '換檔刪掉上一個剪貼簿暫存')
  await assert.rejects(service.pasteImage({ name: 'x.png', dataUrl: 'data:text/plain;base64,aGk=' }), /圖片/)
  await assert.rejects(service.pasteImage({ name: 'x.pdf', dataUrl: `data:application/pdf;base64,${shotBytes.toString('base64')}` }), /圖片/)
  await assert.rejects(service.pasteImage({ name: 'x.png', dataUrl: 'not-a-data-url' }), /圖片/)
  await assert.rejects(service.pasteImage({ name: 'x.png', dataUrl: 'data:image/png;base64,AAAA' }), /無效/)
  assert.equal(service.status().file.fileId, mismatched.fileId)
  const picked = await service.inspect(input)
  assert.equal(service.status().job, null)
  mode = 'wait'
  const cancelJob = service.start({ fileId: picked.fileId, targetLang: 'ja' })
  await waitFor(() => translated.length === 2)
  assert.equal(await service.cancel('wrong'), false)
  assert.equal(await service.cancel(cancelJob.jobId), true)
  assert.equal(service.status().job.state, 'cancelled')
  assert(translated[1].signal.aborted)
  await assert.rejects(service.save(cancelJob.jobId), /尚未/)
  mode = 'protocol'
  service.start({ fileId: picked.fileId, targetLang: 'en' })
  await waitFor(() => service.status().job.state === 'failed')
  assert(!JSON.stringify(service.status()).includes('private upstream body'))
  await service.shutdown()
  const newer = await service.inspect(input)
  fs.appendFileSync(input, 'changed')
  service.start({ fileId: newer.fileId, targetLang: 'en' })
  await waitFor(() => service.status().job.state === 'failed')
  assert.match(service.status().job.error, /修改/)
  await service.shutdown()
  const handlers = new Map()
  registerPdfTranslateIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: { status: () => ({ ready: true }) }, isMainSender: (event) => event.allowed })
  assert.equal(handlers.size, 7)
  // 三份清單對齊：ipc.js、main.js 轉發、preload 缺任一都會回通用碼。
  const mainSource = fs.readFileSync(path.resolve('src/main/main.js'), 'utf8')
  for (const method of ['pick', 'inspect', 'pasteImage', 'start', 'cancel', 'status', 'save']) {
    assert.match(mainSource, new RegExp(`${method}: async`), `main.js 轉發缺 ${method}`)
  }
  assert.match(fs.readFileSync(path.resolve('src/preload/preload.js'), 'utf8'), /pasteImage: \(payload\)/)
  assert.equal((await handlers.get('pdfTranslate:status')({ allowed: false })).error.code, 'FORBIDDEN')
  assert.equal((await handlers.get('pdfTranslate:pasteImage')({ allowed: false })).error.code, 'FORBIDDEN')
  assert.equal((await handlers.get('pdfTranslate:status')({ allowed: true })).data.ready, true)
  console.log('PASS PDF：輸入驗證、長文拆分、模型快照、250頁進度、另存來源保護、取消與錯誤遮罩、IPC守衛')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
