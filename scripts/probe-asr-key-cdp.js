/** 設定一致性回歸：隔離打包版＋本機假上游，不用使用者的 Key、模型或麥克風。 */
const assert = require('assert/strict')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const { float32ToWav } = require('../src/main/cloud-asr')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, label) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(150)
  }
  throw new Error(`等待逾時：${label}`)
}

class Cdp {
  constructor() { this.id = 0; this.pending = new Map() }
  async connect(url) {
    this.ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data)
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
}

async function main() {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, key: req.headers.authorization, model: JSON.parse(raw).model })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: '金鑰回歸通過' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${server.address().port}/v1`
  const clouds = [
    { id: 'other', name: '其他', apiUrl, apiKey: 'other-test-key', models: ['other-model'] },
    { id: 'selected', name: '選用', apiUrl, apiKey: 'selected-test-key', models: ['test-model:extended'] }
  ]
  const dir = tempDir('asr-key-cdp-')
  const audio = path.join(dir, 'sample.wav')
  fs.writeFileSync(audio, float32ToWav(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10) * 0.1)))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    asrApiKey: '', asrClouds: clouds, asrCloudId: 'other',
    fileAsr: 'cloud:selected:test-model:extended', liveAsr: 'cloud:selected:test-model:extended',
    localTranslateModel: 'qwen354b', llmGpu: true,
    sysmonSensors: false, dictationEnabled: false, closeToTray: false
  }))
  const port = 9258
  const exe = process.env.VOICEINK_EXE || path.join(__dirname, '../dist/win-unpacked/VoiceInk.exe')
  const start = () => spawn(exe, ['--hidden', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--inspect=127.0.0.1:9259'], { stdio: 'ignore' })
  let child = start()
  const cdp = new Cdp()
  const mainCdp = new Cdp()
  const stop = () => {
    cdp.ws?.close()
    mainCdp.ws?.close()
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  const connect = async () => {
    const target = await waitFor(async () => {
      const targets = await fetch('http://127.0.0.1:9259/json/list').then((r) => r.json()).catch(() => [])
      return targets[0]
    }, '主程序')
    await mainCdp.connect(target.webSocketDebuggerUrl)
    await mainCdp.eval(`globalThis.__probeRequire = process.mainModule.require('node:module').createRequire(process.mainModule.require('electron').app.getAppPath() + '/src/main/main.js')`)
    const page = await waitFor(async () => {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
      return pages.find((p) => p.type === 'page' && /index\.html/.test(p.url))
    }, '主視窗')
    await cdp.connect(page.webSocketDebuggerUrl)
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!window.electronAPI`), 'preload')
  }
  let passed = 0
  let failed = 0
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`PASS  ${name}`) }
    catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`) }
  }
  try {
    await connect()
    await check('首次 engine IPC 將模型／GPU 設定交給 LLM（不載真模型）', async () => {
      await mainCdp.eval(`(() => {
        const llm = globalThis.__probeRequire('./local-llm');
        globalThis.__probeLlm = { llm, setStore: llm.setStore, warm: llm.warm, isLoaded: llm.isLoaded };
        llm.setStore = (store) => {
          globalThis.__probeLlm.settings = [store.get('localTranslateModel'), store.get('llmGpu')];
          globalThis.__probeLlm.setStore(store);
        };
        llm.warm = async () => ({ ok: true, warnings: [] });
        llm.isLoaded = () => true;
      })()`)
      try {
        assert.equal((await cdp.eval(`window.electronAPI.engine.acquire('translate', { asr: false, llm: true })`)).ok, true)
        assert.deepEqual(await mainCdp.eval(`globalThis.__probeLlm.settings`), ['qwen354b', true])
      } finally {
        await cdp.eval(`window.electronAPI.engine.release('translate')`)
        await mainCdp.eval(`(() => { const p = globalThis.__probeLlm; Object.assign(p.llm, { setStore: p.setStore, warm: p.warm, isLoaded: p.isLoaded }); delete globalThis.__probeLlm; })()`)
      }
    })
    await cdp.eval(`document.querySelector('[data-page="stt"]').click()`)
    await waitFor(() => cdp.eval(`!!document.getElementById('fileAsrModel')?.options.length`), '轉錄初始化')
    await cdp.eval(`document.getElementById('outputLanguage').value = 'auto'`)
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' })
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [audio] })
    const transcribe = async () => {
      await cdp.eval(`document.getElementById('startTranscribeBtn').click()`)
      await waitFor(() => cdp.eval(`!document.getElementById('startTranscribeBtn').disabled`), '轉錄結束')
    }
    await check('新清單有 Key、舊欄位空白仍可轉錄，使用當頁選用的 Key／模型', async () => {
      await transcribe()
      assert.equal(await cdp.eval(`document.getElementById('resultText').textContent`), '金鑰回歸通過')
      assert.deepEqual(requests, [{ url: '/v1/audio/transcriptions', key: 'Bearer selected-test-key', model: 'test-model:extended' }])
    })
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="live"]').click()`)
    await waitFor(() => cdp.eval(`document.getElementById('liveTranslatorHint').textContent.includes('雲端 ASR')`), '字幕初始化')
    await cdp.eval(`document.getElementById('liveLanguage').value = 'auto';
      navigator.mediaDevices.getDisplayMedia = async () => {
        window.__captureReached = true;
        throw new DOMException('測試取消擷取', 'NotAllowedError');
      }`)
    const capture = async () => {
      await cdp.eval(`window.__captureReached = false; document.getElementById('startLiveBtn').click()`)
      await waitFor(() => cdp.eval(`!document.getElementById('startLiveBtn').disabled`), '字幕檢查結束')
      return cdp.eval(`window.__captureReached`)
    }
    await check('即時字幕同樣認得新清單的 Key', async () => assert.equal(await capture(), true))
    await cdp.eval(`(async () => {
      await window.electronAPI.store.set('asrApiKey', 'stale-test-key');
      await window.electronAPI.store.set('asrClouds', ${JSON.stringify(clouds.map((c) => c.id === 'selected' ? { ...c, apiKey: '' } : c))});
    })()`)
    await check('選用設定真的缺 Key 時，字幕不拿舊 Key 或其他組代替', async () => assert.equal(await capture(), false))
    await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="file"]').click()`)
    await check('選用設定真的缺 Key 時，轉錄在送出前擋住', async () => {
      const count = requests.length
      await transcribe()
      assert.equal(requests.length, count)
      assert.match(await cdp.eval(`document.querySelector('#toast .toast-message').textContent`), /API Key/)
      assert.equal(await cdp.eval(`document.querySelector('#transcribeProgress .progress-text').textContent`), '讀取設定…')
    })
    await check('本機聊天的選單與提示使用同一份供應商資料', async () => {
      await mainCdp.eval(`globalThis.__probeRequire('./chat').setLocalSource(() => ({ baseUrl: 'http://127.0.0.1:12345', apiKey: 'local-test-key', models: ['local-test-model'] }))`)
      await cdp.eval(`window.electronAPI.store.set('chatProviderId', '__local')`)
      await cdp.eval(`document.querySelector('[data-page="chat"]').click()`)
      await waitFor(() => cdp.eval(`document.getElementById('chatModelSelect').textContent.includes('local-test-model')`), '本機聊天模型')
      assert.equal(await cdp.eval(`document.getElementById('chatBanner').classList.contains('hidden')`), true)
      const options = await cdp.eval(`window.electronAPI.chat.providerOptions()`)
      const local = options.providers.find((p) => p.id === '__local')
      assert.equal(local.hasApiUrl, true)
      assert.equal(local.hasKey, true)
      assert.equal(Object.hasOwn(local, 'apiKey'), false)
      assert.equal(Object.hasOwn(local, 'apiUrl'), false)
    })
    await check('有 Key 缺 URL 時，轉錄／翻譯／整理選單正確提示缺 URL', async () => {
      const missingUrl = [{ id: 'no-url', name: '缺網址測試', apiUrl: '', apiKey: 'test-key', models: ['test-model'] }]
      await cdp.eval(`(async () => {
        await window.electronAPI.store.set('asrClouds', ${JSON.stringify(missingUrl)});
        await window.electronAPI.store.set('chatProviders', ${JSON.stringify(missingUrl)});
        document.querySelector('[data-page="stt"]').click();
      })()`)
      await waitFor(() => cdp.eval(`document.getElementById('fileAsrModel').textContent.includes('缺網址測試')`), '缺 URL 的轉錄選單')
      await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="dictation"]').click()`)
      await waitFor(() => cdp.eval(`document.getElementById('dictationLlmSelect').textContent.includes('缺網址測試')`), '整理選單')
      await cdp.eval(`document.querySelector('#sttSubtabs [data-subtab="live"]').click()`)
      await waitFor(() => cdp.eval(`document.getElementById('liveLlmModel').textContent.includes('缺網址測試')`), '翻譯選單')
      for (const id of ['fileAsrModel', 'liveLlmModel', 'dictationLlmSelect']) {
        const labels = await cdp.eval(`Array.from(document.getElementById('${id}').options).filter(o => o.textContent.includes('缺網址測試')).map(o => o.textContent)`)
        assert.ok(labels.length, id)
        for (const label of labels) { assert.match(label, /缺 API URL/); assert.ok(!label.includes('API Key'), label) }
      }
    })
    await check('刪光 ASR 清單後重開不復活，也不再使用舊 Key', async () => {
      await cdp.eval(`window.electronAPI.store.set('asrClouds', [])`)
      stop()
      child = start()
      await connect()
      assert.deepEqual(await cdp.eval(`window.electronAPI.store.get('asrClouds')`), [])
      assert.equal(await cdp.eval(`window.electronAPI.store.get('asrApiKey')`), 'stale-test-key')
      const settings = await cdp.eval(`(async () => ({ asrClouds: await window.electronAPI.store.get('asrClouds'), asrApiKey: await window.electronAPI.store.get('asrApiKey') }))()`)
      assert.equal(await mainCdp.eval(`globalThis.__probeRequire('./cloud-asr').readConfig({ get: (key) => (${JSON.stringify(settings)})[key] }, 'dictation').apiKey`), '')
    })
  } finally {
    stop()
    await new Promise((resolve) => server.close(resolve))
  }
  console.log(`${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
