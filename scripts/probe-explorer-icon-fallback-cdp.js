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
  const types = ['txt', 'js', 'pdf', 'png', 'mp4', 'mp3', 'zip', 'xlsx', 'gguf', 'ttf', 'exe', 'unknown',
    'docx', 'pptx', 'json', 'wav', 'flac', 'stl', '3mf']
  for (const ext of types) fs.writeFileSync(path.join(files, `sample.${ext}`), 'x')
  fs.writeFileSync(path.join(files, 'photo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
  const folders = path.join(dir, 'folders')
  for (const name of ['Music', 'Photos', 'Empty']) fs.mkdirSync(path.join(folders, name), { recursive: true })
  fs.copyFileSync(path.join(files, 'sample.wav'), path.join(folders, 'Music', 'sample.wav'))
  for (const name of ['second.wav', 'third.wav']) fs.copyFileSync(path.join(files, 'sample.wav'), path.join(folders, 'Music', name))
  fs.copyFileSync(path.join(files, 'photo.png'), path.join(folders, 'Photos', 'photo.png'))
  fs.writeFileSync(path.join(folders, 'Music', 'desktop.ini'), 'hidden')
  spawnSync('attrib', ['+H', '+S', path.join(folders, 'Music', 'desktop.ini')])
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false, closeToTray: false }))
  fs.writeFileSync(path.join(dir, 'explorer.json'), JSON.stringify({ lastPath: files, view: 'list', uffsAuto: false }))
  const exe = process.env.VOICEINK_EXE || path.join(__dirname, '../dist/win-unpacked/VoiceInk.exe')
  let child, renderer, mainCdp
  try {
    child = spawn(exe, ['--hidden', '--disable-gpu', `--user-data-dir=${dir}`, '--remote-debugging-port=9284', '--inspect=127.0.0.1:9285'],
      { stdio: 'ignore', windowsHide: true })
    const target = (port, predicate) => waitFor(async () => {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => [])
      return pages.find(predicate)
    }, `CDP ${port}`)
    mainCdp = await connect((await target(9285, () => true)).webSocketDebuggerUrl, false)
    renderer = await connect((await target(9284, p => p.type === 'page' && /index\.html/.test(p.url))).webSocketDebuggerUrl)
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

    const music = await icon(path.join(folders, 'Music'), { thumb: true, size: 128 })
    assert.equal(music.ok, true)
    assert.equal(music.data.previews?.length, 2, '資料夾最多兩張內容圖，各自過濾，不能回含 logo 的合成圖')
    assert.ok(music.data.previews.every(p => p.name.endsWith('.wav')), '預覽不包含 hidden／system 檔案')
    assert.ok(music.data.previews.every(p => p.fallback), '音樂資料夾裡面的 WAV 改用音訊預設圖')
    const photos = await icon(path.join(folders, 'Photos'), { thumb: true, size: 128 })
    assert.equal(photos.data.previews.length, 1)
    assert.match(photos.data.previews[0].url, /^data:image\/png;base64,/)
    assert.equal(photos.data.previews[0].fallback, undefined, '資料夾裡的照片真縮圖要保留')
    assert.deepEqual((await icon(path.join(folders, 'Empty'), { thumb: true })).data.previews, [])
    if (process.env.VOICEINK_FOLDER_TARGET) {
      const actual = await icon(process.env.VOICEINK_FOLDER_TARGET, { thumb: true, size: 128 })
      assert.equal(actual.ok, true)
      assert.ok(actual.data.previews.length > 0, '使用者目前資料夾保留內容預覽')
      assert.ok(actual.data.previews.every(p => p.fallback), '使用者音樂資料夾內的 logo 全改音訊預設圖')
    }
    console.log('PASS 真資料夾：音樂內容排除 logo、照片真縮圖、隱藏檔與空資料夾')

    await renderer.eval('document.querySelector(\'[data-page="explorer"]\').click()')
    await waitFor(() => renderer.eval('document.querySelectorAll("#exList .ex-row").length === 20'), '檔案頁初始化')
    const go = async folder => {
      await renderer.eval(`(() => {
        const input = document.getElementById('exPathInput'); input.value = ${JSON.stringify(folder)};
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`)
      await waitFor(() => renderer.eval(`(() => {
        const rows = Array.from(document.querySelectorAll('#exList .ex-row'));
        return rows.length > 0 && rows.every(row => row.dataset.path.startsWith(${JSON.stringify(folder + path.sep)}));
      })()`), '切資料夾')
    }
    await go(folders)
    await waitFor(() => renderer.eval(`(() => {
      document.getElementById('exViewGridBtn').click();
      return document.getElementById('exList').classList.contains('is-grid');
    })()`), '資料夾方格')
    const verifyFolders = async selector => {
      const values = await waitFor(async () => {
        const result = await renderer.eval(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(row => ({
          name: row.dataset.name, loaded: !!row.querySelector('.ex-row-icon > img')?.naturalWidth,
          cards: Array.from(row.querySelectorAll('.ex-folder-preview')).map(card => ({
            type: card.dataset.iconType, src: card.querySelector('img')?.src,
            loaded: !!card.querySelector('img')?.naturalWidth
          }))
        }))`)
        return result.length === 3 && result.every(row => row.loaded)
          && result.find(row => row.name === 'Music')?.cards[0]?.loaded
          && result.find(row => row.name === 'Photos')?.cards[0]?.loaded ? result : null
      }, '資料夾內容預覽')
      const audio = values.find(row => row.name === 'Music').cards[0]
      assert.equal(values.find(row => row.name === 'Music').cards.length, 2, '兩張內容圖都顯示')
      assert.equal(audio.type, 'audio'); assert.match(audio.src, /^data:image\/svg\+xml,/)
      assert.match(values.find(row => row.name === 'Photos').cards[0].src, /^data:image\/png;base64,/)
      assert.deepEqual(values.find(row => row.name === 'Empty').cards, [])
    }
    await verifyFolders('#exList .ex-row')
    await renderer.eval('document.getElementById("exDualBtn").click()')
    await renderer.eval(`(() => {
      const input = document.getElementById('exSecondPathInput'); input.value = ${JSON.stringify(folders)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
    await waitFor(() => renderer.eval('document.querySelectorAll("#exSecondList .ex-row").length === 3'), '右欄資料夾')
    await renderer.eval('document.getElementById("exSecondViewGridBtn").click()')
    await verifyFolders('#exSecondList .ex-row')
    for (const theme of ['dark', 'light']) {
      await renderer.eval(`document.documentElement.dataset.theme = '${theme}'`)
      await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: theme === 'dark' ? 900 : 901, deviceScaleFactor: 1, mobile: false })
      await sleep(500)
      const shot = await renderer.send('Page.captureScreenshot', { format: 'png' })
      const output = path.join(__dirname, `../dist/qa/explorer-folder-preview-${theme}.png`)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, Buffer.from(shot.data, 'base64'))
    }
    await renderer.eval('document.getElementById("exDualBtn").click()')
    await go(files)
    await renderer.eval('document.getElementById("exViewListBtn").click()')
    console.log('PASS 資料夾方格／雙欄／深淺色：音訊預設圖、真照片與空資料夾')

    for (const ext of types.filter(ext => ext !== 'exe')) {
      const result = await icon(path.join(files, `sample.${ext}`))
      assert.equal(result.ok, true, `${ext} 圖示 IPC`)
      assert.ok(result.data.fallback || result.data.url, `${ext} 有可顯示的圖示`)
    }
    assert.equal((await icon(path.join(files, 'sample.wav'))).data.fallback, true,
      '真 Windows WAV 圖示跟 App logo 有色差時仍要排除')
    for (const size of [16, 32, 64, 96, 128, 160, 192, 256]) {
      assert.equal((await icon(path.join(files, 'sample.wav'), { thumb: true, size })).data.fallback, true,
        `${size}px 真 Windows WAV 圖示仍要排除 App logo`)
    }
    if (process.env.VOICEINK_ICON_TARGET) {
      const actual = await icon(process.env.VOICEINK_ICON_TARGET, { thumb: true, size: 128 })
      assert.equal(actual.ok, true)
      assert.equal(actual.data.fallback, true, '使用者實際發生問題的 WAV 檔')
    }
    console.log('PASS 真 Windows：19 種副檔名、WAV 色差、8 種縮圖尺寸與真實檔案')

    // 用真的打包版 logo 模擬殼層誤回圖；仍經過真 IPC 與 renderer，沒有改使用者的檔案關聯。
    await mainCdp.eval(`(() => {
      globalThis.__iconRequire = process.mainModule.require('node:module').createRequire(process.mainModule.require('electron').app.getAppPath() + '/src/main/main.js');
      const shell = __iconRequire('./explorer/shell');
      void shell.iconOf(process.execPath).then(logo => {
        const { nativeImage } = __iconRequire('electron');
        const image = nativeImage.createFromDataURL(logo), pixels = image.toBitmap();
        const index = pixels.findIndex((value, i) => i % 4 === 0 && pixels[i + 3] === 255 && value < 250);
        pixels[index] += 1;
        const variant = nativeImage.createFromBitmap(pixels, image.getSize()).toDataURL();
        globalThis.__iconVariant = variant;
        globalThis.__iconLogo = logo;
        shell.iconOf = async target => target === process.execPath ? logo : variant;
        shell.iconInfoOf = async () => ({ url: variant, baseUrl: variant });
        shell.thumbOf = async () => ({ url: variant, pending: true });
        globalThis.__iconReady = true;
      });
    })()`)
    await waitFor(() => mainCdp.eval('globalThis.__iconReady'), '讀取打包版 logo')
    assert.equal(await mainCdp.eval('__iconVariant !== __iconLogo'), true, '測試圖確實與 logo 的 PNG 字串不同')
    assert.equal((await icon(path.join(files, 'sample.js'))).data.fallback, true)
    const pending = await icon(path.join(files, 'sample.pdf'), { thumb: true, size: 256 })
    assert.equal(pending.data.fallback, true); assert.equal(pending.data.pending, true)
    console.log('PASS 真 IPC：一般檔與 pending 縮圖排除 App logo')

    // 有同步標記時也只比對底圖，替換成類型圖示後仍要保留標記。
    await mainCdp.eval(`(() => {
      const shell = __iconRequire('./explorer/shell');
      shell.iconInfoOf = async () => ({ url: __iconVariant, baseUrl: __iconVariant, overlay: __iconLogo });
      shell.thumbOf = async () => ({ url: __iconVariant, pending: true, overlay: __iconLogo });
    })()`)
    const badged = await icon(path.join(files, 'sample.wav'))
    assert.equal(badged.data.fallback, true)
    assert.match(badged.data.overlay, /^data:image\/png;base64,/)
    console.log('PASS 真 IPC：logo 加上同步標記仍被排除，替換後保留標記')
    await mainCdp.eval(`(() => {
      const shell = __iconRequire('./explorer/shell');
      shell.iconInfoOf = async () => ({ url: __iconVariant, baseUrl: __iconVariant });
      shell.thumbOf = async () => ({ url: __iconVariant, pending: true });
    })()`)

    // 真圖示已進 renderer 快取；模擬誤回 logo 的驗證用新路徑，避免誤讀先前的真圖示。
    const mockedFiles = path.join(dir, 'mocked-files')
    fs.mkdirSync(mockedFiles)
    for (const name of fs.readdirSync(files)) fs.copyFileSync(path.join(files, name), path.join(mockedFiles, name))
    await go(mockedFiles)
    await renderer.eval('document.getElementById("exViewListBtn").click()')
    const rows = selector => renderer.eval(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(row => ({
      name: row.dataset.name, type: row.querySelector('.ex-row-icon').dataset.iconType,
      src: row.querySelector('.ex-row-icon img')?.src,
      loaded: !!row.querySelector('.ex-row-icon img')?.naturalWidth
    }))`)
    const verify = async (selector, label) => {
      const result = await waitFor(async () => {
        const values = await rows(selector)
        const exeLoaded = values.find(row => row.name === 'sample.exe')?.src?.startsWith('data:image/png;base64,')
        return values.length === types.length + 1 && values.every(row => row.loaded) && exeLoaded ? values : null
      }, label)
      for (const row of result) {
        if (row.name !== 'sample.exe') assert.match(row.src, /^data:image\/svg\+xml,/)
      }
      assert.equal(new Set(result.filter(row => row.name !== 'sample.exe').map(row => row.type)).size, 14)
      console.log(`PASS ${label}：全部 15 種類型圖示載入成功，執行檔保留 Windows 圖示`)
    }
    await verify('#exList .ex-row', '清單')
    await renderer.eval('document.getElementById("exViewGridBtn").click()')
    await verify('#exList .ex-row', '方格')
    await renderer.eval('document.getElementById("exDualBtn").click()')
    await renderer.eval(`(() => {
      const input = document.getElementById('exSecondPathInput'); input.value = ${JSON.stringify(mockedFiles)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
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
