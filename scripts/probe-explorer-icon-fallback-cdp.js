/** 隔離打包版：真 Windows 圖示、誤回 App logo、類型 SVG、清單／方格／雙欄。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { tempDir, removeTree } = require('./lib/test-temp')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, label) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(150)
  }
  throw new Error(`等待逾時：${label}`)
}

async function connect(url, awaitPromise = true) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  const errors = []
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text)
    const call = pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id); clearTimeout(call.timer)
    if (msg.error || msg.result.exceptionDetails) call.reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)))
    else call.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP 逾時：${method}`)) }, 25000)
    pending.set(requestId, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
  await send('Runtime.enable')
  return { ws, errors, send, eval: async expression =>
    (await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })).result?.value }
}

async function main() {
  const dir = tempDir('explorer-icon-cdp-')
  const files = path.join(dir, 'files')
  fs.mkdirSync(files)
  const types = ['txt', 'js', 'pdf', 'png', 'mp4', 'mp3', 'zip', 'xlsx', 'gguf', 'ttf', 'exe', 'unknown']
  for (const ext of types) fs.writeFileSync(path.join(files, `sample.${ext}`), 'x')
  fs.writeFileSync(path.join(files, 'photo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false, closeToTray: false }))
  fs.writeFileSync(path.join(dir, 'explorer.json'), JSON.stringify({ lastPath: files, view: 'list', uffsAuto: false }))
  const exe = process.env.VOICEINK_EXE || path.join(__dirname, '../dist/win-unpacked/VoiceInk.exe')
  let child, renderer, mainCdp
  try {
    child = spawn(exe, ['--hidden', '--disable-gpu', `--user-data-dir=${dir}`, '--remote-debugging-port=9274', '--inspect=127.0.0.1:9275'],
      { stdio: 'ignore', windowsHide: true })
    const target = (port, predicate) => waitFor(async () => {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => [])
      return pages.find(predicate)
    }, `CDP ${port}`)
    mainCdp = await connect((await target(9275, () => true)).webSocketDebuggerUrl, false)
    renderer = await connect((await target(9274, p => p.type === 'page' && /index\.html/.test(p.url))).webSocketDebuggerUrl)
    await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await waitFor(() => renderer.eval('document.readyState === "complete" && !!window.electronAPI'), 'preload')
    const icon = (file, opts = {}) => renderer.eval(`window.electronAPI.explorer.fileIcon(${JSON.stringify(file)}, ${JSON.stringify(opts)})`)
    const generic = await icon(path.join(files, 'sample.gguf'))
    assert.equal(generic.ok, true); assert.equal(generic.data.fallback, true)
    const text = await icon(path.join(files, 'sample.txt'))
    assert.equal(text.ok, true); assert.match(text.data.url, /^data:image\/png;base64,/)
    const photo = await icon(path.join(files, 'photo.png'), { thumb: true, size: 96 })
    assert.equal(photo.ok, true); assert.equal(photo.data.pending, undefined)
    assert.notEqual(photo.data.url, text.data.url, '真縮圖不能變成類型圖示')
    const appIcon = await icon(exe)
    assert.match(appIcon.data.url, /^data:image\/png;base64,/)
    console.log('PASS 真殼層：通用圖改預設圖、正常文字圖示、照片真縮圖、App 執行檔保留 logo')

    // 用真的打包版 logo 模擬殼層誤回圖；仍經過真 IPC 與 renderer，沒有改使用者的檔案關聯。
    await mainCdp.eval(`(() => {
      globalThis.__iconRequire = process.mainModule.require('node:module').createRequire(process.mainModule.require('electron').app.getAppPath() + '/src/main/main.js');
      const shell = __iconRequire('./explorer/shell');
      void shell.iconOf(process.execPath).then(logo => {
        shell.iconOf = async () => logo;
        shell.thumbOf = async () => ({ url: logo, pending: true });
        globalThis.__iconReady = true;
      });
    })()`)
    await waitFor(() => mainCdp.eval('globalThis.__iconReady'), '讀取打包版 logo')
    assert.equal((await icon(path.join(files, 'sample.js'))).data.fallback, true)
    const pending = await icon(path.join(files, 'sample.pdf'), { thumb: true, size: 256 })
    assert.equal(pending.data.fallback, true); assert.equal(pending.data.pending, true)
    console.log('PASS 真 IPC：一般檔與 pending 縮圖排除 App logo')

    await renderer.eval('document.querySelector(\'[data-page="explorer"]\').click()')
    const rows = selector => renderer.eval(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(row => ({
      name: row.dataset.name, type: row.querySelector('.ex-row-icon').dataset.iconType,
      src: row.querySelector('.ex-row-icon img')?.src,
      loaded: !!row.querySelector('.ex-row-icon img')?.naturalWidth
    }))`)
    const verify = async (selector, label) => {
      const result = await waitFor(async () => {
        const values = await rows(selector)
        const exeLoaded = values.find(row => row.name === 'sample.exe')?.src?.startsWith('data:image/png;base64,')
        return values.length === 13 && values.every(row => row.loaded) && exeLoaded ? values : null
      }, label)
      for (const row of result) {
        if (row.name !== 'sample.exe') assert.match(row.src, /^data:image\/svg\+xml,/)
      }
      assert.equal(new Set(result.filter(row => row.name !== 'sample.exe').map(row => row.type)).size, 11)
      console.log(`PASS ${label}：12 種類型圖示載入成功，執行檔保留 Windows 圖示`)
    }
    await verify('#exList .ex-row', '清單')
    await renderer.eval('document.getElementById("exViewGridBtn").click()')
    await verify('#exList .ex-row', '方格')
    await renderer.eval('document.getElementById("exDualBtn").click()')
    await verify('#exSecondList .ex-row', '右欄')
    for (const theme of ['dark', 'light']) {
      await renderer.eval(`document.documentElement.dataset.theme = '${theme}'`)
      // 隱藏視窗沒有持續畫面更新；改視埠讓 CDP 取到完整新畫面，不開實體視窗。
      await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: theme === 'dark' ? 900 : 901, deviceScaleFactor: 1, mobile: false })
      await sleep(700)
      const shot = await renderer.send('Page.captureScreenshot', { format: 'png' })
      const output = path.join(__dirname, `../dist/qa/explorer-icon-fallback-${theme}.png`)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, Buffer.from(shot.data, 'base64'))
    }
    assert.equal(await mainCdp.eval('__iconRequire("electron").BrowserWindow.getAllWindows().every(w => !w.isVisible())'), true)
    assert.deepEqual(renderer.errors, [])
    console.log('PASS 深／淺色截圖、無 renderer 例外、全程隱藏視窗')
  } finally {
    renderer?.ws.close(); mainCdp?.ws.close()
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(800)
    removeTree(dir)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
