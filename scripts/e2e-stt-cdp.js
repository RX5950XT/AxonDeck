/**
 * 打包版 CDP：語音轉文字合併頁 ＋ 設定頁四分區 ＋ 語音試聽
 * 用法：node scripts/e2e-stt-cdp.js（會自己啟動 dist/win-unpacked/AxonDeck.exe）
 *
 * 這支會改到三個子分頁各自的模型選擇（`fileAsr`／`fileLlm`／`liveAsr`／`liveLlm`／
 * `dictationAsr`）與翻譯頁的全域那組，**開頭先讀下來、finally 一定寫回**，
 * 不留下測試痕跡在使用者的設定裡。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9243
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 AXONDECK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = tempDir('axondeck-cdp-')
const RESTORE_KEYS = [
  'fileAsr', 'fileLlm', 'liveAsr', 'liveLlm', 'dictationAsr',
  'translator', 'localTranslateModel'
]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
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
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await action()) return true
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, '--hidden'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let processLog = ''
  child.stdout.on('data', (c) => { processLog += c })
  child.stderr.on('data', (c) => { processLog += c })

  let cdp = null
  let original = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) }
    else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
  }

  try {
    const target = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        const page = pages.filter((p) => p.type === 'page').find((p) => /index\.html/.test(p.url))
        if (page) return page
        await sleep(400)
      }
      throw new Error('等不到主視窗')
    })()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.eval("window.electronAPI.store.set('sysmonSensors', false)")
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.store?.get === 'function'`),
      15000, 'preload 初始化'
    )

    original = await cdp.eval(`(async () => {
      const keys = ${JSON.stringify(RESTORE_KEYS)}
      const out = {}
      for (const k of keys) out[k] = await window.electronAPI.store.get(k, null)
      return out
    })()`)
    console.log(`（已備份使用者設定：${JSON.stringify(original)}）`)

    // ---- 合併頁結構 ----
    await cdp.eval(`document.querySelector('[data-page="stt"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.getElementById('fileAsrModel')?.options.length`), 10000, '模型選單填好')

    const layout = await cdp.eval(`(() => ({
      noSubtabs: document.querySelectorAll('#sttSubtabs .subtab').length === 0,
      noHeader: !document.querySelector('#page-stt .page-header'),
      hasDropZone: !!document.querySelector('#stt-file #dropZone'),
      hasRecorder: !!document.querySelector('#stt-file #recList'),
      noRecordingPick: !document.getElementById('recordingPickGroup'),
      liveSources: [...(document.getElementById('liveAudioSource')?.options || [])].map((o) => o.value),
      hasLiveBtn: !!document.querySelector('#stt-file #startLiveBtn'),
      hasDictation: !!document.querySelector('#stt-dictation #dictationEnabledInput'),
      dictVisible: (document.getElementById('dictationEnabledInput')?.offsetHeight || 0) > 0,
      dropVisible: (document.getElementById('dropZone')?.offsetHeight || 0) > 0,
      noOldNav: !document.querySelector('[data-page="transcribe"], [data-page="live"]'),
      noOldSections: !document.getElementById('page-transcribe') && !document.getElementById('page-live')
    }))()`)
    ok(
      '轉錄、字幕、語音輸入在同一頁，沒有標題列和子分頁',
      layout?.noSubtabs && layout.noHeader &&
        layout.hasDropZone && layout.hasRecorder && layout.noRecordingPick &&
        JSON.stringify(layout.liveSources) === JSON.stringify(['system', 'mic', 'both']) &&
        layout.hasLiveBtn && layout.hasDictation && layout.dictVisible && layout.dropVisible &&
        layout.noOldNav && layout.noOldSections,
      JSON.stringify(layout)
    )

    // 共用模型在轉錄這側，語音輸入的模型在自己那一區（不在頁面標題列）
    const bars = await cdp.eval(`(() => {
      const inPanel = (panelId, selectId) => {
        const panel = document.getElementById(panelId)
        const sel = document.getElementById(selectId)
        return !!panel && !!sel && panel.contains(sel)
      }
      return {
        fileAsr: inPanel('stt-file', 'fileAsrModel'),
        fileLlm: inPanel('stt-file', 'fileLlmModel'),
        lang: inPanel('stt-file', 'liveLanguage'),
        source: inPanel('stt-file', 'liveAudioSource'),
        dictAsr: inPanel('stt-dictation', 'dictationAsrModel'),
        dictLlm: inPanel('stt-dictation', 'dictationLlmSelect'),
        noSharedBar: !document.getElementById('sttModelBar') && !document.getElementById('sttModelHint'),
        headerHasNoSelect: !document.querySelector('#page-stt .page-header select'),
        translateInsideHeader: !!document.querySelector('#page-translate .page-header #translateModelBar')
      }
    })()`)
    ok('轉錄頁有共用的辨識、翻譯、目標語言，語音輸入另有自己的',
      bars?.fileAsr && bars.fileLlm && bars.lang && bars.source && bars.dictAsr && bars.dictLlm,
      JSON.stringify(bars))
    ok('標題旁不再有共用的模型選單',
      bars?.noSharedBar && bars.headerHasNoSelect && bars.translateInsideHeader, JSON.stringify(bars))

    ok('拖入音訊時仍有目標回饋', await cdp.eval(`(() => {
      const zone = document.getElementById('dropZone')
      const transition = zone.style.transition
      zone.style.transition = 'none'
      const before = getComputedStyle(zone).backgroundColor
      zone.classList.add('dragover')
      const after = getComputedStyle(zone).backgroundColor
      zone.classList.remove('dragover')
      zone.style.transition = transition
      return before !== after
    })()`))

    for (const width of [1440, 1000, 760, 560]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
      const size = await cdp.eval(`(() => {
        const content = document.querySelector('.content')
        content.scrollTop = 0
        const board = document.querySelector('.stt-board')
        return {
          height: board.offsetHeight, overflow: content.scrollWidth > content.clientWidth + 1,
          columns: getComputedStyle(board).gridTemplateColumns.split(' ').length,
          actions: ['.stt-drop', '.stt-rec-hero', '.stt-live-card'].map((s) => {
            const r = document.querySelector(s).getBoundingClientRect()
            return { width: r.width, top: r.top }
          }),
          records: ['.stt-txlog', '.stt-recs', '.stt-column > .live-history'].map((s) => {
            const r = document.querySelector(s).getBoundingClientRect()
            return { width: r.width, top: r.top, height: r.height }
          }),
          dict: [...document.querySelectorAll('.stt-dict .dict-panel')].map((e) => e.offsetHeight),
          dictTitle: document.querySelector('.stt-dict .dict-panel h3').textContent,
          noLiveHints: !document.getElementById('liveCaptionDisplayGroup') && !document.getElementById('liveTranslatorHint'),
          controls: ['recStartBtn', 'startLiveBtn', 'recStatus', 'liveStatus', 'recAudioSource', 'liveAudioSource'].map((id) => {
            const element = document.getElementById(id)
            const visible = element.tagName === 'SELECT' ? element.closest('.custom-select').querySelector('.custom-select-trigger') : element
            const r = visible.getBoundingClientRect()
            return { width: r.width, height: r.height, top: r.top }
          }),
          groups: document.querySelectorAll('.stt-board > .stt-column').length,
          gap: parseFloat(getComputedStyle(board).columnGap),
          grouped: [['dropZone', 'resultText'], ['recStartBtn', 'recList'], ['startLiveBtn', 'liveHistoryList']].every(([top, bottom]) =>
            document.getElementById(top).closest('.stt-column') === document.getElementById(bottom).closest('.stt-column')),
          rect: { x: content.getBoundingClientRect().x + 20, y: 400 }
        }
      })()`)
      ok(`${width}px 語音頁留足閱讀高度、沒有橫向溢出`,
        size.height > 1000 && size.records.every((r) => r.height >= 440) && !size.overflow &&
        size.columns === (width > 900 ? 3 : 1) && size.dict.every((h) => h >= 560) &&
        size.dictTitle === '語音輸入紀錄' && size.noLiveHints && size.groups === 3 &&
        size.gap === 12 && size.grouped, JSON.stringify(size))
      if (width > 900) {
        const equalRow = (items) => items.every((r) =>
          Math.abs(r.width - items[0].width) < 1 && Math.abs(r.top - items[0].top) < 1)
        ok(`${width}px 開始區與紀錄區各自等寬並排`, equalRow(size.actions) && equalRow(size.records), JSON.stringify(size))
        const [rec, live, recStatus, liveStatus, recSource, liveSource] = size.controls
        ok(`${width}px 錄音與字幕按鈕等大，狀態與音源對齊`,
          equalRow([rec, live]) && Math.abs(rec.height - live.height) < 1 &&
          Math.abs(recStatus.top - liveStatus.top) < 1 && Math.abs(recSource.top - liveSource.top) < 1,
          JSON.stringify(size.controls))
      }
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: size.rect.x, y: size.rect.y, deltaX: 0, deltaY: 10000
      })
      await waitFor(() => cdp.eval('document.querySelector(".content").scrollTop > 0'), 5000, '語音頁滾輪')
      ok(`${width}px 真滾輪可到最下方的個人字典`, await cdp.eval(`(() => {
        const content = document.querySelector('.content')
        const panel = document.getElementById('dictationTerms').getBoundingClientRect()
        const bottom = content.getBoundingClientRect().bottom
        return content.scrollTop > 0 && panel.bottom <= bottom + 1 && panel.bottom > 0
      })()`))
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await cdp.eval('document.querySelector(".content").scrollTop = 0')

    // ---- 模型選單：選了要寫回自己那一個 store key ----
    const asrValues = await cdp.eval(
      `[...document.getElementById('fileAsrModel').options].map((o) => o.value)`
    )
    // 雲端那幾項是「每一組設定的每一顆轉錄模型」，所以數量跟使用者設定有關；
    // 這裡只確認兩顆本地在前、後面至少有一個雲端項
    ok(
      'ASR 選單同時列出兩顆本地模型與雲端',
      asrValues[0] === 'local:qwen3asr' && asrValues[1] === 'local:qwen3asrgpu'
        && asrValues.slice(2).every((v) => v.startsWith('cloud'))
        && asrValues.length >= 3,
      JSON.stringify(asrValues)
    )

    const wroteGpu = await cdp.eval(`(async () => {
      const sel = document.getElementById('fileAsrModel')
      sel.value = 'local:qwen3asrgpu'
      sel.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 500))
      return await window.electronAPI.store.get('fileAsr', null)
    })()`)
    ok('選 GPU 模型會同時寫回 fileAsr 與 liveAsr', wroteGpu === 'local:qwen3asrgpu', String(wroteGpu))

    // 轉錄與即時字幕共用一份；語音輸入仍分開
    const isolated = await cdp.eval(`(async () => {
      const set = async (id, value) => {
        const sel = document.getElementById(id)
        sel.value = value
        sel.dispatchEvent(new Event('change'))
        await new Promise((r) => setTimeout(r, 400))
      }
      await set('dictationAsrModel', 'local:qwen3asr')
      await set('fileLlmModel', 'local:linguaforge08q4')
      const keys = ['fileAsr', 'liveAsr', 'dictationAsr', 'fileLlm', 'liveLlm']
      const out = {}
      for (const k of keys) out[k] = await window.electronAPI.store.get(k, null)
      return out
    })()`)
    ok(
      '辨識模型寫下去，即時字幕跟著走，語音輸入不動',
      isolated?.fileAsr === 'local:qwen3asrgpu' && isolated?.liveAsr === 'local:qwen3asrgpu' &&
        isolated?.dictationAsr === 'local:qwen3asr',
      JSON.stringify(isolated)
    )
    ok(
      '翻譯模型也是檔案與即時字幕同一份',
      isolated?.fileLlm === 'local:linguaforge08q4' && isolated?.liveLlm === 'local:linguaforge08q4',
      JSON.stringify(isolated)
    )

    // ---- 翻譯與 TTS 頁是另一組（全域 key），不被子分頁的選擇帶著跑 ----
    const translatePage = await cdp.eval(`(async () => {
      await window.electronAPI.store.set('translator', 'local')
      await window.electronAPI.store.set('localTranslateModel', 'linguaforge08q4')
      document.querySelector('[data-page="translate"]').click()
      await new Promise((r) => setTimeout(r, 900))
      return document.getElementById('translatePageModel')?.value || ''
    })()`)
    ok('翻譯與 TTS 頁用自己的全域設定（不跟子分頁共用）',
      translatePage === 'local:linguaforge08q4', String(translatePage))

    // 回語音轉文字頁，確認重讀後畫面跟 store 對得上
    const reread = await cdp.eval(`(async () => {
      document.querySelector('[data-page="stt"]').click()
      await new Promise((r) => setTimeout(r, 900))
      return {
        file: document.getElementById('fileAsrModel')?.value || '',
        dict: document.getElementById('dictationAsrModel')?.value || ''
      }
    })()`)
    ok('重新進頁時共用選單與語音輸入各自讀回自己的值',
      reread?.file === 'local:qwen3asrgpu' && reread?.dict === 'local:qwen3asr',
      JSON.stringify(reread))

    // ---- 未安裝的模型要標出來 ----
    const notReady = await cdp.eval(`(async () => {
      const status = await window.electronAPI.models.status()
      const missing = Object.values(status.models).filter((m) => !m.downloaded).map((m) => m.key)
      document.querySelector('[data-page="translate"]').click()
      await new Promise((r) => setTimeout(r, 700))
      const labels = [...document.getElementById('translatePageModel').options].map((o) => o.textContent)
      return { missing, marked: labels.filter((l) => l.includes('未安裝')).length }
    })()`)
    ok(
      '未安裝的本地模型在選單裡標「未安裝」',
      notReady?.missing.length === 0 || notReady?.marked > 0,
      JSON.stringify(notReady)
    )

    // 先載入推薦清單，再驗模型管理已搬離設定頁。
    await cdp.eval("document.querySelector('[data-page=hfmodels]').click()")
    for (let i = 0; i < 50; i++) {
      await cdp.eval("document.querySelector('#hfSubtabs [data-subtab=recommend]').click()")
      if (await cdp.eval('document.querySelectorAll("#modelList .model-item").length === 4')) break
      await sleep(200)
    }
    await waitFor(() => cdp.eval('document.querySelectorAll("#hf-recommend .model-item").length === 4'), 15000, '推薦模型清單')
    // ---- 設定頁四分區 ----
    await cdp.eval(`document.querySelector('[data-page="settings"]').click(), 'ok'`)
    await sleep(900)
    const settings = await cdp.eval(`(() => {
      const sections = [...document.querySelectorAll('#settingsNav .settings-nav-item')]
      return {
        order: sections.map((b) => b.dataset.section),
        titles: sections.map((b) => b.textContent.trim()),
        // 後端 segmented 與本地模型 segmented 都已移除
        removed: !document.getElementById('translatorSegment') &&
          !document.getElementById('asrEngineSegment') &&
          !document.getElementById('localTranslateModelSegment'),
        // 推論設定留在本地模型分區
        gpuInLocal: !document.getElementById('llmGpuSegment'),
        // ASR 的推論方式跟著模型走，不再有執行緒選項
        noThreads: !document.getElementById('asrThreadsSegment'),
        // 模型清單依 kind 分組
        groups: [...document.querySelectorAll('#hf-recommend .model-group-title')].map((el) => el.textContent),
        modelListInLocal: !!document.querySelector('#hf-recommend #modelList'),
        // 三組雲端端點都在雲端模型分區
        cloudChat: !!document.querySelector('#set-cloud #chatApiUrlInput'),
        // 翻譯與聊天共用同一組供應商，不再有第二份 URL／Key 欄位
        noSeparateTranslate: !document.getElementById('apiUrlInput') && !document.getElementById('modelIdInput'),
        cloudAsr: !!document.querySelector('#set-cloud #asrApiUrlInput')
      }
    })()`)
    ok(
      '設定頁四個分區且順序正確',
      JSON.stringify(settings?.order) === JSON.stringify(['cloud', 'voice', 'basic', 'cli']) &&
        settings.titles[0].includes('雲端模型') && settings.titles[1].includes('語音朗讀') && settings.titles[2].includes('基本') && settings.titles[3].includes('CLI'),
      JSON.stringify(settings?.titles)
    )
    ok('設定頁沒有手動 GPU 開關，模型清單已搬進推薦',
      settings?.removed && settings.gpuInLocal && settings.noThreads && settings.modelListInLocal,
      JSON.stringify(settings))
    ok('推薦模型清單依語音辨識／翻譯分組',
      JSON.stringify(settings?.groups) === JSON.stringify(['語音辨識', '翻譯']),
      JSON.stringify(settings?.groups))
    ok('雲端翻譯併入聊天供應商（沒有第二份端點欄位）',
      settings?.noSeparateTranslate === true,
      JSON.stringify(settings))
    ok('共用供應商與語音轉文字端點都在「雲端模型」',
      settings?.cloudChat && settings.cloudAsr, JSON.stringify(settings))

    // ---- 語音試聽 ----
    await cdp.eval(`document.querySelector('#settingsNav [data-section="voice"]').click(), 'ok'`)
    await sleep(500)
    const previewUi = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('.tts-preview-btn')]
      return {
        count: btns.length,
        langs: btns.map((b) => b.dataset.ttsPreview),
        // 每顆鈕都要跟同一列的下拉在一起
        pairedWithSelect: btns.every((b) => !!b.closest('.tts-voice-row')?.querySelector('select[data-tts-lang]')),
        hasApi: typeof window.electronAPI.tts.preview === 'function'
      }
    })()`)
    ok(
      '五種語言都有試聽鈕且接得到 IPC',
      previewUi?.count === 5 && previewUi.pairedWithSelect && previewUi.hasApi &&
        JSON.stringify(previewUi.langs) === JSON.stringify(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
      JSON.stringify(previewUi)
    )

    // 真的合成一次（需連網；失敗只記 SKIP 不算錯）
    const preview = await cdp.eval(`(async () => {
      try {
        const r = await window.electronAPI.tts.preview('zh-TW', document.getElementById('ttsVoiceZhTw').value, 0)
        return { ok: true, bytes: r?.data?.length || 0, mime: r?.mime || '' }
      } catch (e) { return { ok: false, message: String(e.message || e) } }
    })()`)
    if (preview?.ok) {
      ok('試聽真的合成出音訊', preview.bytes > 1000 && /audio/.test(preview.mime), JSON.stringify(preview))
    } else {
      console.log(`SKIP  試聽需連網：${preview?.message}`)
    }

    // 白名單：不在清單裡的語音要退回該語言預設，而不是原樣送出去
    const badVoice = await cdp.eval(`(async () => {
      try {
        const r = await window.electronAPI.tts.preview('zh-TW', 'evil-voice-Neural', 0)
        return { ok: true, bytes: r?.data?.length || 0 }
      } catch (e) { return { ok: false, message: String(e.message || e) } }
    })()`)
    ok('非白名單語音不會被原樣送出（退回預設或明確失敗）',
      badVoice?.ok ? badVoice.bytes > 1000 : true, JSON.stringify(badVoice))

    ok('renderer 無未處理例外', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions))
  } catch (error) {
    failed++
    console.error(`\n未預期例外：${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Process log:', processLog.slice(-4000))
  } finally {
    if (cdp && original) {
      try {
        await cdp.eval(`(async () => {
          const orig = ${JSON.stringify(original)}
          for (const [k, v] of Object.entries(orig)) {
            if (v !== null) await window.electronAPI.store.set(k, v)
          }
          return 'ok'
        })()`)
        console.log(`（已還原使用者設定：${JSON.stringify(original)}）`)
      } catch (e) {
        console.error('還原設定失敗：', e)
      }
    }
    cdp?.close()
    if (child.pid) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已退出 */ }
    }
    try { child.kill() } catch { /* 已退出 */ }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
