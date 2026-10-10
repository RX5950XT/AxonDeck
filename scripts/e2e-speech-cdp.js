/**
 * node scripts/e2e-speech-cdp.js — isolated packaged UI / real preload / IPC.
 * 驗真正未下載的守衛與替換 Breeze exports 的畫面流程；BREEZE_QA_CACHE 有模型時另驗真 Q8 推論。
 * AXONDECK_SHOT_DIR 可保留截圖；視窗 showInactive 不搶焦點。
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const { wavHeader } = require('../src/main/breeze-tts/protocol')
const ROOT = path.join(__dirname, '..')
const EXE = process.env.AXONDECK_EXE || path.join(ROOT, 'dist/win-unpacked/AxonDeck.exe')
const USER_DATA = tempDir('speech-cdp-')
const SHOTS = process.env.AXONDECK_SHOT_DIR || ''
const CACHE = process.env.BREEZE_QA_CACHE || ''
const PORT = 9253
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
    found = main ? rows[0] : rows.find((row) => row.type === 'page' && /index\.html/.test(row.url))
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
    const service = req(req('node:path').join(req('electron').app.getAppPath(),'src/main/breeze-tts'));
    global.__speechOriginal = {...service};
    const win = req('electron').BrowserWindow.getAllWindows().find(w => /index\\.html/.test(w.webContents.getURL()));
    global.__speechQA = { requests:[], voices:[], exports:[], canceled:[], behavior:'success', pending:null };
    const qa = global.__speechQA;
    service.status = async () => ({installed:true,ready:true});
    service.voices = async () => qa.voices;
    service.pickAudio = async ({kind}) => ({audioId:'qa-'+kind,name:'qa-'+kind+'.wav',duration:0.1,...(kind==='reference'?{transcript:'自動辨識的參考內容'}:{})});
    service.saveVoice = async (options) => { const voice={id:options.name,seconds:0.1}; qa.voices.push(voice); return voice; };
    service.removeVoice = async ({id}) => { qa.voices=qa.voices.filter(v=>v.id!==id); return {deleted:id}; };
    service.saveAudio = async (options) => { qa.exports.push(options); return {saved:true}; };
    service.cancel = async ({reqId}) => { qa.canceled.push(reqId); qa.pending?.reject(Object.assign(new Error('已停止語音生成'),{userMessage:'已停止語音生成',code:'CANCELED'})); return {canceled:true}; };
    service.generate = async (options) => {
      qa.requests.push(options);
      if(qa.behavior==='error') throw Object.assign(new Error('測試：請重新選擇錄音'),{userMessage:'測試：請重新選擇錄音',code:'INVALID_AUDIO'});
      win.webContents.send('breeze:progress',{reqId:options.reqId,phase:'generating',seconds:0.05});
      win.webContents.send('breeze:chunk',{reqId:options.reqId,pcmBase64:${JSON.stringify(pcm.toString('base64'))},sampleRate:24000,seconds:0.1});
      if(qa.behavior==='pending') return new Promise((resolve,reject)=>{qa.pending={resolve,reject};});
      await new Promise(resolve=>setTimeout(resolve,100));
      return {resultId:'qa-result-'+qa.requests.length,audioBase64:${JSON.stringify(audioBase64)},mimeType:'audio/wav',duration:0.1,sampleRate:24000};
    };
    win.webContents.send('breeze:status',{installed:true,ready:true}); return true;
  })()`)
}

async function realModelGate(cdp, inspector) {
  const model = path.join(CACHE, 'breeze-tts-2-q8_0.gguf')
  const runtime = path.join(CACHE, 'runtime/breeze-tts-2-v0.1.0-windows-x64-vulkan/breeze-server.exe')
  assert(fs.existsSync(model) && fs.existsSync(runtime), 'BREEZE_QA_CACHE 缺少 Q8 模型或執行環境')
  const exported = path.join(USER_DATA, 'qa-real-design.wav')
  await inspector.eval(`(() => {
    const req=process.mainModule.require.bind(process.mainModule), root=req('electron').app.getAppPath();
    const service=req(req('node:path').join(root,'src/main/breeze-tts'));
    Object.assign(service,global.__speechOriginal);
    const models=req(req('node:path').join(root,'src/main/models')), original=models.filePath, originalDir=models.modelDir;
    models.filePath=(key,part)=>key==='breezetts2q8' && part==='gguf' ? ${JSON.stringify(model)} : key==='breezeruntime' && part==='binary' ? ${JSON.stringify(runtime)} : original(key,part);
    models.modelDir=key=>key==='breezetts2q8' ? ${JSON.stringify(CACHE)} : key==='breezeruntime' ? ${JSON.stringify(path.join(CACHE,'runtime'))} : originalDir(key);
    const dialog=req('electron').dialog;
    dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(exported)}});
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
  const status = await cdp.eval(`window.electronAPI.breeze.status()`)
  console.log(`真 Q8 backend: ${status.data?.backend}`)
  await inspector.eval(`process.mainModule.require(process.mainModule.require('node:path').join(process.mainModule.require('electron').app.getAppPath(),'src/main/breeze-tts')).shutdown()`)
}

async function main() {
  const child = spawn(EXE, ['--hidden', '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`],
  { detached: true, windowsHide: true, stdio: 'ignore', shell: false })
  let cdp, inspector
  try {
    cdp = await target(PORT)
    inspector = await target(INSPECT, true)
    await inspector.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).webContents.setAudioMuted(true)`)
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(() => cdp.eval(`document.readyState==='complete' && !!window.electronAPI?.breeze`), 'preload')
    check('導航新增文字轉語音，全部 10 頁', await cdp.eval(`document.querySelectorAll('.nav-tab[data-page]').length===10 && !!document.querySelector('.nav-tab[data-page="speech"]')`))
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
    const missing = await cdp.eval(`window.electronAPI.breeze.generate({reqId:'qa-uninstalled',mode:'design',text:'你好',instruction:'溫暖清晰'})`)
    check('真正 IPC 拒絕未下載模型', missing?.ok === false && missing.error.code === 'NOT_INSTALLED')
    const invalid = await cdp.eval(`window.electronAPI.breeze.generate({reqId:'qa-invalid',mode:'invalid'})`)
    check('真正 IPC 拒絕錯誤輸入', invalid?.ok === false && invalid.error.code === 'INVALID_INPUT')
    const cancel = await cdp.eval(`window.electronAPI.breeze.cancel({reqId:'unrelated-request'})`)
    check('真正 IPC 錯誤請求代碼不取消', cancel?.ok === true && cancel.data.canceled === false)
    await cdp.click('#speechModelsBtn')
    await waitFor(() => cdp.eval(`!!document.querySelector('#modelList [data-key="breezetts2q8"]')`), 'Q8 推薦')
    check('前往 Local SI 推薦真的開推薦子分頁', await cdp.eval(`document.querySelector('#hfSubtabs [data-subtab="recommend"]').getAttribute('aria-selected')==='true'`))
    check('Local SI 語音生成推薦 Q8 模型', await cdp.eval(`document.querySelector('#modelList [data-key="breezetts2q8"]').textContent.includes('Q8') && document.getElementById('modelList').textContent.includes('語音生成')`))
    await cdp.click('#hfSubtabs [data-subtab="runtime"]')
    await waitFor(() => cdp.eval(`!!document.querySelector('[data-runtime="breezeruntime"]')`), 'Breeze 執行環境')
    check('Breeze 執行環境獨立列出', await cdp.eval(`!!document.querySelector('[data-runtime="breezeruntime"]') && !document.querySelector('#modelList [data-key="breezeruntime"]')`))
    await cdp.click('.nav-tab[data-page="speech"]')
    const streamVisibility = []
    for (const mode of ['design', 'clone', 'direction', 'convert']) {
      await cdp.click(`.speech-mode[data-mode="${mode}"]`)
      const state = await cdp.eval(`({reference:speechReference.offsetHeight>0,source:speechSource.offsetHeight>0,instruction:speechInstructionGroup.offsetHeight>0,events:speechEvents.offsetHeight>0,required:speechText.required,stream:speechStreamLabel.offsetHeight>0})`)
      streamVisibility.push(state.stream === (mode !== 'convert'))
      check(`${mode} 對應欄位有真實尺寸`, state.reference === (mode !== 'design') && state.source === (mode === 'convert') && state.instruction === ['design', 'direction'].includes(mode) && state.events === (mode !== 'convert') && state.required === (mode !== 'convert'))
      check(`${mode} 只顯示需要的台詞說明`, await cdp.eval(`speechTextHint.hidden===${mode !== 'convert'} && speechTextHint.textContent.includes(${JSON.stringify(mode === 'convert' ? '變聲需要原錄音' : '(English description)')})`))
      check(`${mode} 進階欄位只保留適用項目`, await cdp.eval(`['speechTopP','speechRepetition','speechSplit','speechMaxTokens'].every(id=>{const input=document.getElementById(id);return input.disabled===${mode === 'convert'} && input.closest('label').hidden===${mode === 'convert'}})`))
    }
    check('三種語音模式顯示串流，變聲收合串流選項', streamVisibility.every(Boolean))
    check('變聲先選原錄音再填選填逐字稿', await cdp.eval(`speechSource.getBoundingClientRect().bottom<=speechTextLabel.getBoundingClientRect().top`))
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
    await cdp.click('#speechPickReference')
    await waitFor(() => cdp.eval(`speechReferenceName.textContent.includes('qa-reference.wav')`), '參考音訊')
    check('選參考音自動填入逐字稿', await cdp.eval(`speechRefText.value==='自動辨識的參考內容'`))
    await fill(cdp, {speechRefText:'測試參考音訊', speechVoiceName:'q'.repeat(64), speechText:'你好，測試聲音。', speechInstruction:'溫暖自然'})
    await cdp.click('#speechSaveVoice')
    await waitFor(() => cdp.eval(`speechVoice.value==='${'q'.repeat(64)}'`), '保存聲音')
    check('聲音保存後顯示收藏並收合錄音欄', await cdp.eval(`speechNewReference.offsetHeight===0 && !speechDeleteVoice.disabled`))
    check('64 字聲音名稱完整換行且無溢出', await cdp.eval(`(() => {
      const trigger=speechVoice.parentElement.querySelector('.custom-select-trigger');
      return trigger.offsetHeight>0 && getComputedStyle(trigger).textOverflow!=='ellipsis' && trigger.scrollWidth<=trigger.clientWidth+1;
    })()`))
    for (const mode of ['design', 'clone', 'direction', 'convert']) {
      await cdp.click(`.speech-mode[data-mode="${mode}"]`)
      if (mode === 'convert') { await cdp.click('#speechPickSource'); await waitFor(() => cdp.eval(`speechSourceName.textContent.includes('qa-source.wav')`), '原錄音') }
      await cdp.click('#speechGenerate')
      await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechPlayer.offsetHeight>0`), `生成 ${mode}`)
      const request = await inspector.eval(`global.__speechQA.requests.at(-1)`)
      check(`fixture ${mode} 表單完整送到真正 IPC`, request.mode === mode && request.text === '你好，測試聲音。' && request.temperature === (mode === 'convert' ? 0.3 : 0.9) && (mode === 'design' || request.voiceId === 'q'.repeat(64)) && (mode !== 'convert' || request.sourceAudioId === 'qa-source' && request.topP === undefined))
    }
    await waitFor(() => cdp.eval(`speechPlayer.readyState>=2`), 'WAV 解碼')
    check('生成結果真的可由 audio 解碼', await cdp.eval(`Number.isFinite(speechPlayer.duration) && speechPlayer.duration>0 && !speechPlayer.error`))
    check('三種語音模式 PCM 排入串流播放，變聲等待完整結果', await cdp.eval(`window.__speechStreams===3`))
    await cdp.click('#speechExport')
    await waitFor(() => cdp.eval(`speechProgress.textContent==='WAV 已匯出。'`), '匯出結果')
    check('匯出送出對應結果 ID', await inspector.eval(`global.__speechQA.exports.at(-1).resultId==='qa-result-4'`))
    await cdp.click('#speechDeleteVoice')
    await waitFor(() => cdp.eval(`!!document.querySelector('dialog.app-dialog[open]')`), '聲音刪除確認')
    await cdp.click('dialog.app-dialog[open] .btn-danger')
    await waitFor(() => cdp.eval(`speechVoice.options.length===1`), '聲音刪除')
    check('聲音刪除後還原新參考錄音', await cdp.eval(`speechNewReference.offsetHeight>0 && speechDeleteVoice.disabled`))
    await cdp.click('.speech-mode[data-mode="design"]')
    await inspector.eval(`global.__speechQA.behavior='pending'`)
    await cdp.click('#speechGenerate')
    await waitFor(() => inspector.eval(`!!global.__speechQA.pending`), '生成進行中')
    const before = await cdp.eval(`speechProgress.textContent`)
    await inspector.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).webContents.send('breeze:progress',{reqId:'wrong-token',phase:'generating',seconds:999})`)
    check('過期事件不修改目前生成進度', await cdp.eval(`speechProgress.textContent`) === before)
    check('生成期間停用表單，取消按鈕可見', await cdp.eval(`speechText.disabled && speechCancel.offsetHeight>0 && !speechCancel.disabled`))
    await cdp.click('#speechCancel')
    await waitFor(() => cdp.eval(`!speechGenerate.disabled && speechError.textContent.includes('已停止')`), '取消生成')
    check('取消只送目前請求代碼', await inspector.eval(`global.__speechQA.canceled.at(-1)===global.__speechQA.requests.at(-1).reqId`))
    await inspector.eval(`global.__speechQA.behavior='error'`)
    await cdp.click('#speechGenerate')
    await waitFor(() => cdp.eval(`speechError.textContent.includes('測試：請重新選擇錄音')`), 'main 錯誤')
    check('main 結構化錯誤可見，表單可重試', await cdp.eval(`speechError.offsetHeight>0 && !speechGenerate.disabled`))
    if (CACHE) await realModelGate(cdp, inspector)
    await cdp.click('.speech-mode[data-mode="design"]')
    await cdp.eval(`speechError.hidden=true`)
    for (const width of [1440, 1000, 760, 640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false })
      for (const theme of ['dark', 'light']) {
        await cdp.eval(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});
          document.querySelectorAll('#page-speech,.main-content,.content').forEach(el=>el.scrollTop=0); document.documentElement.scrollTop=0; document.body.scrollTop=0;`)
        const geometry = await cdp.eval(`({overflow:document.querySelector('.speech-workbench').scrollWidth>document.querySelector('.speech-workbench').clientWidth+1,columns:getComputedStyle(document.querySelector('.speech-form')).gridTemplateColumns.split(' ').length,color:getComputedStyle(speechText).color,background:getComputedStyle(speechText).backgroundColor})`)
        check(`${width}px ${theme} 欄位無溢出，顏色有值`, !geometry.overflow && geometry.color !== geometry.background && (width > 760 || geometry.columns === 1))
        check(`${width}px ${theme} 標記分組無溢出且按鈕可點`, await cdp.eval(`speechEvents.scrollWidth<=speechEvents.clientWidth+1 && [...speechEvents.querySelectorAll('.speech-event-group,button')].every(el=>el.scrollWidth<=el.clientWidth+1) && [...speechEvents.querySelectorAll('button')].every(el=>el.getBoundingClientRect().height>=43)`))
        check(`${width}px ${theme} 中英文保持成對同列`, await cdp.eval(`[...speechEvents.querySelectorAll('.speech-event-group')].every(el=>Math.abs(el.children[0].getBoundingClientRect().top-el.children[1].getBoundingClientRect().top)<1)`))
        for (const mode of ['design', 'clone', 'direction', 'convert']) {
          await cdp.click(`.speech-mode[data-mode="${mode}"]`)
          await waitFor(() => cdp.eval(`[...document.querySelectorAll('.speech-mode')].every(el=>el.getAnimations().length===0)`), '選單切換完成')
          const menu = await cdp.eval(`(() => {
            const tabs=[...document.querySelectorAll('.speech-mode')], selected=tabs.find(el=>el.getAttribute('aria-selected')==='true');
            const fits=tabs.every(el=>el.scrollWidth<=el.clientWidth+1 && el.offsetHeight>=44 && el.querySelector('.speech-mode-description'));
            const order=${JSON.stringify(mode)}==='direction' ? speechReference.getBoundingClientRect().bottom<=speechInstructionGroup.getBoundingClientRect().top : true;
            return {fits,order,mode:selected.dataset.mode,background:getComputedStyle(selected).backgroundColor,otherBackground:getComputedStyle(tabs.find(el=>el!==selected)).backgroundColor,referenceBottom:speechReference.getBoundingClientRect().bottom,instructionTop:speechInstructionGroup.getBoundingClientRect().top};
          })()`)
          assert(menu.fits && menu.order && menu.mode===mode && menu.background!==menu.otherBackground, JSON.stringify(menu))
          check(`${width}px ${theme} ${mode} 選單與欄位順序清楚`, true)
        }
        await cdp.click('.speech-mode[data-mode="design"]')
        if (SHOTS) {
          await inspector.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).showInactive()`)
          const shot = await cdp.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false })
          fs.writeFileSync(path.join(SHOTS, `speech-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'))
        }
      }
    }
    check('整個流程沒有未處理例外', cdp.exceptions.length === 0)
    console.log(`ALL PASS — ${passed} passed; ${CACHE ? '含真 Q8 design / saved-voice clone。' : 'UI fixture，不代表模型推論。'}${SHOTS ? ` 截圖：${SHOTS}` : ''}`)
  } finally {
    cdp?.close(); inspector?.close()
    if (child.pid) {
      const killer = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      spawnSync(killer, ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' })
      child.kill()
    }
  }
}

main().catch((error) => { console.error(`FAIL ${error.stack}`); process.exitCode = 1 })
