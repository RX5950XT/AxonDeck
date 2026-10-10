'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { tempDir, removeTree } = require('./lib/test-temp')
const dir = tempDir('pdf-models-runtime-')
const originalLoad = Module._load
const calls = []
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => dir } }
  if (id === './hfmodels/download') return { downloadFile: async options => {
    calls.push(options)
    fs.writeFileSync(options.dest, Buffer.alloc(options.expectedBytes))
    return { bytes: options.expectedBytes }
  } }
  return originalLoad.call(this, id, ...args)
}
const models = require('../src/main/models')
Module._load = originalLoad
const runtime = require('../src/main/pdf-translate/runtime')

async function main() {
  try {
    assert.deepEqual(models.OCR_MODEL_KEYS, ['paddleocrvl16'])
    for (const key of ['paddleocrvl16', 'ppdoclayoutv3']) {
      const def = models.MODELS[key]
      assert.equal(def.kind, 'ocr')
      assert.equal(def.totalBytes, Object.values(def.fileBytes).reduce((a, b) => a + b, 0))
      for (const file of def.files) assert.match(def.sha256[file], /^[a-f0-9]{64}$/)
    }
    assert.equal(models.MODELS.ppdoclayoutv3.gguf, undefined)
    assert.equal(models.MODELS.pdfruntime.runtime, 'pdf')
    assert.equal(models.isDownloaded('pdfruntime'), false)
    assert.equal(runtime.pythonExe(dir), path.join(dir, 'venv', 'Scripts', 'python.exe'))
    const runtimeDir = models.modelDir('pdfruntime')
    const basePython = path.join(runtimeDir, 'python', 'cpython-3.12.12-windows-x86_64-none', 'python.exe')
    for (const file of [runtime.pythonExe(runtimeDir), basePython]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'python')
    }
    fs.writeFileSync(path.join(runtimeDir, 'ready.json'), JSON.stringify({ python: '3.12.12',
      packages: ['paddlepaddle==3.3.1', 'paddleocr[doc-parser]==3.7.0', 'pymupdf==1.28.2'] }))
    assert.equal(models.isDownloaded('pdfruntime'), true)
    fs.rmSync(basePython)
    assert.equal(models.isDownloaded('pdfruntime'), false, '移除基底 Python 後 venv 不能算可執行')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(runtime.install({ dir: path.join(dir, 'cancel'), signal: controller.signal }))
    assert.equal(runtime.isReady(path.join(dir, 'cancel')), false)

    fs.writeFileSync(basePython, 'python')
    const layout = models.MODELS.ppdoclayoutv3
    for (const file of layout.files) {
      layout.fileBytes[file] = 1
      const target = path.join(models.modelDir('ppdoclayoutv3'), file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, 'x')
    }

    const def = models.MODELS.paddleocrvl16
    def.fileBytes = { [def.files[0]]: 3, [def.files[1]]: 5 }
    def.totalBytes = 8
    const statuses = []
    await models.download('paddleocrvl16', progress => statuses.push(progress))
    assert.deepEqual(calls.map(c => c.expectedBytes), [3, 5], '多檔使用各自大小，不能拿模型總大小驗證')
    assert.equal(models.isDownloaded('paddleocrvl16'), true)
    fs.writeFileSync(models.filePath('paddleocrvl16', 'mmproj'), 'x')
    assert.equal(models.isDownloaded('paddleocrvl16'), false, '缺損 mmproj 不算下載完成')
    assert.equal(statuses.at(-1).receivedBytes, 8)

    const file = path.resolve(__dirname, '../src/main/models.js')
    const fixture = new Module(file, module)
    fixture.filename = file
    fixture.paths = Module._nodeModulePaths(path.dirname(file))
    let dependencyCancelled = false
    Module._load = function (id, ...args) {
      if (id === 'electron') return { app: { getPath: () => dir } }
      if (id === './pdf-translate/runtime') return { isReady: () => false,
        install: ({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            dependencyCancelled = true
            reject(new Error('下載已取消'))
          }, { once: true })
        }) }
      return originalLoad.call(this, id, ...args)
    }
    try {
      fixture._compile(fs.readFileSync(file, 'utf8'), file)
      const api = fixture.exports
      const pending = api.download('paddleocrvl16', () => {})
      assert.equal(api.status().models.pdfruntime.downloading, true)
      assert.equal(api.status().models.ppdoclayoutv3.downloading, true)
      assert.equal(api.status().models.paddleocrvl16.downloading, true)
      api.cancelDownload('paddleocrvl16')
      await assert.rejects(pending, /已取消/)
      assert.equal(dependencyCancelled, true, '取消 OCR 時，自動安裝的 layout / PDF runtime 也停止')
      assert.equal(api.status().models.pdfruntime.downloading, false)
    } finally { Module._load = originalLoad }
    console.log('PASS PDF OCR registry、各檔大小、mmproj 完整性、runtime 基底與取消')
  } finally { removeTree(dir) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
