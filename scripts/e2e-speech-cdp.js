/**
 * node scripts/e2e-speech-cdp.js — isolated packaged UI / real preload / IPC.
 * 驗真正未下載的守衛與替換 Breeze exports 的畫面流程；有模型時另驗真 Q8 推論：
 * BREEZE_QA_CACHE（模型與 runtime/ 同一層）或 BREEZE_QA_MODELS（已安裝的 userData/models）。
 * AXONDECK_SHOT_DIR 可保留截圖；視窗 showInactive 不搶焦點。
 * AXONDECK_DEV=1 改用原始碼＋vite（沒在跑就自己開、結束時關），不用先打包。
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const { wavHeader, wavInfo } = require('../src/main/breeze-tts/protocol')
const ROOT = path.join(__dirname, '..')
const EXE = process.env.AXONDECK_EXE || path.join(ROOT, 'dist/win-unpacked/AxonDeck.exe')
const USER_DATA = tempDir('speech-cdp-')
const SHOTS = process.env.AXONDECK_SHOT_DIR || ''
const CACHE = process.env.BREEZE_QA_CACHE || ''
const MODELS = process.env.BREEZE_QA_MODELS || ''
// 兩種擺法：快取資料夾（模型＋runtime/）或 App 的 models 目錄（各自一個子資料夾）
const REAL = CACHE ? { modelDir: CACHE, runtimeDir: path.join(CACHE, 'runtime') }
  : MODELS ? { modelDir: path.join(MODELS, 'breezetts2q8'), runtimeDir: path.join(MODELS, 'breezeruntime') } : null
const PORT = 9253
const DEV = process.env.AXONDECK_DEV === '1'
// 主視窗與功能頁的網址：打包版是 index.html，原始碼版是 vite
const PAGE = DEV ? /localhost:5173/ : /index\.html/
const INSPECT = PORT + 1
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let passed = 0
fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
  sysmonSensors: false, dictationEnabled: false, uffsAuto: false, hfAutoStart: false
}))
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails.text)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 逾時`)) }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  async click(selector) {
    const point = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2, width:r.width, height:r.height };
    })()`)
    assert(point.width > 0 && point.height > 0, `無法點選 ${selector}`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }
  }
  async key(key, code, windowsVirtualKeyCode) {
    for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
  }
  close() { this.ws?.close() }
}
require('./lib/page-cdp').followMainPage(Cdp)


async function waitFor(action, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await action()) return
    await sleep(150)
  }
  throw new Error(`等待逾時：${label}`)
}

async function target(port, main = false) {
  let found
  await waitFor(async () => {
    const rows = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => [])
    found = main ? rows[0] : rows.find((row) => row.type === 'page' && PAGE.test(row.url))
    return found
  }, 'CDP target')
  const cdp = new Cdp(found.webSocketDebuggerUrl)
  await cdp.connect()
  return cdp
}

function check(label, value) { assert(value, label); passed++; console.log(`PASS ${label}`) }
async function visible(cdp, id) { return cdp.eval(`document.getElementById(${JSON.stringify(id)}).offsetHeight > 0`) }
async function fill(cdp, values) {
  await cdp.eval(`Object.entries(${JSON.stringify(values)}).forEach(([id,value])=> {
    const el=document.getElementById(id); el.value=String(value); el.dispatchEvent(new Event('input',{bubbles:true}));
  })`)
}

async function installFixture(main) {
  const pcm = Buffer.alloc(4800)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 4000), i * 2)
  const audioBase64 = Buffer.concat([wavHeader(pcm.length, 24000), pcm]).toString('base64')
  await main.eval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    const root = req('electron').app.getAppPath();
    const service = req(req('node:path').join(root,'src/main/breeze-tts'));
    const protocol = req(req('node:path').join(root,'src/main/breeze-tts/protocol'));
    global.__speechOriginal = {...service};
    // 功能頁各自一個 WebContentsView：跟 main 的 sendToPages 一樣廣播給每一頁，只送主視窗外殼的話功能頁收不到
    const win = { webContents: { send: (channel, payload) => req('electron').webContents.getAllWebContents().filter(c => ${PAGE}.test(c.getURL())).forEach(c => c.send(channel, payload)) } };
    global.__speechQA = { requests:[], voices:[], exports:[], canceled:[], trims:[], recordings:[], takes:[], behavior:'success', pending:null };
    const qa = global.__speechQA;
    const pcm = Buffer.from(${JSON.stringify(pcm.toString('base64'))}, 'base64');
    const audio = (kind, name) => { const bytes = Buffer.concat([protocol.wavHeader(pcm.length*10,24000), Buffer.concat(Array(10).fill(pcm))]);
      return {audioId:'qa-'+kind+'-'+name,name,duration:1,peaks:protocol.wavPeaks(bytes),previewBase64:bytes.toString('base64'),...(kind==='reference'?{transcript:'自動辨識的參考內容'}:{})}; };
    service.status = async () => ({installed:true,ready:true});
    service.voices = async () => qa.voices;
    service.pickAudio = async ({kind}) => audio(kind, 'qa-'+kind+'.wav');
    service.importRecording = async (options) => { qa.recordings.push({kind:options.kind,bytes:options.data.length}); return audio(options.kind, '錄音-qa'); };
    service.trimAudio = async (options) => { qa.trims.push(options); return {...audio('reference','qa-trimmed.wav'), duration:options.end-options.start}; };
    service.saveVoice = async (options) => { const voice={id:options.name,seconds:0.1}; qa.voices.push(voice); return voice; };
    service.removeVoice = async ({id}) => { qa.voices=qa.voices.filter(v=>v.id!==id); return {deleted:id}; };
    service.saveAudio = async (options) => { qa.exports.push(options); return {saved:true}; };
    service.cancel = async ({reqId}) => { qa.canceled.push(reqId); qa.pending?.reject(Object.assign(new Error('已停止語音生成'),{userMessage:'已停止語音生成',code:'CANCELED'})); qa.pending=null; return {canceled:true}; };
    service.generate = async (options) => {
      qa.requests.push(options);
      if(qa.behavior==='error') throw Object.assign(new Error('測試：請重新選擇錄音'),{userMessage:'測試：請重新選擇錄音',code:'INVALID_AUDIO'});
      win.webContents.send('breeze:progress',{reqId:options.reqId,phase:'generating',seconds:0.05});
      win.webContents.send('breeze:chunk',{reqId:options.reqId,pcmBase64:pcm.toString('base64'),sampleRate:24000,seconds:0.1});
      if(qa.behavior==='pending' || (qa.behavior==='pendingSecond' && qa.requests.length%3===2)) return new Promise((resolve,reject)=>{qa.pending={resolve,reject};});
      await new Promise(resolve=>setTimeout(resolve,60));
      return {resultId:'qa-result-'+qa.requests.length,audioBase64:${JSON.stringify(audioBase64)},mimeType:'audio/wav',duration:0.1,sampleRate:24000};
    };
    // 版本：每句 0.1 秒，照真實格式回 segments（offset/length 以樣本計）
    service.saveTake = async (options) => {
      qa.saved = options;
      let cursor = 0;
      const segments = options.parts.map((part) => { const start = options.placement==='cue' ? Math.max(Math.round((part.at||0)*24000), cursor) : cursor;
        cursor = start + 2400 + (options.placement==='cue' ? 0 : Math.round((part.gap||0)*24000));
        return {text:part.text||'',speaker:part.speaker||'',at:part.at||0,gap:part.gap||0,offset:start,length:2400}; });
      const take = {id:req('crypto').randomUUID(),createdAt:Date.now(),duration:cursor/24000,title:options.title||'',mode:options.mode||'',voice:options.voice||'',placement:options.placement==='cue'?'cue':'sequence',segments};
      qa.takes.unshift(take); return take;
    };
    service.listTakes = async () => qa.takes;
    service.loadTake = async ({id}) => { const take = qa.takes.find(t=>t.id===id); if(!take) throw Object.assign(new Error('找不到這個版本'),{userMessage:'找不到這個版本',code:'TAKE_MISSING'});
      const samples = Math.round(take.duration*24000), body = Buffer.alloc(samples*2);
      for (const s of take.segments) pcm.copy(body, s.offset*2, 0, Math.min(pcm.length, body.length - s.offset*2));
      const bytes = Buffer.concat([protocol.wavHeader(body.length,24000), body]);
      return {take, audioBase64:bytes.toString('base64'), mimeType:'audio/wav', peaks:protocol.wavPeaks(bytes,1200)}; };
    service.removeTake = async ({id}) => { qa.takes = qa.takes.filter(t=>t.id!==id); return {deleted:id}; };
    win.webContents.send('breeze:status',{installed:true,ready:true}); return true;
  })()`)
}

/** 真 Q8：逐句生成、單句重做、字幕配音（一個角色用保存的聲音克隆），各自匯出 WAV。 */
async function realScriptGate(cdp, inspector) {
  const out = SHOTS || USER_DATA
  const takes = async () => (await cdp.eval(`window.electronAPI.breeze.listTakes()`)).data
  const exportTake = async (name) => {
    const file = path.join(out, name)
    await inspector.eval(`global.__speechExportPath=${JSON.stringify(file)}`)
    await cdp.click('#speechExport')
    await waitFor(() => cdp.eval(`speechProgress.textContent==='WAV 已匯出。'`), `匯出 ${name}`)
    return file
  }
  const wavSeconds = (file) => wavInfo(fs.readFileSync(file)).duration
  const run = async (label, action) => {
    const before = (await takes()).length
    const started = Date.now()
    await action()
    await waitFor(async () => (await takes()).length > before || cdp.eval(`!speechError.hidden`), label, 900000)
    await waitFor(() => cdp.eval(`!speechGenerate.disabled`), `${label} 結束`, 60000)
    const error = await cdp.eval(`speechError.hidden?'':speechError.textContent`)
    check(`packaged 真 Q8 ${label}成功`, !error && (await takes()).length > before)
    console.log(`真 Q8 ${label}: ${((Date.now() - started) / 1000).toFixed(1)} 秒；${await cdp.eval('speechProgress.textContent')}`)
    return (await takes())[0]
  }
  await cdp.click('.speech-mode[data-mode="design"]')
  await cdp.click('.speech-script-mode[data-script="sentences"]')
  await fill(cdp, { speechText: '今天早上下了一場小雨。空氣變得很清新，路邊的樹葉閃閃發亮。\n下午我們去公園散步吧！', speechInstruction: '溫暖清晰的年輕女性聲音，語速自然。', speechSeed: 42 })
  const sentences = await run('逐句生成', () => cdp.click('#speechGenerate'))
  check('真逐句版本有三句，每句都有聲音', sentences.segments.length === 3 && sentences.segments.every((seg) => seg.length > 24000 * 0.3))
  const sentenceFile = await exportTake('qa-real-sentences.wav')
  check('逐句 WAV 長度等於版本長度', Math.abs(wavSeconds(sentenceFile) - sentences.duration) < 0.01)
  const original = sentences.segments.map((seg) => seg.length)
  const redone = await run('單句重做', async () => {
    await cdp.click('#speechSegments li:nth-child(2) .seg-edit')
    await cdp.eval(`document.querySelector('#speechSegments li:nth-child(2) .seg-input').value='空氣變得很清新，連小鳥都開始唱歌了。'`)
    await cdp.click('#speechSegments li:nth-child(2) .seg-redo')
  })
  check('真重做只換第二句，前後兩句長度不變', redone.segments[0].length === original[0] && redone.segments[2].length === original[2] && redone.segments[1].text.includes('小鳥'))
  await exportTake('qa-real-redo.wav')
  await cdp.click('.speech-script-mode[data-script="subtitle"]')
  const srt = path.join(USER_DATA, 'qa-real.srt')
  fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:03,000\n小明：早安，今天天氣真好。\n\n2\n00:00:03,500 --> 00:00:06,000\n小華：對啊，我們出去走走吧。\n\n3\n00:00:06,500 --> 00:00:09,000\n小明：好，我去拿外套。\n')
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#speechSubtitleFile' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [srt] })
  await waitFor(() => cdp.eval(`speechSpeakerList.children.length===2`), '真字幕匯入')
  await cdp.eval(`(() => { const s=speechSpeakerList.children[0].querySelector('select'); s.value='qa_real_voice'; s.dispatchEvent(new Event('change')); })()`)
  const dubbed = await run('字幕配音', () => cdp.click('#speechGenerate'))
  check('真字幕版本依時間放置、三句各有角色', dubbed.placement === 'cue' && dubbed.segments.map((seg) => seg.speaker).join() === '小明,小華,小明' &&
    dubbed.segments[0].offset >= 12000 && dubbed.segments.every((seg, i) => i === 0 || seg.offset >= dubbed.segments[i - 1].offset + dubbed.segments[i - 1].length))
  const subtitleFile = await exportTake('qa-real-subtitle.wav')
  console.log(`真 Q8 字幕配音 ${wavSeconds(subtitleFile).toFixed(1)} 秒；每句起點 ${dubbed.segments.map((seg) => (seg.offset / 24000).toFixed(2)).join(' / ')} 秒`)
  await cdp.click('.speech-script-mode[data-script="whole"]')
}

async function realModelGate(cdp, inspector) {
  const model = path.join(REAL.modelDir, 'breeze-tts-2-q8_0.gguf')
  const runtime = path.join(REAL.runtimeDir, 'breeze-tts-2-v0.1.0-windows-x64-vulkan/breeze-server.exe')
  assert(fs.existsSync(model) && fs.existsSync(runtime), '找不到 Q8 模型或執行環境')
  const exported = path.join(USER_DATA, 'qa-real-design.wav')
  await inspector.eval(`(() => {
    const req=process.mainModule.require.bind(process.mainModule), root=req('electron').app.getAppPath();
    const service=req(req('node:path').join(root,'src/main/breeze-tts'));
    Object.assign(service,global.__speechOriginal);
    const models=req(req('node:path').join(root,'src/main/models')), original=models.filePath, originalDir=models.modelDir;
    models.filePath=(key,part)=>key==='breezetts2q8' && part==='gguf' ? ${JSON.stringify(model)} : key==='breezeruntime' && part==='binary' ? ${JSON.stringify(runtime)} : original(key,part);
    models.modelDir=key=>key==='breezetts2q8' ? ${JSON.stringify(REAL.modelDir)} : key==='breezeruntime' ? ${JSON.stringify(REAL.runtimeDir)} : originalDir(key);
    const dialog=req('electron').dialog;
    global.__speechExportPath=${JSON.stringify(exported)};
    dialog.showSaveDialog=async()=>({canceled:false,filePath:global.__speechExportPath});
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(exported)}]});
  })()`)
  check('真 Q8 與執行環境在隔離 App 完整可用', (await cdp.eval(`window.electronAPI.breeze.status()`)).data?.installed)
  await cdp.click('.nav-tab[data-page="chat"]')
  await cdp.click('.nav-tab[data-page="speech"]')
  await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechInstallNotice.offsetHeight===0`), '真 Q8 就緒')
  await cdp.click('.speech-mode[data-mode="design"]')
  const refText = '今天的天氣很好，歡迎使用文字轉語音。'
  await fill(cdp, { speechText:refText, speechInstruction:'清晰自然的年輕女性聲音。', speechSeed:42 })
  for (const mode of ['design', 'clone']) {
    if (mode === 'clone') {
      await cdp.click('#speechExport')
      await waitFor(() => cdp.eval(`speechProgress.textContent==='WAV 已匯出。'`), '真 WAV 匯出')
      check('真實 saveAudio IPC 寫出有效 WAV', fs.readFileSync(exported).subarray(0, 4).toString() === 'RIFF')
      await cdp.click('.speech-mode[data-mode="clone"]')
      await cdp.click('#speechPickReference')
      await waitFor(() => cdp.eval(`speechReferenceName.textContent.includes('qa-real-design.wav')`), '真參考錄音')
      await fill(cdp, { speechRefText:refText, speechVoiceName:'qa_real_voice' })
      await cdp.click('#speechSaveVoice')
      await waitFor(() => cdp.eval(`speechVoice.value==='qa_real_voice' || !speechError.hidden`), '真聲音保存', 180000)
      check('真實 saveVoice IPC 建立聲音收藏', await cdp.eval(`speechVoice.value==='qa_real_voice'`) && fs.existsSync(path.join(USER_DATA,'breeze-tts/voices/qa_real_voice.breeze')))
      await fill(cdp, { speechText:'你好，這是保存聲音的測試。' })
    }
    const previous = await cdp.eval(`({src:speechPlayer.src,streams:window.__speechStreams})`)
    const started = Date.now()
    await cdp.click('#speechGenerate')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled && (speechPlayer.src!==${JSON.stringify(previous.src)} || !speechError.hidden)`), `真 ${mode} 生成`, 180000)
    const result = await cdp.eval(`({src:speechPlayer.src,error:speechError.hidden?'':speechError.textContent,streams:window.__speechStreams})`)
    check(`packaged 真 Q8 ${mode} 生成成功`, result.src !== previous.src && !result.error)
    await waitFor(() => cdp.eval(`speechPlayer.readyState>=2 && speechPlayer.duration>0`), `真 ${mode} WAV 解碼`)
    check(`packaged 真 Q8 ${mode} 串流排入播放`, result.streams > previous.streams)
    console.log(`真 Q8 ${mode}: ${((Date.now()-started)/1000).toFixed(2)} 秒；${await cdp.eval('speechProgress.textContent')}`)
  }
  await realScriptGate(cdp, inspector)
  const status = await cdp.eval(`window.electronAPI.breeze.status()`)
  console.log(`真 Q8 backend: ${status.data?.backend}`)
  await inspector.eval(`process.mainModule.require(process.mainModule.require('node:path').join(process.mainModule.require('electron').app.getAppPath(),'src/main/breeze-tts')).shutdown()`)
}

const hostWindow = `process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>${PAGE}.test(w.webContents.getURL()))`

/** 拖曳畫布：x 是 0～1 的比例 */
async function drag(cdp, selector, from, to) {
  const box = await cdp.eval(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x,y:r.y+r.height/2,w:r.width}; })()`)
  const point = (ratio) => ({ x: box.x + box.w * ratio, y: box.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point(from), button: 'left', clickCount: 1 })
  for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point(from + (to - from) * i / 5), button: 'left', buttons: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point(to), button: 'left', clickCount: 1 })
}

async function startVite() {
  if (await fetch('http://localhost:5173/').then(() => true).catch(() => false)) return null
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--strictPort'], { cwd: ROOT, windowsHide: true, stdio: 'ignore' })
  await waitFor(() => fetch('http://localhost:5173/').then(() => true).catch(() => false), 'vite 啟動')
  return vite
}

function killTree(child) {
  if (!child?.pid) return
  const killer = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  spawnSync(killer, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  child.kill()
}

async function main() {
  const vite = DEV ? await startVite() : null
  const flags = ['--hidden', '--disable-backgrounding-occluded-windows', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`]
  const child = spawn(DEV ? require('electron') : EXE, DEV ? [ROOT, ...flags] : flags,
    { detached: true, windowsHide: true, stdio: 'ignore', shell: false })
  let cdp, inspector
  try {
    cdp = await target(PORT)
    inspector = await target(INSPECT, true)
    await waitFor(() => inspector.eval(`!!(${hostWindow})`), '主視窗載入')
    await inspector.eval(`${hostWindow}.webContents.setAudioMuted(true)`)
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(() => cdp.eval(`document.readyState==='complete' && !!window.electronAPI?.breeze`), 'preload')
    // 頁數跟著 index.html 走（手抄的數字每次加減頁面都會過期）
    const navCount = require('./lib/nav-pages').NAV_PAGES.length
    check(`導航有文字轉語音，全部 ${navCount} 頁`, await cdp.eval(`document.querySelectorAll('.nav-tab[data-page]').length===${navCount} && !!document.querySelector('.nav-tab[data-page="speech"]')`))
    await cdp.click('.nav-tab[data-page="speech"]')
    await waitFor(() => cdp.eval(`document.getElementById('speechModelStatus').textContent==='尚未下載'`), '未下載狀態')
    const tags = ['[笑]', '(laugh)', '[叹气]', '(sigh)', '[咳嗽]', '(cough)', '[清嗓子]', '(clears throat)', '[低语]', '(whispering)', '[倒抽气]', '(gasp)', '[紧张地轻笑]', '(nervous chuckle)', '[打哈欠]', '(yawn)', '[耳语]', '(whispers)']
    check('九類 18 個中英文標記齊全且無重複', await cdp.eval(`JSON.stringify([...speechEvents.querySelectorAll('[data-event]')].map(el=>el.dataset.event))===${JSON.stringify(JSON.stringify(tags))}`))
    check('每類都有相鄰中英按鈕，沒有重複標題或語言前綴', await cdp.eval(`speechEvents.querySelectorAll('.speech-event-group').length===9 && [...speechEvents.querySelectorAll('.speech-event-group')].every(el=>{const buttons=[...el.children];return buttons.length===2&&buttons.every(b=>b.matches('button[data-event]'))&&buttons[0].dataset.event.startsWith('[')&&buttons[1].dataset.event.startsWith('(')}) && !/中文|English|加入聲音|延伸語氣/.test(speechEvents.textContent)`))
    for (const tag of tags) {
      await cdp.eval(`speechText.value='甲乙';speechText.setSelectionRange(1,2)`)
      await cdp.click(`#speechEvents [data-event="${tag}"]`)
      check(`${tag} 替換選取台詞並更新字數`, await cdp.eval(`speechText.value===${JSON.stringify('甲'+tag)} && speechText.selectionStart===speechText.value.length && speechCount.textContent===speechText.value.length+' / 100000'`))
    }
    await cdp.eval(`speechText.value='';speechText.dispatchEvent(new Event('input'))`)
    check('未下載提示可見，生成被停用', await visible(cdp, 'speechInstallNotice') && await cdp.eval(`document.getElementById('speechGenerate').disabled`))
    check('沒有版本時顯示說明，不顯示空播放器', await visible(cdp, 'speechDockEmpty') && !(await visible(cdp, 'speechDockBody')))
    const missing = await cdp.eval(`window.electronAPI.breeze.generate({reqId:'qa-uninstalled',mode:'design',text:'你好',instruction:'溫暖清晰'})`)
    check('真正 IPC 拒絕未下載模型', missing?.ok === false && missing.error.code === 'NOT_INSTALLED')
    const invalid = await cdp.eval(`window.electronAPI.breeze.generate({reqId:'qa-invalid',mode:'invalid'})`)
    check('真正 IPC 拒絕錯誤輸入', invalid?.ok === false && invalid.error.code === 'INVALID_INPUT')
    const cancel = await cdp.eval(`window.electronAPI.breeze.cancel({reqId:'unrelated-request'})`)
    check('真正 IPC 錯誤請求代碼不取消', cancel?.ok === true && cancel.data.canceled === false)
    const takeMissing = await cdp.eval(`window.electronAPI.breeze.loadTake({id:'../../etc'})`)
    check('真正 IPC 拒絕不合法的版本代碼', takeMissing?.ok === false && takeMissing.error.code === 'INVALID_INPUT')
    await cdp.click('#speechModelsBtn')
    await waitFor(() => cdp.eval(`!!document.querySelector('#modelList [data-key="breezetts2q8"]')`), 'Q8 推薦')
    check('前往 Local SI 推薦真的開執行環境裡的推薦模型', await cdp.eval(`document.querySelector('#hfSubtabs [data-subtab="runtime"]').getAttribute('aria-selected')==='true' && !!document.querySelector('#hf-runtime #hf-recommend #modelList')`))
    await cdp.click('.nav-tab[data-page="speech"]')
    const streamVisibility = []
    for (const mode of ['design', 'clone', 'direction', 'convert']) {
      await cdp.click(`.speech-mode[data-mode="${mode}"]`)
      const state = await cdp.eval(`({reference:speechReference.offsetHeight>0,source:speechSource.offsetHeight>0,instruction:speechInstructionGroup.offsetHeight>0,events:speechEvents.offsetHeight>0,stream:speechStreamLabel.offsetHeight>0,scripts:[...document.querySelectorAll('.speech-script-mode')].filter(b=>!b.disabled).length})`)
      streamVisibility.push(state.stream === (mode !== 'convert'))
      check(`${mode} 對應欄位有真實尺寸`, state.reference === (mode !== 'design') && state.source === (mode === 'convert') && state.instruction === ['design', 'direction'].includes(mode) && state.events === (mode !== 'convert'))
      check(`${mode} 生成方式：變聲只能整段`, state.scripts === (mode === 'convert' ? 1 : 3))
      check(`${mode} 只顯示需要的台詞說明`, await cdp.eval(`speechTextHint.hidden===${mode !== 'convert'} && speechTextHint.textContent.includes(${JSON.stringify(mode === 'convert' ? '變聲需要原錄音' : '(English description)')})`))
      check(`${mode} 進階欄位只保留適用項目`, await cdp.eval(`['speechTopP','speechRepetition','speechSplit','speechMaxTokens'].every(id=>{const input=document.getElementById(id);return input.disabled===${mode === 'convert'} && input.closest('label').hidden===${mode === 'convert'}})`))
    }
    check('三種語音模式顯示串流，變聲收合串流選項', streamVisibility.every(Boolean))
    check('變聲先選原錄音再填選填逐字稿', await cdp.eval(`speechSource.getBoundingClientRect().bottom<=speechText.getBoundingClientRect().top`))
    await cdp.key('End', 'End', 35)
    check('鍵盤切換同步變聲操作文字與面板名稱', await cdp.eval(`speechGenerate.textContent==='開始變聲' && speechForm.getAttribute('aria-labelledby')===document.activeElement.id && document.activeElement.getAttribute('aria-controls')==='speechForm'`))
    await cdp.key('Home', 'Home', 36)
    check('Home 鍵切到聲音設計且只留一個 Tab 位置', await cdp.eval(`document.activeElement.dataset.mode==='design' && [...document.querySelectorAll('.speech-mode')].filter(el=>el.tabIndex===0).length===1`))
    await cdp.key('ArrowRight', 'ArrowRight', 39)
    check('方向鍵切到語音克隆', await cdp.eval(`document.activeElement.dataset.mode==='clone' && document.activeElement.getAttribute('aria-selected')==='true'`))
    check('鍵盤切回同步生成按鈕文字', await cdp.eval(`speechGenerate.textContent==='生成語音'`))
    await cdp.eval(`(() => {
      const Base=window.AudioContext; window.__speechStreams=0;
      window.AudioContext=class extends Base {
        createBufferSource() { const node=super.createBufferSource(), start=node.start.bind(node);
          node.start=(...args)=>{window.__speechStreams++;start(...args)}; return node; }
      };
    })()`)
    await installFixture(inspector)
    await cdp.click('.nav-tab[data-page="chat"]')
    await cdp.click('.nav-tab[data-page="speech"]')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled`), '已安裝 fixture')

    // ── 參考音：選檔、波形、裁切、錄音 ──
    await cdp.click('#speechPickReference')
    await waitFor(() => cdp.eval(`speechReferenceName.textContent.includes('qa-reference.wav')`), '參考音訊')
    check('選參考音自動填入逐字稿', await cdp.eval(`speechRefText.value==='自動辨識的參考內容'`))
    check('參考音顯示波形', await cdp.eval(`document.querySelector('#speechReferenceInput .speech-input-wave').offsetHeight>0`))
    await drag(cdp, '#speechReferenceInput canvas', 0.2, 0.7)
    check('拖曳波形選出範圍並可裁切', await cdp.eval(`document.querySelector('#speechReferenceInput .speech-trim-range').textContent.startsWith('選取') && !document.querySelector('#speechReferenceInput .speech-trim-apply').disabled`))
    await cdp.click('#speechReferenceInput .speech-trim-apply')
    await waitFor(() => cdp.eval(`speechReferenceName.textContent.includes('qa-trimmed.wav')`), '裁切')
    const trim = await inspector.eval(`global.__speechQA.trims.at(-1)`)
    check('裁切送出選取秒數', trim.audioId === 'qa-reference-qa-reference.wav' && trim.start > 0.1 && trim.end < 0.8 && trim.end - trim.start > 0.3)
    await cdp.click('#speechReferenceInput .speech-record')
    await waitFor(() => cdp.eval(`document.querySelector('#speechReferenceInput .speech-record').classList.contains('recording') || !speechError.hidden`), '開始錄音')
    check('麥克風錄音開始並顯示停止按鈕', await cdp.eval(`document.querySelector('#speechReferenceInput .speech-record').getAttribute('aria-pressed')==='true'`))
    await sleep(800)
    await cdp.click('#speechReferenceInput .speech-record')
    await waitFor(() => cdp.eval(`speechReferenceName.textContent.includes('錄音-qa')`), '錄音匯入')
    check('錄音內容送到 main 轉檔', (await inspector.eval(`global.__speechQA.recordings.at(-1)`)).bytes > 0)

    await fill(cdp, {speechRefText:'測試參考音訊', speechVoiceName:'q'.repeat(64), speechText:'你好，測試聲音。', speechInstruction:'溫暖自然'})
    await cdp.click('#speechSaveVoice')
    await waitFor(() => cdp.eval(`speechVoice.value==='${'q'.repeat(64)}'`), '保存聲音')
    check('聲音保存後顯示收藏並收合錄音欄', await cdp.eval(`speechNewReference.offsetHeight===0 && !speechDeleteVoice.disabled`))
    check('64 字聲音名稱完整換行且無溢出', await cdp.eval(`(() => {
      const trigger=speechVoice.parentElement.querySelector('.custom-select-trigger');
      return trigger.offsetHeight>0 && getComputedStyle(trigger).textOverflow!=='ellipsis' && trigger.scrollWidth<=trigger.clientWidth+1;
    })()`))

    // ── 四種模式整段生成，每次都留成版本 ──
    for (const mode of ['design', 'clone', 'direction', 'convert']) {
      const before = await inspector.eval(`global.__speechQA.takes.length`)
      await cdp.click(`.speech-mode[data-mode="${mode}"]`)
      if (mode === 'convert') { await cdp.click('#speechPickSource'); await waitFor(() => cdp.eval(`speechSourceName.textContent.includes('qa-source.wav')`), '原錄音') }
      await cdp.click('#speechGenerate')
      await waitFor(async () => (await inspector.eval(`global.__speechQA.takes.length`)) > before && cdp.eval(`!speechGenerate.disabled && !speechDockBody.hidden`), `生成 ${mode}`)
      const request = await inspector.eval(`global.__speechQA.requests.at(-1)`)
      check(`fixture ${mode} 表單完整送到真正 IPC`, request.mode === mode && request.text === '你好，測試聲音。' && request.temperature === (mode === 'convert' ? 0.3 : 0.9) && (mode === 'design' || request.voiceId === 'q'.repeat(64)) && (mode !== 'convert' || request.sourceAudioId === 'qa-source-qa-source.wav' && request.topP === undefined))
    }
    await waitFor(() => cdp.eval(`speechPlayer.readyState>=2`), 'WAV 解碼')
    check('生成結果真的可由 audio 解碼', await cdp.eval(`Number.isFinite(speechPlayer.duration) && speechPlayer.duration>0 && !speechPlayer.error`))
    check('三種語音模式 PCM 排入串流播放，變聲等待完整結果', await cdp.eval(`window.__speechStreams===3`))
    check('每次生成都多一個版本，最新的在最上面', await cdp.eval(`speechTakes.options.length===4 && speechTakes.selectedIndex===0 && speechTakes.options[0].textContent.startsWith('版本 4')`))
    await cdp.click('#speechPlay')
    await waitFor(() => cdp.eval(`!speechPlayer.paused || speechPlayer.ended`), '播放')
    check('播放鍵控制隱藏的 audio', await cdp.eval(`speechPlayer.currentTime>0 || !speechPlayer.paused`))
    await cdp.click('#speechExport')
    await waitFor(() => cdp.eval(`speechProgress.textContent==='WAV 已匯出。'`), '匯出結果')
    check('匯出送出目前版本 ID', await inspector.eval(`global.__speechQA.exports.at(-1).takeId===global.__speechQA.takes[0].id`))
    await cdp.eval(`speechTakes.value=speechTakes.options[2].value; speechTakes.dispatchEvent(new Event('change'))`)
    await waitFor(() => cdp.eval(`speechResultTitle.textContent.length>0 && speechTakes.selectedIndex===2`), '切換版本')
    check('切換版本載入對應音檔', await cdp.eval(`speechTakes.value`) === await inspector.eval(`global.__speechQA.takes[2].id`))

    // ── 讀音字典 ──
    await cdp.click('.speech-mode[data-mode="design"]')
    await cdp.eval(`speechText.value='重慶很重要';speechText.dispatchEvent(new Event('input'));speechText.setSelectionRange(0,2)`)
    await cdp.click('#speechPronounceBtn')
    check('選取文字按讀音直接帶入原字', await cdp.eval(`!speechPronounce.hidden && speechPronounceWord.value==='重慶'`))
    await fill(cdp, { speechPronounceSound: '崇慶' })
    await cdp.click('#speechPronounceAdd')
    await waitFor(() => cdp.eval(`speechPronounceList.children.length===1`), '讀音加入')
    check('讀音數量顯示在按鈕上', await cdp.eval(`speechPronounceCount.textContent==='1' && !speechPronounceCount.hidden`))
    check('讀音字典存進設定', JSON.stringify(await cdp.eval(`window.electronAPI.store.get('speechPronunciations')`)) === JSON.stringify([{ word: '重慶', sound: '崇慶' }]))
    await cdp.click('#speechGenerate')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechProgress.textContent.includes('新版本')`), '讀音生成')
    check('生成時套用讀音、原稿不變', (await inspector.eval(`global.__speechQA.requests.at(-1).text`)) === '崇慶很重要' && await cdp.eval(`speechText.value==='重慶很重要'`))
    await cdp.click('#speechPronounceList .btn-icon')
    await waitFor(() => cdp.eval(`speechPronounceList.children.length===0`), '讀音移除')

    // ── 逐句生成與單句重做 ──
    await cdp.click('.speech-script-mode[data-script="sentences"]')
    await cdp.eval(`speechText.value='第一句話說得很清楚。第二句話也一樣清楚。\\n第三句是新的段落開頭。';speechText.dispatchEvent(new Event('input'))`)
    check('逐句模式在按鈕上顯示句數', await cdp.eval(`speechGenerate.textContent==='生成語音 · 3 句'`))
    let count = await inspector.eval(`global.__speechQA.requests.length`)
    await cdp.click('#speechGenerate')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechSegments.children.length===3`), '逐句生成')
    check('逐句生成送出三次請求', (await inspector.eval(`global.__speechQA.requests.length`)) === count + 3)
    check('版本帶三句與段落停頓', JSON.stringify(await inspector.eval(`global.__speechQA.saved.parts.map(p=>p.gap)`)) === JSON.stringify([0.3, 0.7, 0]))
    check('分句清單可見並有試聽、修改、重做', await cdp.eval(`[...speechSegments.children].every(row=>row.querySelector('.seg-play')&&row.querySelector('.seg-edit')&&row.querySelector('.seg-redo')) && speechSegments.offsetHeight>0`))
    const takeId = await inspector.eval(`global.__speechQA.takes[0].id`)
    await cdp.click('#speechSegments li:nth-child(2) .seg-edit')
    await cdp.eval(`(() => { const a=document.querySelector('#speechSegments li:nth-child(2) .seg-input'); a.value='第二句改過了。'; })()`)
    count = await inspector.eval(`global.__speechQA.requests.length`)
    await cdp.click('#speechSegments li:nth-child(2) .seg-redo')
    await waitFor(async () => (await inspector.eval(`global.__speechQA.takes[0].id`)) !== takeId && cdp.eval(`!speechGenerate.disabled`), '重做單句')
    const redoRequest = await inspector.eval(`global.__speechQA.requests.at(-1)`)
    const redoParts = await inspector.eval(`global.__speechQA.saved.parts`)
    check('重做只送一次請求、換隨機種子、用修改後文字', (await inspector.eval(`global.__speechQA.requests.length`)) === count + 1 && redoRequest.seed !== 42 && redoRequest.text === '第二句改過了。')
    check('其他句沿用原版本', redoParts[0].takeId === takeId && redoParts[0].index === 0 && redoParts[2].takeId === takeId && redoParts[2].index === 2 && redoParts[1].resultId)
    check('重做後顯示新版本與新文字', await cdp.eval(`speechSegments.children[1].querySelector('.seg-text').textContent==='第二句改過了。' && speechTakes.selectedIndex===0`))

    // ── 停止時保留已完成的句子 ──
    await inspector.eval(`global.__speechQA.behavior='pendingSecond'; global.__speechQA.requests.length=0`)
    await cdp.click('#speechGenerate')
    await waitFor(() => inspector.eval(`!!global.__speechQA.pending`), '第二句進行中')
    check('生成期間停用表單，停止按鈕可見', await cdp.eval(`speechText.disabled && speechCancel.offsetHeight>0 && !speechCancel.disabled`))
    await cdp.click('#speechCancel')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechProgress.textContent.includes('已停止')`), '停止')
    check('停止後保留完成的第一句成為版本', await cdp.eval(`speechProgress.textContent.includes('保留了完成的 1 句')`) && (await inspector.eval(`global.__speechQA.saved.parts.length`)) === 1)
    check('取消只送目前請求代碼', await inspector.eval(`global.__speechQA.canceled.at(-1)===global.__speechQA.requests.at(-1).reqId`))
    await inspector.eval(`global.__speechQA.behavior='success'`)

    // ── 字幕配音 ──
    await cdp.click('.speech-script-mode[data-script="subtitle"]')
    check('字幕模式顯示匯入與說明、隱藏台詞框', await cdp.eval(`speechImportSubtitle.offsetHeight>0 && speechCuesEmpty.offsetHeight>0 && speechText.offsetHeight===0 && speechEvents.offsetHeight===0`))
    const srt = path.join(USER_DATA, 'qa.srt')
    fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:01,000\n小明：早安！\n\n2\n00:00:02,000 --> 00:00:03,000\n小華：你好。\n\n3\n00:00:02,050 --> 00:00:03,000\n小明：今天天氣真好。\n')
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#speechSubtitleFile' })
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [srt] })
    await waitFor(() => cdp.eval(`speechCueList.children.length===3`), '字幕匯入')
    check('字幕列出台詞、角色與時間', await cdp.eval(`speechCount.textContent==='3 句 · 2 個角色' && speechCueList.children[0].textContent.includes('小明') && speechCueList.children[0].textContent.includes('00:00')`))
    check('角色聲音清單列出每個角色', await cdp.eval(`speechSpeakers.offsetHeight>0 && speechSpeakerList.children.length===2`))
    await cdp.eval(`(() => { const s=speechSpeakerList.children[0].querySelector('select'); s.value=${JSON.stringify('q'.repeat(64))}; s.dispatchEvent(new Event('change')); })()`)
    count = await inspector.eval(`global.__speechQA.requests.length`)
    await cdp.click('#speechGenerate')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechSegments.children.length===3`), '字幕生成')
    const subRequests = await inspector.eval(`global.__speechQA.requests.slice(${count})`)
    check('指定聲音的角色改用克隆，其他角色照右側設定', subRequests[0].mode === 'clone' && subRequests[0].voiceId === 'q'.repeat(64) && subRequests[1].mode === 'design' && subRequests[2].voiceId === 'q'.repeat(64))
    const cueParts = await inspector.eval(`global.__speechQA.saved`)
    check('字幕版本依時間放置並帶角色', cueParts.placement === 'cue' && JSON.stringify(cueParts.parts.map((p) => [p.at, p.speaker])) === JSON.stringify([[0.5, '小明'], [2, '小華'], [2.05, '小明']]))
    check('分句清單顯示角色標籤', await cdp.eval(`speechSegments.children[1].querySelector('.seg-speaker').textContent==='小華'`))
    await cdp.click('.speech-script-mode[data-script="whole"]')

    // ── 刪除版本與聲音 ──
    const takesBefore = await cdp.eval(`speechTakes.options.length`)
    await cdp.click('#speechDeleteTake')
    await waitFor(() => cdp.eval(`!!document.querySelector('dialog.app-dialog[open]')`), '版本刪除確認')
    await cdp.click('dialog.app-dialog[open] .btn-danger')
    await waitFor(() => cdp.eval(`speechTakes.options.length===${takesBefore - 1}`), '版本刪除')
    check('刪除版本後自動切到最新的另一版', await cdp.eval(`speechTakes.selectedIndex===0 && !speechDockBody.hidden`))
    await cdp.click('.speech-mode[data-mode="clone"]')
    await cdp.click('#speechDeleteVoice')
    await waitFor(() => cdp.eval(`!!document.querySelector('dialog.app-dialog[open]')`), '聲音刪除確認')
    await cdp.click('dialog.app-dialog[open] .btn-danger')
    await waitFor(() => cdp.eval(`speechVoice.options.length===1`), '聲音刪除')
    check('聲音刪除後還原新參考錄音', await cdp.eval(`speechNewReference.offsetHeight>0 && speechDeleteVoice.disabled`))
    await cdp.click('.speech-mode[data-mode="design"]')
    await cdp.eval(`speechText.value='你好，測試聲音。';speechText.dispatchEvent(new Event('input'))`)
    await inspector.eval(`global.__speechQA.behavior='pending'`)
    await cdp.click('#speechGenerate')
    await waitFor(() => inspector.eval(`!!global.__speechQA.pending`), '生成進行中')
    const before = await cdp.eval(`speechProgress.textContent`)
    await inspector.eval(`process.mainModule.require('electron').webContents.getAllWebContents().forEach(c=>c.send('breeze:progress',{reqId:'wrong-token',phase:'generating',seconds:999}))`)
    await sleep(200)
    check('過期事件不修改目前生成進度', await cdp.eval(`speechProgress.textContent`) === before)
    await cdp.click('#speechCancel')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechProgress.textContent.includes('已停止')`), '取消生成')
    await inspector.eval(`global.__speechQA.behavior='error'`)
    await cdp.click('#speechGenerate')
    await waitFor(() => cdp.eval(`speechError.textContent.includes('測試：請重新選擇錄音')`), 'main 錯誤')
    check('main 結構化錯誤可見，表單可重試', await cdp.eval(`speechError.offsetHeight>0 && !speechGenerate.disabled`))
    if (REAL) await realModelGate(cdp, inspector)
    await cdp.click('.speech-mode[data-mode="design"]')
    await cdp.click('.speech-script-mode[data-script="sentences"]')
    await cdp.eval(`speechError.hidden=true; speechTakes.value=speechTakes.options[0].value; speechTakes.dispatchEvent(new Event('change'))`)
    for (const width of [1440, 1000, 760, 640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false })
      for (const theme of ['dark', 'light']) {
        await cdp.eval(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});
          document.querySelectorAll('#page-speech,.main-content,.content').forEach(el=>el.scrollTop=0); document.documentElement.scrollTop=0; document.body.scrollTop=0;`)
        await sleep(100)
        const geometry = await cdp.eval(`({overflow:document.querySelector('.speech-workbench').scrollWidth>document.querySelector('.speech-workbench').clientWidth+1,columns:getComputedStyle(speechForm).gridTemplateColumns.split(' ').length,color:getComputedStyle(speechText).color,background:getComputedStyle(speechText).backgroundColor,dock:document.querySelector('.speech-dock').scrollWidth<=document.querySelector('.speech-dock').clientWidth+1})`)
        check(`${width}px ${theme} 欄位無溢出，顏色有值`, !geometry.overflow && geometry.dock && geometry.color !== geometry.background && (width > 760 || geometry.columns === 1))
        check(`${width}px ${theme} 標記分組無溢出且按鈕可點`, await cdp.eval(`speechEvents.scrollWidth<=speechEvents.clientWidth+1 && [...speechEvents.querySelectorAll('.speech-event-group,button')].every(el=>el.scrollWidth<=el.clientWidth+1) && [...speechEvents.querySelectorAll('button')].every(el=>el.getBoundingClientRect().height>=43)`))
        check(`${width}px ${theme} 中英文保持成對同列`, await cdp.eval(`[...speechEvents.querySelectorAll('.speech-event-group')].every(el=>Math.abs(el.children[0].getBoundingClientRect().top-el.children[1].getBoundingClientRect().top)<1)`))
        check(`${width}px ${theme} 分句列沒有溢出`, await cdp.eval(`[...speechSegments.children].every(row=>row.scrollWidth<=row.clientWidth+1)`))
        for (const mode of ['design', 'clone', 'direction', 'convert']) {
          await cdp.click(`.speech-mode[data-mode="${mode}"]`)
          await waitFor(() => cdp.eval(`[...document.querySelectorAll('.speech-mode')].every(el=>el.getAnimations().length===0)`), '選單切換完成')
          const menu = await cdp.eval(`(() => {
            const tabs=[...document.querySelectorAll('.speech-mode')], selected=tabs.find(el=>el.getAttribute('aria-selected')==='true');
            const fits=tabs.every(el=>el.scrollWidth<=el.clientWidth+1 && el.offsetHeight>=44 && el.querySelector('.speech-mode-description'));
            const order=${JSON.stringify(mode)}==='direction' ? speechReference.getBoundingClientRect().bottom<=speechInstructionGroup.getBoundingClientRect().top : true;
            return {fits,order,mode:selected.dataset.mode,background:getComputedStyle(selected).backgroundColor,otherBackground:getComputedStyle(tabs.find(el=>el!==selected)).backgroundColor};
          })()`)
          assert(menu.fits && menu.order && menu.mode===mode && menu.background!==menu.otherBackground, JSON.stringify(menu))
          check(`${width}px ${theme} ${mode} 選單與欄位順序清楚`, true)
        }
        await cdp.click('.speech-mode[data-mode="design"]')
        check(`${width}px ${theme} 離開變聲還原逐句模式`, await cdp.eval(`speechForm.dataset.script==='sentences'`))
        if (SHOTS) {
          await inspector.eval(`${hostWindow}.showInactive()`)
          const shot = await cdp.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false })
          fs.writeFileSync(path.join(SHOTS, `speech-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'))
          await cdp.eval(`document.querySelector('.speech-dock').scrollIntoView({block:'end'})`)
          await sleep(150)
          const dockShot = await cdp.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false })
          fs.writeFileSync(path.join(SHOTS, `speech-${width}-${theme}-dock.png`), Buffer.from(dockShot.data, 'base64'))
        }
      }
    }
    check('整個流程沒有未處理例外', cdp.exceptions.length === 0)
    console.log(`ALL PASS — ${passed} passed; ${REAL ? '含真 Q8 design / saved-voice clone／逐句／重做／字幕。' : 'UI fixture，不代表模型推論。'}${SHOTS ? ` 截圖：${SHOTS}` : ''}`)
  } finally {
    cdp?.close(); inspector?.close()
    killTree(child)
    killTree(vite)
  }
}

main().catch((error) => { console.error(`FAIL ${error.stack}`); process.exitCode = 1 })
