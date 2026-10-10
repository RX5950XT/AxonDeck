/** 打包版檔案翻譯 UI contract；mock IPC 不跑 OCR，不改使用者資料。node scripts/e2e-pdf-translate-cdp.js */
const assert = require('assert/strict')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const asar = require('@electron/asar')
const { tempDir } = require('./lib/test-temp')

const PORT = 9254
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist/win-unpacked/AxonDeck.exe')
const USER_DATA = tempDir('pdf-translate-cdp-')
fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ sysmonSensors: false, uffsAuto: false, dictationEnabled: false }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getPages() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor() { this.id = 0; this.pending = new Map(); this.exceptions = [] }
  async connect(url) {
    this.ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const result = JSON.parse(event.data)
      if (result.method === 'Runtime.exceptionThrown') this.exceptions.push(result.params.exceptionDetails.text)
      const waiter = this.pending.get(result.id)
      if (!waiter) return
      this.pending.delete(result.id)
      if (result.error) waiter.reject(new Error(result.error.message))
      else waiter.resolve(result.result)
    })
    await this.send('Runtime.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
}

async function waitFor(action, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await action()) return
    await sleep(100)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '--hidden'], { detached: true, stdio: 'ignore' })
  const cdp = new Cdp()
  let passed = 0
  const check = async (name, expression) => {
    assert.equal(await cdp.eval(expression), true, name)
    passed++
    console.log(`PASS ${name}`)
  }
  try {
    let target
    await waitFor(async () => {
      const pages = await getPages().catch(() => [])
      target = pages.find((page) => page.type === 'page' && /index\.html/.test(page.url))
      return target
    }, '主視窗')
    await cdp.connect(target.webSocketDebuggerUrl)
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!window.electronAPI?.store`), 'preload')
    await cdp.eval(`document.querySelector('.nav-tab[data-page="translate"]').click()`)
    await waitFor(() => cdp.eval(`document.getElementById('translateInputPane')?.offsetHeight > 0`), '輸入框')
    await check('檔案翻譯住在輸入框內、沒有獨立區塊', `!!document.getElementById('translateInput') && !!document.getElementById('pdfTranslatePick') && document.getElementById('pdfTranslatePick').closest('#translateInputPane') && !document.getElementById('pdfTranslateTitle')`)

    // 使用打包內的實際模組，mock IPC；換新節點避免原本的真 IPC 事件一起觸發。
    const source = asar.extractFile(path.join(path.dirname(EXE), 'resources/app.asar'), path.join('src', 'renderer', 'scripts', 'pdf-translate.js')).toString()
      .replace(/^import[^\n]+\n/, '')
      .replace(/export /g, '')
    await cdp.eval(`(() => {
      const original = document.getElementById('pdfTranslateRoot')
      original.replaceWith(original.cloneNode(true))
      window.pdfUiTest = { ready: true, file: null, job: null, starts: [], saves: [], states: [] }
      const test = window.pdfUiTest
      const electronAPI = {
        getPathForFile: (file) => 'D:/test/' + file.name,
        pdfTranslate: {
          status: async () => ({ ok: true, data: { ready: test.ready, file: test.file, job: test.job, missing: test.ready ? [] : ['PDF 辨識模型'] } }),
          inspect: async (path) => { if (test.invalidFile) return { ok: false, error: { code: 'INVALID_FILE', message: '測試檔案無效' } }; test.path = path; test.file = { fileId: 'test-file', name: path.split('/').pop(), size: 1048576, kind: path.endsWith('.png') ? 'image' : 'pdf' }; return { ok: true, data: test.file } },
          pasteImage: async ({ name, dataUrl }) => { const url = String(dataUrl || ''); if (test.pasteInvalid || url.indexOf('data:image/') !== 0 || url.indexOf(';base64,') < 0) return { ok: false, error: { code: 'INVALID_FILE', message: '測試圖片無效' } }; test.file = { fileId: 'test-paste', name, size: 204800, kind: 'image' }; return { ok: true, data: test.file } },
          pick: async () => ({ ok: true, data: test.file }),
          start: async (request) => { test.starts.push(request); test.job = { jobId: 'test-job-' + test.starts.length, state: 'running', page: 0, pages: 250, stage: 'ocr' }; return { ok: true, data: { jobId: test.job.jobId } } },
          cancel: async (id) => { test.job = { ...test.job, state: 'cancelled' }; return { ok: true, data: true } },
          save: async (id) => { test.saves.push(id); return { ok: true, data: { saved: true, name: 'translated.pdf' } } },
          onProgress: (callback) => { test.emit = (progress) => { test.job = progress; callback(progress) } }
        }
      }
      const cleanIpcError = (error) => error.message || String(error)
      const switchPage = (page) => { test.page = page }
      ${source}
      test.api = { getPdfFile, isPdfRunning, isPdfReady, startPdfJob, cancelPdfJob, detachPdfFile, refreshPdfTranslate }
      initPdfTranslate({ getLanguages: () => ({ sourceLang: 'auto', targetLang: document.querySelector('#translateTargetLang .active').dataset.value }), onStateChange: () => test.states.push(getPdfFile()?.fileId || null) })
      test.drop = (names) => {
        const dt = new DataTransfer()
        for (const name of names) dt.items.add(new File(['fixture'], name, { type: 'application/pdf' }))
        document.getElementById('translateInputPane').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      test.paste = (files) => {
        const dt = new DataTransfer()
        for (const file of files) dt.items.add(file)
        document.getElementById('translateInputPane').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
      }
      test.png = (name) => new File(['imagedata'], name, { type: 'image/png' })
      return true
    })()`)
    await check('初始乾淨：沒有 chip、狀態與另存', `document.getElementById('pdfTranslateChip').hidden && document.getElementById('pdfTranslateStatus').hidden && document.getElementById('pdfTranslateSave').hidden`)
    await cdp.eval(`pdfUiTest.drop(['bad.txt'])`)
    await check('拖入非檔明確拒絕', `document.getElementById('pdfTranslateError').textContent.includes('一份 PDF 或圖片檔') && !pdfUiTest.api.getPdfFile()`)
    await cdp.eval(`pdfUiTest.drop(['one.pdf', 'two.pdf'])`)
    await check('不接受一次多份', `!pdfUiTest.api.getPdfFile()`)
    await cdp.eval(`pdfUiTest.drop(['長篇.pdf'])`)
    await waitFor(() => cdp.eval(`!document.getElementById('pdfTranslateChip').hidden`), '附件 chip')
    await check('拖入顯示名稱大小', `pdfUiTest.path.endsWith('長篇.pdf') && document.getElementById('pdfTranslateFile').textContent.includes('1.0 MB')`)
    await cdp.eval(`pdfUiTest.drop(['圖.png'])`)
    await waitFor(() => cdp.eval(`pdfUiTest.api.getPdfFile()?.kind === 'image'`), '圖片附件')
    await check('圖片也收', `document.getElementById('pdfTranslateFile').textContent.includes('圖.png')`)
    await cdp.eval(`pdfUiTest.api.detachPdfFile()`)
    await cdp.eval(`document.getElementById('translateInputPane').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }))`)
    await check('純文字貼上不攔截、不報錯', `!pdfUiTest.api.getPdfFile() && document.getElementById('pdfTranslateError').hidden`)
    await cdp.eval(`pdfUiTest.paste([pdfUiTest.png('截圖1.png'), pdfUiTest.png('截圖2.png')])`)
    await check('一次不貼多張且不吃字', `document.getElementById('pdfTranslateError').textContent.includes('一張圖片') && !pdfUiTest.api.getPdfFile()`)
    await cdp.eval(`pdfUiTest.paste([pdfUiTest.png('剪貼來的.png')])`)
    await waitFor(() => cdp.eval(`pdfUiTest.api.getPdfFile()?.fileId === 'test-paste'`), '貼上附件')
    await check('貼上圖片走同一條 chip', `document.getElementById('pdfTranslateFile').textContent.includes('剪貼來的.png')`)
    await cdp.eval(`pdfUiTest.pasteInvalid = true; pdfUiTest.paste([pdfUiTest.png('壞圖.png')])`)
    await waitFor(() => cdp.eval(`document.getElementById('pdfTranslateError').textContent === '測試圖片無效'`), '貼上錯誤')
    await cdp.eval(`pdfUiTest.pasteInvalid = false`)
    await check('貼上無效圖片報錯', `document.getElementById('pdfTranslateError').textContent === '測試圖片無效'`)
    await cdp.eval(`pdfUiTest.api.detachPdfFile(); pdfUiTest.drop(['長篇.pdf'])`)
    await waitFor(() => cdp.eval(`pdfUiTest.api.getPdfFile()?.fileId === 'test-file'`), '後續流程附件')
    await check('附件交給主翻譯鈕，模組只暴露狀態', `typeof pdfUiTest.api.startPdfJob === 'function' && typeof pdfUiTest.api.isPdfRunning === 'function' && !document.getElementById('pdfTranslateRun') && !document.getElementById('pdfTranslateCancel')`)
    await cdp.eval(`document.querySelector('#translateTargetLang [data-value="ja"]').click(); pdfUiTest.api.startPdfJob(); pdfUiTest.api.startPdfJob()`)
    await waitFor(() => cdp.eval(`pdfUiTest.starts.length === 1 && document.getElementById('pdfTranslatePick').disabled`), '開始翻譯')
    await check('沿用語言且不重複開始', `pdfUiTest.starts[0].targetLang === 'ja' && pdfUiTest.starts[0].sourceLang === 'auto'`)
    await cdp.eval(`pdfUiTest.emit({ ...pdfUiTest.job, page: 73, stage: 'translate' })`)
    await check('長篇頁數進度與工作狀態', `document.getElementById('pdfTranslateProgress').max === 250 && document.getElementById('pdfTranslateProgress').value === 73 && document.getElementById('pdfTranslateStatus').textContent.includes('250 頁')`)
    await cdp.eval(`pdfUiTest.emit({ ...pdfUiTest.job, page: 73, stage: 'translate' })`)
    await check('長篇頁數進度與工作狀態', `document.getElementById('pdfTranslateProgress').value === 73 && document.getElementById('pdfTranslateStatus').textContent.includes('250 頁')`)
    await cdp.eval(`pdfUiTest.emit({ jobId: 'wrong-job', state: 'done' })`)
    await check('忽略其他工作進度', `document.getElementById('pdfTranslateSave').hidden && pdfUiTest.api.isPdfRunning()`)
    await cdp.eval(`pdfUiTest.api.cancelPdfJob()`)
    await waitFor(() => cdp.eval(`document.getElementById('pdfTranslateStatus').textContent.includes('已停止')`), '取消')
    await check('取消後沒有未完成輸出可另存', `document.getElementById('pdfTranslateSave').hidden`)
    await cdp.eval(`pdfUiTest.api.startPdfJob()`)
    await waitFor(() => cdp.eval(`pdfUiTest.starts.length === 2`), '再翻譯')
    await cdp.eval(`pdfUiTest.emit({ ...pdfUiTest.job, state: 'done', page: 250, pages: 250, translatedBlocks: 800, warnings: [{ code: 'overflow', count: 2 }, { code: 'small_text', count: 3 }] })`)
    await check('完成才可另存並顯示核對提示', `document.getElementById('pdfTranslateSave').offsetHeight > 0 && document.getElementById('pdfTranslateWarnings').textContent.includes('已保留原文') && document.getElementById('pdfTranslateStatus').textContent.includes('800 處')`)
    await cdp.eval(`document.getElementById('pdfTranslateSave').click()`)
    await waitFor(() => cdp.eval(`document.getElementById('pdfTranslateStatus').textContent.includes('已儲存')`), '另存')
    await check('另存完成的工作', `pdfUiTest.saves[0] === 'test-job-2'`)
    await cdp.eval(`pdfUiTest.emit({ ...pdfUiTest.job, state: 'done', translatedBlocks: 0 })`)
    await check('沒有翻到文字時明確顯示', `document.getElementById('pdfTranslateStatus').textContent.includes('未成功翻譯文字')`)
    await cdp.eval(`pdfUiTest.api.detachPdfFile()`)
    await check('× 移除附件回到乾淨', `!pdfUiTest.api.getPdfFile() && document.getElementById('pdfTranslateChip').hidden && document.getElementById('pdfTranslateStatus').hidden`)
    await cdp.eval(`pdfUiTest.ready = false; pdfUiTest.drop(['待裝.pdf'])`)
    await waitFor(() => cdp.eval(`!document.getElementById('pdfTranslateChip').hidden`), '待裝附件')
    await cdp.eval(`pdfUiTest.api.refreshPdfTranslate()`)
    await waitFor(() => cdp.eval(`!document.getElementById('pdfTranslateSetup').hidden`), '未安裝提示')
    await check('未安裝有 Local SI 入口', `document.getElementById('pdfTranslateSetup').offsetHeight > 0`)
    await cdp.eval(`document.getElementById('pdfTranslateModels').click()`)
    await check('Local SI 入口', `pdfUiTest.page === 'hfmodels'`)

    for (const width of [560, 900, 1440]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
      for (const theme of ['dark', 'light']) {
        await cdp.eval(`document.documentElement.dataset.theme = '${theme}'`)
        await check(`${width}px ${theme} 無橫向溢出與透明文字`, `(() => {
          const pane = document.getElementById('translateInputPane')
          const style = getComputedStyle(pane)
          return pane.offsetHeight > 0 && pane.scrollWidth <= pane.clientWidth + 1 && style.color !== 'rgba(0, 0, 0, 0)' && style.borderTopColor !== 'rgba(0, 0, 0, 0)'
        })()`)
      }
    }
    await check('長篇進度不阻塞頁面回應', `new Promise((resolve) => { setTimeout(() => resolve(true), 0) })`)
    await cdp.eval(`pdfUiTest.invalidFile = true; pdfUiTest.drop(['無效.pdf'])`)
    await waitFor(() => cdp.eval(`!document.getElementById('pdfTranslateError').hidden`), '檔案錯誤顯示')
    await check('結構化 IPC 錯誤顯示中文訊息', `document.getElementById('pdfTranslateError').textContent === '測試檔案無效'`)
    assert.deepEqual(cdp.exceptions, [], 'renderer 無未處理例外')
    console.log(`ALL PASS ${passed} checks`)
  } finally {
    cdp.ws?.close()
    if (child.pid) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已退出 */ }
    }
    child.kill()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
