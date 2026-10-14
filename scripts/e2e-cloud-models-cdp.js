/** node scripts/e2e-cloud-models-cdp.js — 隔離打包版、僅呼叫本機 mock，絕不使用真實金鑰。 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')

const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '..', 'dist/win-unpacked/AxonDeck.exe')
const DATA = tempDir('cloud-models-cdp-user-')
const ARTIFACTS = tempDir('cloud-models-cdp-artifacts-')
const PORT = Number(process.env.CLOUD_MODELS_CDP_PORT || 9258)
const EXPECTED = { 'mock-chat': 'chat', 'mock-asr': 'asr', 'mock-tts': 'tts', 'mock-image': 'image', 'mock-unknown': 'unknown' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(action, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value } catch (error) { lastError = error }
    await sleep(150)
  }
  throw new Error(`等待逾時：${label}${lastError ? ` (${lastError.message})` : ''}`)
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }) })
    await this.send('Runtime.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 逾時：${method}`)) }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  close() { for (const pending of this.pending.values()) clearTimeout(pending.timer); this.ws.close() }
}
require('./lib/page-cdp').followMainPage(Cdp)


async function mockServer() {
  const mp3 = path.join(ARTIFACTS, 'silence.mp3')
  execFileSync(process.env.FFMPEG_EXE || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'anullsrc=r=24000:cl=mono', '-t', '0.6', '-codec:a', 'libmp3lame', '-y', mp3], { windowsHide: true, timeout: 15000 })
  const audio = fs.readFileSync(mp3)
  const requests = []
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [
        { id: 'mock-chat', architecture: { output_modalities: ['text'] } },
        { id: 'mock-asr', supported_endpoints: ['/audio/transcriptions'] },
        { id: 'mock-tts', supported_endpoints: ['/audio/speech'] },
        { id: 'mock-image', architecture: { output_modalities: ['text', 'image'] } },
        { id: 'mock-unknown' }
      ] }))
      return
    }
    if (request.url === '/v1/audio/speech') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' }); response.end(audio)
      return
    }
    response.writeHead(404); response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1` }
}

async function navigate(cdp, page) {
  await cdp.eval(`document.querySelector('.nav-tab[data-page="${page}"]').click()`)
  await waitFor(() => cdp.eval(`document.querySelector('#page-${page}.active')?.getBoundingClientRect().height > 0`), `${page} 頁面`)
}

async function setInput(cdp, id, value, event = 'input') {
  await cdp.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`)
}

async function configure(cdp, mock) {
  await navigate(cdp, 'settings')
  await waitFor(() => cdp.eval(`document.getElementById('chatProviderSelect').options.length > 0`), '預設供應商')
  assert.equal(await cdp.eval(`!!document.getElementById('asrModelList') || !!document.getElementById('saveSettingsBtn')`), false)
  assert.equal(await cdp.eval(`document.getElementById('chatApiUrlInput').value`), 'https://openrouter.ai/api/v1')
  await cdp.eval(`document.getElementById('chatAddProviderBtn').click()`)
  const id = await cdp.eval(`document.getElementById('chatProviderSelect').value`)
  await setInput(cdp, 'chatProviderNameInput', 'CDP 雲端模型')
  await setInput(cdp, 'chatApiUrlInput', mock.url)
  await setInput(cdp, 'chatApiKeyInput', 'mock-key')
  await cdp.eval(`document.getElementById('chatScanModelsBtn').click()`)
  await waitFor(() => cdp.eval(`document.getElementById('chatScanDialog').open && document.querySelectorAll('#chatScanList .chat-scan-item').length === 5`), '掃描五種模型')
  await cdp.eval(`document.getElementById('chatScanAllBtn').click(); document.getElementById('chatScanApplyBtn').click()`)
  await waitFor(() => cdp.eval(`document.querySelectorAll('#chatModelList .chat-model-row').length === 5`), '模型加入清單')
  const actual = await cdp.eval(`Object.fromEntries([...document.querySelectorAll('#chatModelList .chat-model-row')].map(row => [row.querySelector('input').value, row.querySelector('select').value]))`)
  assert.deepEqual(actual, EXPECTED)
  await waitFor(() => cdp.eval(`window.electronAPI.store.get('cloudProviders').then(ps => ps.find(p => p.id === ${JSON.stringify(id)})?.models.length === 5)`), '掃描後自動儲存')
  await cdp.eval(`(() => { const row = [...document.querySelectorAll('#chatModelList .chat-model-row')].find(r => r.querySelector('input').value === 'mock-unknown'); const select = row.querySelector('select'); select.value = 'asr'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await navigate(cdp, 'chat')
  await waitFor(() => cdp.eval(`window.electronAPI.store.get('cloudProviders').then(ps => ps.find(p => p.id === ${JSON.stringify(id)})?.models.find(m => m.id === 'mock-unknown')?.type === 'asr')`), '離開頁面仍自動儲存用途')
  console.log('PASS 統一設定、預設 OpenRouter、掃描分類、手選用途、離頁自動儲存')
  return id
}

async function checkRouting(cdp, id) {
  const routing = await cdp.eval(`(async () => ({ chat: await window.electronAPI.chat.providerOptions(), asr: await window.electronAPI.store.get('asrClouds'), tts: await window.electronAPI.cloudTts.status() }))()`)
  assert.deepEqual(routing.chat.providers.find((p) => p.id === id).models.sort(), ['mock-chat', 'mock-image'])
  assert.deepEqual(routing.asr.find((p) => p.id === id).models.sort(), ['mock-asr', 'mock-unknown'])
  assert.equal(routing.tts.ok, true)
  assert.deepEqual(routing.tts.data.models.map((m) => m.modelId), ['mock-tts'])
  assert.doesNotMatch(JSON.stringify(routing.chat), /mock-key/)
  assert.doesNotMatch(JSON.stringify(routing.tts), /mock-key/)
  console.log('PASS 聊天／生圖、語音辨識與 TTS 選單各自分流')
}

async function screenshots(cdp, id) {
  await navigate(cdp, 'settings')
  await waitFor(() => cdp.eval(`!!document.querySelector('#chatProviderSelect option[value="${id}"]')`), '供應商重新載入')
  await setInput(cdp, 'chatProviderSelect', id, 'change')
  // --hidden 的視窗不出影格，captureScreenshot 會一直等；跟 speech e2e 一樣由主程序 showInactive（不搶焦點）
  const inspector = await waitFor(async () => {
    const rows = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`, { signal: AbortSignal.timeout(2000) })).json()
    return rows[0]
  }, '主程序 inspector').then(async (row) => { const c = new Cdp(row.webSocketDebuggerUrl); await c.connect(); return c })
  try {
    await inspector.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\.html/.test(w.webContents.getURL())).showInactive()`)
  } finally { inspector.close() }
  for (const theme of ['light', 'dark']) for (const width of [1000, 1400]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: false })
    await cdp.eval(`document.documentElement.setAttribute('data-theme', '${theme}'); document.getElementById('settingsScroll').scrollTop = 0`)
    await waitFor(() => cdp.eval(`document.querySelector('#chatModelList .chat-model-row')?.getBoundingClientRect().height > 0 && innerWidth === ${width}`), '版面完成')
    const layout = await cdp.eval(`(() => { const root = document.documentElement; const list = document.getElementById('chatModelList'); return { pageOverflow: root.scrollWidth > innerWidth + 1, listOverflow: list.scrollWidth > list.clientWidth + 1, rows: [...list.querySelectorAll('.chat-model-row')].map(r => ({ w: r.clientWidth, sw: r.scrollWidth })), background: getComputedStyle(document.querySelector('.settings-card')).backgroundColor }; })()`)
    assert.equal(layout.pageOverflow, false, `${theme}/${width}: page overflow`)
    assert.equal(layout.listOverflow, false, `${theme}/${width}: list overflow`)
    assert.ok(layout.rows.every((r) => r.sw <= r.w + 1), `${theme}/${width}: row overflow`)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const filename = `cloud-settings-${theme}-${width}.png`
    fs.writeFileSync(path.join(ARTIFACTS, filename), Buffer.from(shot.data, 'base64'))
    if (process.env.CLOUD_MODELS_SCREENSHOTS_DIR) {
      const output = path.join(path.resolve(process.env.CLOUD_MODELS_SCREENSHOTS_DIR), path.basename(ARTIFACTS))
      fs.mkdirSync(output, { recursive: true }); fs.copyFileSync(path.join(ARTIFACTS, filename), path.join(output, filename))
    }
  }
  console.log('PASS light/dark × 1000/1400 寬版面無水平溢出，截圖完成')
}

async function appearance(cdp) {
  for (const section of ['appearance', 'basic']) {
    await cdp.eval(`document.querySelector('.settings-nav-item[data-section="${section}"]').click()`)
    await waitFor(() => cdp.eval(`document.querySelector('#set-${section}.active')?.getBoundingClientRect().height > 0`), `${section} 區塊`)
    for (const theme of ['light', 'dark']) {
      await cdp.eval(`document.documentElement.setAttribute('data-theme', '${theme}')`)
      if (section === 'appearance') {
        await waitFor(() => cdp.eval(`(() => { const s = getComputedStyle(document.getElementById('termAppearancePreview')); return s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.color !== s.backgroundColor })()`), '終端機預覽配色')
      }
      await waitFor(() => cdp.eval(`document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`), '切換動畫結束')
      await sleep(400)
      const overflow = await cdp.eval(`document.documentElement.scrollWidth > innerWidth + 1`)
      assert.equal(overflow, false, `${section}/${theme}: page overflow`)
      if (section === 'appearance') assert.ok(await cdp.eval(`document.getElementById('termThemeSelect').options.length > 1 && !!document.getElementById('termThemeSelect').value`), '終端機外觀有選項')
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      const filename = `settings-${section}-${theme}.png`
      fs.writeFileSync(path.join(ARTIFACTS, filename), Buffer.from(shot.data, 'base64'))
      if (process.env.CLOUD_MODELS_SCREENSHOTS_DIR) {
        const output = path.join(path.resolve(process.env.CLOUD_MODELS_SCREENSHOTS_DIR), path.basename(ARTIFACTS))
        fs.mkdirSync(output, { recursive: true }); fs.copyFileSync(path.join(ARTIFACTS, filename), path.join(output, filename))
      }
    }
  }
  // 主題、終端機外觀都搬到「外觀」，基本只剩更新與啟動
  const placement = await cdp.eval(`({ theme: !!document.querySelector('#set-appearance #themeSegment'), term: !!document.querySelector('#set-appearance #termThemeSelect'), update: !!document.querySelector('#set-basic #updateCheckBtn'), basicTheme: !!document.querySelector('#set-basic #themeSegment') })`)
  assert.deepEqual(placement, { theme: true, term: true, update: true, basicTheme: false })
  console.log('PASS 外觀分頁（主題＋終端機預覽）與基本分頁版面，截圖完成')
}

async function speech(cdp, mock) {
  await navigate(cdp, 'speech')
  await setInput(cdp, 'speechBackend', 'cloud', 'change')
  await waitFor(() => cdp.eval(`!document.getElementById('speechCloudPanel').hidden && !document.getElementById('cloudSpeechGenerate').disabled`), '雲端語音可用')
  await setInput(cdp, 'cloudSpeechText', '這是本機測試語音')
  await cdp.eval(`document.getElementById('cloudSpeechGenerate').click()`)
  await waitFor(() => cdp.eval(`document.getElementById('cloudSpeechAudio').readyState >= 2 && !document.getElementById('cloudSpeechSave').disabled`), 'MP3 解碼成功')
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].model, 'mock-tts')
  assert.equal(mock.requests[0].input, '這是本機測試語音')
  assert.equal(mock.requests[0].response_format, 'mp3')
  const played = await cdp.eval(`(async () => { const a = document.getElementById('cloudSpeechAudio'); a.muted = true; await a.play(); return a.duration > 0 && !a.paused && !a.error })()`)
  assert.equal(played, true)
  await waitFor(() => cdp.eval(`document.getElementById('cloudSpeechAudio').currentTime > 0`), '靜音播放時間前進')
  await cdp.eval(`document.getElementById('cloudSpeechAudio').pause()`)
  console.log('PASS 同頁切雲端、正確 TTS 模型請求、真 MP3 解碼與靜音播放')
}

async function main() {
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ sysmonSensors: false, uffsAuto: false, agyEnabled: false }))
  const mock = await mockServer()
  let child, cdp
  try {
    child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${DATA}`, `--inspect=${PORT + 1}`, '--hidden', '--disable-backgrounding-occluded-windows'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => console.error(`啟動失敗：${error.message}`))
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
      return (await response.json()).find((p) => p.type === 'page' && /index\.html/.test(p.url))
    }, '隔離主視窗', 30000)
    cdp = new Cdp(target.webSocketDebuggerUrl); await cdp.connect()
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!window.electronAPI?.cloudTts`), 'App 初始化')
    await cdp.eval(`(async () => { await window.electronAPI.store.set('sysmonSensors', false) })()`)
    const id = await configure(cdp, mock)
    await checkRouting(cdp, id)
    await screenshots(cdp, id)
    await appearance(cdp)
    await cdp.eval('window.__cloudModelsReloadMarker = true')
    await cdp.send('Page.reload', { ignoreCache: true })
    await waitFor(() => cdp.eval(`!window.__cloudModelsReloadMarker && document.readyState === 'complete' && !!window.electronAPI?.cloudTts`), '重載 App')
    await checkRouting(cdp, id)
    const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'))
    assert.equal(disk.cloudProviders.find((p) => p.id === id).models.find((m) => m.id === 'mock-unknown').type, 'asr')
    await speech(cdp, mock)
    assert.deepEqual(cdp.exceptions, [])
    console.log('PASS 雲端模型 CDP 全部完成；未測匯出對話框，未呼叫任何真上游')
    if (process.env.CLOUD_MODELS_SCREENSHOTS_DIR) console.log(`截圖：${path.join(path.resolve(process.env.CLOUD_MODELS_SCREENSHOTS_DIR), path.basename(ARTIFACTS))}`)
  } finally {
    cdp?.close()
    if (child?.pid) {
      try { execFileSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) }
      catch (error) { if (child.exitCode === null) console.error(`清理測試程序失敗：${error.status}`) }
      child.kill()
    }
    mock.server.closeAllConnections()
    await new Promise((resolve) => mock.server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
