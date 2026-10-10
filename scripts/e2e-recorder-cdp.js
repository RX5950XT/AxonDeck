/**
 * 打包版 CDP：錄音機子分頁 ＋ 檔案轉錄接錄音 ＋ 即時字幕的紀錄
 * 用法：node scripts/e2e-recorder-cdp.js（會自己啟動 dist/win-unpacked/AxonDeck.exe）
 *
 * 暫存 user-data-dir ＋ Chromium 假麥克風（`--use-fake-device-for-media-stream`，一段 beep），
 * 不碰使用者的錄音與設定。錄出來的檔再用 ffmpeg 量一次「真的是 opus、解得出聲音」。
 * 字幕用測試音源走 PCM／VAD／ASR IPC，由本機測試伺服器回字；另驗字幕紀錄操作。
 */
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { tempDir } = require('./lib/test-temp')

const PORT = 9247
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'AxonDeck.exe')
const USER_DATA_DIR = tempDir('axondeck-rec-cdp-')
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false }))
/** 設了才截圖（會把視窗秀出來，不搶焦點但看得到） */
const SHOT_DIR = process.env.AXONDECK_SHOT_DIR || ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = []; this.logs = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (msg.method === 'Runtime.consoleAPICalled' && /error|warn/.test(msg.params.type)) {
        this.logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
      }
      if (!msg.id || !this.pending.has(msg.id)) return
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
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
    // userGesture：AudioContext 沒有使用者手勢會停在 suspended（音量條永遠 0）
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  /** 只在設了 AXONDECK_SHOT_DIR 時截（那時才秀視窗；--hidden 的視窗不出畫面，截圖會一直等） */
  async shot(name) {
    if (!SHOT_DIR) return
    const r = await Promise.race([
      this.send('Page.captureScreenshot', { format: 'png' }),
      sleep(8000).then(() => null)
    ])
    if (!r) return console.log(`      截圖逾時 ${name}`)
    const file = path.join(SHOT_DIR, name)
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log(`      截圖 ${file}`)
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await action()) return true
    await sleep(250)
  }
  throw new Error(`等待逾時：${label}`)
}

/** 用 ffmpeg 解一次：編碼是不是 opus、解出來的 PCM 有沒有東西 */
function probeWebm(file) {
  const ffmpeg = require('ffmpeg-static')
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], {
    maxBuffer: 64 * 1024 * 1024
  })
  const samples = Array.from({ length: Math.floor((r.stdout?.length || 0) / 2) }, (_, i) => r.stdout.readInt16LE(i * 2) / 32768).slice(-16000)
  return { opus: /Audio: opus/.test(String(r.stderr)), pcmBytes: r.stdout?.length || 0, levels: frequencyLevels(samples) }
}

function frequencyLevels(samples) {
  return [440, 880].map((frequency) => {
    let sin = 0, cos = 0
    samples.forEach((v, i) => {
      const phase = 2 * Math.PI * frequency * i / 16000
      sin += v * Math.sin(phase); cos += v * Math.cos(phase)
    })
    return 2 * Math.hypot(sin, cos) / (samples.length || 1)
  })
}

async function main() {
  const asrRequests = []
  const asrServer = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      try {
        const body = JSON.parse(raw), wav = Buffer.from(body.input_audio.data, 'base64')
        const samples = Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768)
        asrRequests.push({ levels: frequencyLevels(samples), rate: wav.readUInt32LE(24) })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ text: `字幕音源驗證成功${asrRequests.length}` }))
      } catch { response.writeHead(400); response.end('{}') }
    })
  })
  await new Promise((resolve) => asrServer.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${asrServer.address().port}/v1`
  fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({
    sysmonSensors: false, dictationEnabled: false, sttLanguage: 'auto',
    asrClouds: [{ id: 'qa', name: '測試', apiUrl, apiKey: 'test-only', models: ['test-asr'] }],
    chatProviders: [{ id: 'qa', name: '測試', apiUrl, apiKey: 'test-only', models: ['test-llm'] }],
    fileAsr: 'cloud:qa:test-asr', liveAsr: 'cloud:qa:test-asr',
    fileLlm: 'cloud:qa:test-llm', liveLlm: 'cloud:qa:test-llm'
  }))
  const child = spawn(EXE, [
    // 不秀視窗、不搶焦點（跟 e2e-app-dialog-cdp 同一套）；要截圖才秀
    ...(SHOT_DIR ? [] : ['--hidden']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    // 視窗被使用者的其他視窗蓋住時 Chromium 不出畫面，<dialog> 的 close 事件就排不到
    '--disable-backgrounding-occluded-windows'
  ], { detached: true, stdio: 'ignore' })

  let cdp = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) } else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
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
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!window.electronAPI?.sttArchive`), 15000, 'preload')
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    // ---- 錄音機 ----
    await cdp.eval(`document.querySelector('[data-page="stt"]').click(), 'ok'`)
    // 子分頁的 click 是 stt-page.js 動態載入後才掛上的
    await waitFor(() => cdp.eval(`!!document.getElementById('fileAsrModel')?.options.length`), 10000, '語音轉文字頁載入')
    await waitFor(() => cdp.eval(`!!document.querySelector('#recList .dict-empty')`), 10000, '錄音清單畫好（空）')
    ok('檔案與錄音同一頁：轉入區與錄音清單都在', await cdp.eval(`(() => {
      const file = document.getElementById('stt-file')
      const drop = document.getElementById('dropZone')
      const rec = document.getElementById('stt-recorder')
      return file?.contains(drop) && file?.contains(rec) &&
        drop.offsetHeight > 0 && rec.offsetHeight > 0 &&
        !document.getElementById('recordingPickGroup')
    })()`))
    await cdp.shot('rec-empty.png')

    await cdp.eval(`document.getElementById('recStartBtn').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.getElementById('recStatus').classList.contains('active')`), 8000, '開始錄音')
    // 假麥克風一秒才嗶一下、其餘靜音：錄音期間一直量，取最大值
    let peak = 0
    for (let i = 0; i < 26; i++) {
      peak = Math.max(peak, await cdp.eval(`parseFloat(document.getElementById('recLevel').style.width) || 0`))
      await sleep(100)
    }
    const during = await cdp.eval(`({
      timer: document.getElementById('recTimer').textContent,
      level: ${peak},
      stopShown: document.getElementById('recStopBtn').offsetHeight > 0,
      startHidden: document.getElementById('recStartBtn').offsetHeight === 0
    })`)
    ok('錄音中：計時在走、停止鈕出現', during.timer !== '00:00' && during.stopShown && during.startHidden, JSON.stringify(during))
    ok('錄音中：音量條有動（假麥克風是 beep）', during.level > 0, JSON.stringify(during))
    await cdp.shot('rec-recording.png')

    await cdp.eval(`document.getElementById('recStopBtn').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('#recList .rec-item').length === 1`), 10000, '清單出現一筆')
    const recName = await cdp.eval(`document.querySelector('#recList .rec-item').dataset.name`)
    const recFile = path.join(USER_DATA_DIR, 'recordings', recName)
    ok('錄音檔落在 userData/recordings', /^rec-\d{13}\.webm$/.test(recName) && fs.existsSync(recFile))
    const probe = probeWebm(recFile)
    if (!probe.opus && process.env.AXONDECK_SHOT_DIR) fs.copyFileSync(recFile, path.join(process.env.AXONDECK_SHOT_DIR, 'bad.webm'))
    // 16kHz s16 mono ＝ 32000 bytes/秒；錄了約 2.6 秒，至少要有 1.5 秒
    ok('ffmpeg 解得開：opus 且約兩秒以上的聲音', probe.opus && probe.pcmBytes > 48000, JSON.stringify(probe))
    await cdp.shot('rec-list.png')

    await cdp.eval(`document.querySelector('#recList .rec-item [data-act="play"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#recList audio')?.src`), 8000, '播放器')
    ok('播放：audio 讀得到長度', await waitFor(
      () => cdp.eval(`(() => { const a = document.querySelector('#recList audio'); return a && a.readyState >= 1 })()`),
      8000, 'audio metadata'
    ))

    // ---- 轉錄鈕：同一頁左欄帶入 ----
    await cdp.eval(`document.querySelector('#recList .rec-item [data-act="transcribe"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`document.getElementById('page-stt').classList.contains('active') && document.querySelector('#fileInfo .file-name').textContent === ${JSON.stringify(recName)}`), 8000, '轉錄鈕帶入檔案')
    ok('轉錄鈕：檔案帶進來、開始轉錄鈕可按', await cdp.eval(`(() =>
      !document.getElementById('fileInfo').classList.contains('hidden') &&
      !document.getElementById('transcribeOptions').classList.contains('hidden') &&
      document.getElementById('dropZone').classList.contains('hidden')
    )()`))

    // 清掉之後改拖同一筆。拖曳資料只有檔名，沒有路徑
    await cdp.eval(`document.getElementById('clearFileBtn').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!document.getElementById('dropZone').classList.contains('hidden')`), 5000, '轉入區回到可拖')
    await cdp.eval(`(() => {
      const row = document.querySelector('#recList .rec-item')
      const zone = document.getElementById('sttFileCol')
      const dt = new DataTransfer()
      dt.setData('application/x-axondeck-recording', row.dataset.name)
      dt.setData('text/plain', row.dataset.name)
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      return 'ok'
    })()`)
    await waitFor(() => cdp.eval(`document.querySelector('#fileInfo .file-name').textContent === ${JSON.stringify(recName)}`), 8000, '拖錄音到轉入區')
    ok('拖錄音檔到轉入區就等於選了該檔', await cdp.eval(`(() =>
      !document.getElementById('fileInfo').classList.contains('hidden') &&
      !document.getElementById('transcribeOptions').classList.contains('hidden') &&
      !document.getElementById('recordingPickGroup')
    )()`))
    await cdp.shot('file-pick.png')
    await cdp.eval(`document.getElementById('clearFileBtn').click(), 'ok'`)

    // ---- 字幕紀錄 ----
    const liveId = await cdp.eval(`(async () => {
      const id = 'live-' + (Date.now() - 125000)
      const api = window.electronAPI.sttArchive
      await api.appendTranscript(id, { key: 'b-1-1', source: 'Hello everyone', translation: '' })
      await api.appendTranscript(id, { key: 'b-1-2', source: 'Welcome back', translation: '歡迎回來' })
      await api.appendTranscript(id, { key: 'b-1-1', source: 'Hello everyone', translation: '大家好' })
      return id
    })()`)
    await cdp.eval(`import('./scripts/live-history.js').then((m) => m.refreshLiveHistory())`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('#liveHistoryList .rec-item').length === 1`), 8000, '字幕紀錄一筆')
    const meta = await cdp.eval(`document.querySelector('#liveHistoryList .dict-record-time').textContent`)
    ok('字幕紀錄：句數與長度', /2 句/.test(meta) && /分鐘/.test(meta), meta)
    await cdp.eval(`document.querySelector('#liveHistoryList [data-act="view"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#liveHistoryList .live-history-body')`), 5000, '展開')
    const body = await cdp.eval(`[...document.querySelectorAll('#liveHistoryList .live-history-body p')].map((p) => p.textContent)`)
    ok('展開看得到原文＋譯文，後寫的譯文蓋掉空的', JSON.stringify(body) === JSON.stringify(['Hello everyone', '大家好', 'Welcome back', '歡迎回來']), JSON.stringify(body))
    ok('字幕紀錄面板量得到高度', await cdp.eval(`document.querySelector('.live-history').offsetHeight > 60`))
    await cdp.eval(`document.querySelector('.live-history').scrollIntoView({ block: 'end' }), 'ok'`)
    await cdp.shot('live-history.png')

    // v1.39.3 起刪除不再跳確認框，按了就刪
    await cdp.eval(`document.querySelector('#liveHistoryList [data-act="delete"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#liveHistoryList .dict-empty')`), 5000, '刪掉後變空')
    ok('字幕紀錄刪得掉（檔案也不在了）', !fs.existsSync(path.join(USER_DATA_DIR, 'live-transcripts', `${liveId}.jsonl`)))

    await cdp.eval(`import('./scripts/recorder.js').then((m) => m.refreshRecorderPage())`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('#recList .rec-item').length === 1`), 5000, '回到錄音清單')
    await cdp.eval(`document.querySelector('#recList [data-act="delete"]').click(), 'ok'`)
    await waitFor(() => cdp.eval(`!!document.querySelector('#recList .dict-empty')`), 5000, '錄音刪掉後變空')
    ok('錄音刪得掉', !fs.existsSync(recFile))

    const loopback = await cdp.eval(`(async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } })
        const audio = stream.getAudioTracks().filter(t => t.readyState === 'live').length
        stream.getTracks().forEach(t => t.stop())
        return { audio, closed: stream.getTracks().every(t => t.readyState === 'ended') }
      } catch (e) { return { error: e.name } }
    })()`)
    ok('實際系統 loopback 可取得音軌並關閉（不存聲音）', loopback.audio > 0 && loopback.closed, JSON.stringify(loopback))

    // 真 Chromium 音軌與 MediaRecorder；以兩個已知頻率區分音源，避免空檔也算混音成功。
    await cdp.eval(`(() => {
      window.__recTest = { originalMic: navigator.mediaDevices.getUserMedia, originalSystem: navigator.mediaDevices.getDisplayMedia, contexts: [], streams: [], calls: [] }
      const tone = async (hz, video) => {
        const context = new AudioContext()
        const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination()
        oscillator.frequency.value = hz; gain.gain.value = 0.2
        oscillator.connect(gain).connect(destination); oscillator.start(); await context.resume()
        if (window.__recTest.burst) gain.gain.setValueAtTime(0, context.currentTime + 2.6)
        const stream = destination.stream
        if (video) stream.addTrack(document.createElement('canvas').captureStream(1).getVideoTracks()[0])
        window.__recTest.contexts.push(context); window.__recTest.streams.push(stream)
        return stream
      }
      navigator.mediaDevices.getDisplayMedia = async (opts) => { window.__recTest.calls.push('system'); if (!opts.audio) throw Error('missing audio'); return tone(440, true) }
      navigator.mediaDevices.getUserMedia = async () => { window.__recTest.calls.push('mic'); return tone(880, false) }
      window.__recTest.toneMic = navigator.mediaDevices.getUserMedia
    })()`)
    ok('錄音音源有三種、預設麥克風', await cdp.eval(`JSON.stringify([...document.getElementById('recAudioSource').options].map(o=>o.value)) === JSON.stringify(['system','mic','both']) && document.getElementById('recAudioSource').value === 'mic'`))
    for (const source of ['system', 'mic', 'both']) {
      await cdp.eval(`(() => {
        window.__recTest.calls = []; window.__recTest.streams = []
        const select = document.getElementById('recAudioSource'); select.value = ${JSON.stringify(source)}; select.dispatchEvent(new Event('change'))
      })()`)
      await waitFor(() => cdp.eval(`window.electronAPI.store.get('recAudioSource')`).then((v) => v === source), 5000, '記住錄音音源')
      await cdp.eval(`document.getElementById('recStartBtn').click()`)
      await waitFor(() => cdp.eval(`document.getElementById('recStatus').classList.contains('active')`), 8000, `開始 ${source}`)
      ok(`${source} 錄音期間鎖住音源`, await cdp.eval(`document.getElementById('recAudioSource').disabled`))
      await sleep(2200)
      await cdp.eval(`document.getElementById('recStopBtn').click()`)
      await waitFor(() => cdp.eval(`document.querySelectorAll('#recList .rec-item').length === 1 && !document.getElementById('recStartBtn').disabled`), 10000, `寫完 ${source}`)
      const name = await cdp.eval(`document.querySelector('#recList .rec-item').dataset.name`)
      const recorded = probeWebm(path.join(USER_DATA_DIR, 'recordings', name))
      const expected = source === 'both' ? [true, true] : [source === 'system', source === 'mic']
      ok(`${source} 錄音檔包含選用音源的聲音`, recorded.opus && recorded.pcmBytes > 48000 &&
        recorded.levels.every((level, i) => expected[i] ? level > 0.03 : level < 0.01), JSON.stringify(recorded))
      ok(`${source} 停止後關閉全部擷取軌`, await cdp.eval(`window.__recTest.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')) && !document.getElementById('recAudioSource').disabled`))
      await cdp.eval(`document.querySelector('#recList [data-act="delete"]').click()`)
      await waitFor(() => cdp.eval(`!!document.querySelector('#recList .dict-empty')`), 5000, '刪掉測試錄音')
      await cdp.eval(`Promise.all(window.__recTest.contexts.splice(0).map(c=>c.close()))`)
    }
    await cdp.eval(`document.querySelector('[data-page="settings"]').click(); document.querySelector('[data-page="stt"]').click()`)
    await waitFor(() => cdp.eval(`document.getElementById('recAudioSource').value === 'both'`), 5000, '重新進頁讀回音源')
    ok('重新進頁仍記得系統＋麥克風', true)
    await cdp.eval(`window.electronAPI.store.set('recAudioSource', 'bad-source')`)
    ok('非法音源讀寫都退回麥克風', await cdp.eval(`window.electronAPI.store.get('recAudioSource')`) === 'mic')
    await cdp.eval(`navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('test denied', 'NotAllowedError') }; window.__recTest.streams = []; document.getElementById('recStartBtn').click()`)
    await waitFor(() => cdp.eval(`window.__recTest.streams.length > 0 && !document.getElementById('recStartBtn').disabled`), 8000, '混音麥克風拒絕')
    ok('混音一方拒絕後關閉已開的系統音源、按鈕可重試', await cdp.eval(`!document.getElementById('recStatus').classList.contains('active') && !document.getElementById('recAudioSource').disabled && window.__recTest.streams.every(s=>s.getTracks().every(t=>t.readyState === 'ended'))`))
    await cdp.eval(`(async () => {
      await Promise.all(window.__recTest.contexts.splice(0).map(c=>c.close()))
      navigator.mediaDevices.getUserMedia = window.__recTest.toneMic; window.__recTest.burst = true
    })()`)
    // 字幕走真 AudioContext→16k PCM→VAD→main ASR→本機假上游→字幕紀錄，不呼叫付費 API。
    for (const source of ['system', 'mic', 'both']) {
      await cdp.eval(`(() => {
        window.__recTest.calls = []; window.__recTest.streams = []
        const select = document.getElementById('liveAudioSource'); select.value = ${JSON.stringify(source)}; select.dispatchEvent(new Event('change'))
        document.getElementById('liveLanguage').value = 'auto'
      })()`)
      await waitFor(() => cdp.eval(`window.electronAPI.store.get('liveAudioSource')`).then((v) => v === source), 5000, '記住字幕音源')
      const before = asrRequests.length
      await cdp.eval(`document.getElementById('startLiveBtn').click()`)
      await waitFor(() => cdp.eval(`document.getElementById('liveStatus').classList.contains('active')`), 10000, `字幕 ${source} 開始`)
      ok(`字幕 ${source} 擷取時鎖住音源`, await cdp.eval(`document.getElementById('liveAudioSource').disabled`))
      await waitFor(() => asrRequests.length > before, 10000, `字幕 ${source} PCM 送到 ASR`)
      const recorded = asrRequests[before], expected = source === 'both' ? [true, true] : [source === 'system', source === 'mic']
      ok(`字幕 ${source} ASR 收到對應音源的 16k PCM`, recorded.rate === 16000 &&
        recorded.levels.every((level, i) => expected[i] ? level > 0.03 : level < 0.01), JSON.stringify(recorded))
      await waitFor(() => {
        const dir = path.join(USER_DATA_DIR, 'live-transcripts')
        return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(`字幕音源驗證成功${before + 1}`))
      }, 5000, 'ASR 結果進字幕紀錄')
      await cdp.eval(`document.getElementById('stopLiveBtn').click()`)
      await waitFor(() => cdp.eval(`!document.getElementById('startLiveBtn').disabled && !document.getElementById('liveAudioSource').disabled`), 10000, '字幕完整停止')
      ok(`字幕 ${source} 停止後關閉全部輸入軌`, await cdp.eval(`window.__recTest.streams.every(s=>s.getTracks().every(t=>t.readyState === 'ended'))`))
      await cdp.eval(`Promise.all(window.__recTest.contexts.splice(0).map(c=>c.close()))`)
    }
    ok('字幕也記得系統＋麥克風', await cdp.eval(`window.electronAPI.store.get('liveAudioSource')`) === 'both')
    await cdp.eval(`window.electronAPI.store.set('liveAudioSource', 'bad-source')`)
    ok('字幕非法音源維持預設系統聲音', await cdp.eval(`window.electronAPI.store.get('liveAudioSource')`) === 'system')
    await cdp.eval(`navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('test denied', 'NotAllowedError') }; window.__recTest.streams = []; document.getElementById('startLiveBtn').click()`)
    await waitFor(() => cdp.eval(`window.__recTest.streams.length > 0 && !document.getElementById('startLiveBtn').disabled`), 10000, '字幕混音麥克風拒絕')
    ok('字幕混音一方拒絕後完整釋放且可重試', await cdp.eval(`!document.getElementById('liveStatus').classList.contains('active') && !document.getElementById('liveAudioSource').disabled && window.__recTest.streams.every(s=>s.getTracks().every(t=>t.readyState === 'ended'))`))
    await cdp.eval(`(async () => {
      navigator.mediaDevices.getUserMedia = window.__recTest.originalMic; navigator.mediaDevices.getDisplayMedia = window.__recTest.originalSystem
      await Promise.all(window.__recTest.contexts.map(c=>c.close())); delete window.__recTest
    })()`)

    ok('過程沒有未處理的例外', cdp.exceptions.length === 0, cdp.exceptions.join(' | '))
  } catch (error) {
    failed++
    console.log(`FAIL  ${error.message}`)
    if (cdp?.exceptions.length) console.log(`      例外：${cdp.exceptions.join(' | ')}`)
    if (cdp?.logs.length) console.log(`      console：${cdp.logs.slice(-5).join(' | ')}`)
    const state = await cdp?.eval(`({
      active: [...document.querySelectorAll('#page-stt .subtab-panel.active')].map((p) => p.id),
      recList: document.getElementById('recList')?.innerHTML.slice(0, 200),
      history: document.getElementById('liveHistoryList')?.innerHTML.slice(0, 300),
      toast: document.getElementById('toast')?.textContent,
      dialogs: document.querySelectorAll('dialog[open]').length
    })`).catch((e) => e.message)
    console.log(`      狀態：${JSON.stringify(state)}`)
    for (const sub of ['recordings', 'live-transcripts']) {
      const dir = path.join(USER_DATA_DIR, sub)
      console.log(`      ${sub}：${fs.existsSync(dir) ? fs.readdirSync(dir).join(', ') : '(無)'}`)
    }
  } finally {
    cdp?.close()
    // 只殺自己 spawn 的那一顆
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await new Promise((resolve) => asrServer.close(resolve))
  }
  console.log(`\n${failed ? 'FAILED' : 'ALL PASS'} — ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
