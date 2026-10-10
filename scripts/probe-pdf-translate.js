'use strict'

/** npx electron scripts/probe-pdf-translate.js [--ocr-only] [--preview]
 * 真 PaddleOCR-VL + PP-DocLayoutV3 + LinguaForge；只用生成的 PDF 和隔離 userData。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const { execFile } = require('child_process')
const { createHash } = require('crypto')
const { app, dialog } = require('electron')
const { tempDir } = require('./lib/test-temp')
const execute = promisify(execFile)
const OCR_ONLY = process.argv.includes('--ocr-only')
const PREVIEW = process.argv.includes('--preview')
const root = tempDir('pdf-real-probe-')
const modelRoot = path.join(app.getPath('appData'), 'voiceink', 'models')
fs.symlinkSync(modelRoot, path.join(root, 'models'), 'junction')
app.setPath('userData', root)

const hf = require('../src/main/hfmodels')
const engine = require('../src/main/engine')
const service = require('../src/main/pdf-translate')
const runtime = require('../src/main/pdf-translate/runtime')
const models = require('../src/main/models')
const values = { translator: 'local', localTranslateModel: 'linguaforge08q4',
  sysmonSensors: false, uffsAuto: false, chatProviders: [], hfModelsDir: path.join(root, 'hf-models') }
const store = { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value } }
const source = path.join(root, 'source.pdf')
const output = path.join(root, 'translated.pdf')
const hash = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex')

async function python(code, args = []) {
  const executable = OCR_ONLY ? 'python' : runtime.pythonExe(models.modelDir('pdfruntime'))
  return execute(executable, ['-I', '-B', '-u', '-c', code, ...args], {
    windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  })
}

async function fixture() {
  await python(`import importlib.util,sys,pymupdf as fitz
s=importlib.util.spec_from_file_location('fixture',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.write_fixture(sys.argv[2])
with fitz.open(sys.argv[2]) as d:d[0].get_pixmap(matrix=fitz.Matrix(2,2)).save(sys.argv[3])`,
  [path.join(__dirname, 'test-pdf-translate-worker.py'), source, path.join(root, 'source.png')])
}

async function ocrOnly() {
  hf.init({ userDataPath: root, store })
  await hf.writePresets()
  const preset = path.join(root, 'hf-presets.ini')
  const section = fs.readFileSync(preset, 'utf8').split('[paddleocrvl16]\n')[1]?.split(/\n\[/, 1)[0]
  assert(section && /^special = on$/m.test(section), 'OCR 正式 preset 沒有保留 Spotting 座標 token')
  await hf.ensureRuntime()
  const endpoint = hf.endpoint()
  assert(endpoint, 'OCR router 尚未啟動')
  const started = Date.now()
  const pulse = setInterval(() => console.log(`OCR spotting：${Math.round((Date.now() - started) / 1000)} 秒`), 30000)
  try {
    const response = await fetch(`${endpoint.baseUrl.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(20 * 60 * 1000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model: 'paddleocrvl16', temperature: 0, max_tokens: 2048, stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Spotting:' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${fs.readFileSync(path.join(root, 'source.png')).toString('base64')}` } }] }] })
    })
    assert(response.ok, `OCR HTTP ${response.status}`)
    const result = await response.json()
    const content = result.choices?.[0]?.message?.content
    assert(typeof content === 'string' && content.trim(), 'OCR 回傳空白')
    assert(Number(result.usage?.completion_tokens) > 0, 'OCR 沒有產出 token')
    assert(/Document|title|paragraph/i.test(content), 'OCR 未辨識 fixture 文字')
    assert(/<\|LOC_\d+\|>/.test(content), 'Spotting 座標標記遺失，不能用來替換掃描文字')
    const locations = [...content.matchAll(/<\|LOC_(\d+)\|>/g)].map((match) => Number(match[1]))
    assert(locations.length >= 8 && locations.length % 8 === 0 && locations.every((value) => value >= 0 && value <= 1000), 'Spotting 四點座標格式錯誤')
    console.log(JSON.stringify({ mode: 'ocr-only', seconds: (Date.now() - started) / 1000,
      completionTokens: result.usage.completion_tokens, finishReason: result.choices[0].finish_reason,
      spottingPolygons: locations.length / 8, fixtureRecognition: content.slice(0, 12000) }, null, 2))
  } finally { clearInterval(pulse) }
}

async function translate() {
  const ready = service.status()
  assert(ready.ready, `PDF 執行環境未完整安裝：${ready.missing.join('、')}`)
  assert(models.isDownloaded('linguaforge08q4'), 'LinguaForge 尚未下載')
  await runOne({ input: source, output, target: 'translated.pdf', expectPages: 4, label: 'PDF' })
  const checked = await verifyOutput()
  console.log(JSON.stringify({ mode: 'full-pdf', ...checked }))
  // 圖片：同一管線，輸出原圖墊底、譯文蓋位的單頁 PDF。
  const imageInput = path.join(root, 'source.png')
  await runOne({ input: imageInput, output: path.join(root, 'image-translated.pdf'), target: 'image.pdf', expectPages: 1, label: '圖片' })
  const imageText = await python(`import sys,pymupdf as fitz
with fitz.open(sys.argv[1]) as src,fitz.open(sys.argv[2]) as dst:
 assert dst.page_count==1,'圖片輸出不是單頁'
 text=dst[0].get_text()
 assert len(__import__('re').findall('[\\u3400-\\u9fff]',text))>0,'圖片輸出沒有中文譯文'
 assert 'Document title' not in text,'圖片原文未被替換'
 print('image-ok')`, [imageInput, path.join(root, 'image-translated.pdf')])
  assert(imageText.stdout.includes('image-ok'), '圖片輸出驗證失敗')
  console.log(JSON.stringify({ mode: 'image', pages: 1, verified: true }))
}

async function runOne({ input, output, target, expectPages, label }) {
  let finish, reject, last = null
  const completion = new Promise((resolve, fail) => { finish = resolve; reject = fail })
  service.init({ store, send: (_channel, event) => {
    const signature = `${event.state}:${event.page}:${event.stage}`
    if (signature !== last) console.log(`${label}：${event.state} ${event.page}/${event.pages} ${event.stage}`)
    last = signature
    if (event.state === 'done') finish(event)
    if (event.state === 'failed' || event.state === 'cancelled') reject(new Error(event.error || event.state))
  } })
  const picked = await service.inspect(input)
  assert(picked.kind === (label === '圖片' ? 'image' : 'pdf'), `${label} 種類辨識錯誤`)
  const started = Date.now()
  const originalDialog = dialog.showSaveDialog
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
  let timeout
  const pulse = setInterval(() => console.log(`${label}：已執行 ${Math.round((Date.now() - started) / 1000)} 秒`), 30000)
  try {
    const { jobId } = service.start({ fileId: picked.fileId, sourceLang: 'en', targetLang: 'zh-TW' })
    const summary = await Promise.race([completion, new Promise((_, fail) => {
      timeout = setTimeout(() => fail(new Error(`${label}真模型驗證超過 40 分鐘`)), 40 * 60 * 1000)
    })])
    assert(summary.pages === expectPages && summary.translatedBlocks > 0, `${label}沒有真正翻譯`)
    const saved = await service.save(jobId)
    assert(saved.saved && fs.existsSync(output), `另存${label}失敗`)
    console.log(JSON.stringify({ mode: `${label}-job`, seconds: (Date.now() - started) / 1000,
      pages: summary.pages, translatedBlocks: summary.translatedBlocks, warnings: summary.warnings,
      sourcePreserved: true, target }))
  } finally {
    clearTimeout(timeout); clearInterval(pulse)
    dialog.showSaveDialog = originalDialog
  }
}

async function verifyOutput() {
  const result = await python(`import sys,pymupdf as fitz,json,re
with fitz.open(sys.argv[1]) as src,fitz.open(sys.argv[2]) as dst:
 assert dst.page_count==src.page_count==4,'頁數不符'
 counts=[len(re.findall('[\\u3400-\\u9fff]',dst[i].get_text())) for i in range(4)]
 assert counts[0]>0 and counts[1]>0,'原生／掃描頁未出現中文譯文'
 assert 'Document title' not in dst[0].get_text(),'原生標題仍是原文'
 assert 'E = mc^2' in dst[0].get_text(),'原生公式遭更改'
 before=[d['items'] for d in src[0].get_drawings()];after=[d['items'] for d in dst[0].get_drawings()]
 assert all(p in after for p in before),'表格／圖表向量線條遭更改'
 for rect in (fitz.Rect(25,110,170,134),fitz.Rect(100,295,275,380),src[0].search_for('E = mc^2')[-1]):
  a=src[1].get_pixmap(matrix=fitz.Matrix(2,2),clip=rect);b=dst[1].get_pixmap(matrix=fitz.Matrix(2,2),clip=rect)
  assert a.samples==b.samples,'掃描公式／曲線像素遭更改'
 assert dst[3].rect==src[3].rect,'旋轉頁尺寸遭更改'
 assert dst.get_toc()==src.get_toc(),'書籤未保留'
 assert dst.metadata['title']==src.metadata['title'],'metadata未保留'
 dst[0].get_pixmap(matrix=fitz.Matrix(2,2)).save(sys.argv[3]);dst[1].get_pixmap(matrix=fitz.Matrix(2,2)).save(sys.argv[4])
 print(json.dumps({'cjkCharactersByPage':counts,'nativeVectorPathsPreserved':True,'scannedFormulaAndChartPixelsPreserved':True,'bookmarksPreserved':True}))`,
  [source, output, path.join(root, 'native-preview.png'), path.join(root, 'scan-preview.png')])
  return JSON.parse(result.stdout.trim())
}

async function main() {
  let originalHash = ''
  try {
    await fixture()
    originalHash = hash(source)
    if (OCR_ONLY) await ocrOnly()
    else await translate()
    assert.equal(hash(source), originalHash, '來源 PDF 被修改')
    console.log(`PASS 真模型 PDF probe；預覽資料夾：${root}`)
    if (PREVIEW) await new Promise((resolve) => {
      console.log('等待 Enter 後清理預覽。')
      process.stdin.once('data', resolve); process.stdin.resume()
    })
    return 0
  } catch (error) {
    console.error(`FAIL PDF probe：${error.userMessage || error.message || '未知錯誤'}`)
    if (originalHash) assert.equal(hash(source), originalHash, '來源 PDF 被修改')
    return 1
  } finally {
    await service.shutdown()
    if (!OCR_ONLY) await engine.unloadAll().catch(() => { console.log('引擎卸載未完整回報；繼續收掉本輪 router。') })
    hf.shutdown()
  }
}

app.whenReady().then(main).then((code) => app.exit(code)).catch(() => app.exit(1))
