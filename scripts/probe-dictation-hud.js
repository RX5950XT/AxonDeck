'use strict'

/**
 * 語音輸入指示器的外觀檢查：`node_modules/electron/dist/electron.exe scripts/probe-dictation-hud.js`
 *
 * 真的開那扇視窗、餵幾種狀態，然後 `capturePage()` 存成 PNG 給人看。
 * 不搶焦點、不動滑鼠——指示器本來就是 `focusable: false` ＋ `showInactive()`。
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const assert = require('assert/strict')
const { tempDir } = require('./lib/test-temp')

app.setPath('userData', tempDir('hud-user-'))

const OUT = path.join(__dirname, '..', 'dist', 'qa', 'dictation-hud')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  fs.mkdirSync(OUT, { recursive: true })

  const root = process.env.VOICEINK_EXE
    ? path.join(path.dirname(path.resolve(process.env.VOICEINK_EXE)), 'resources', 'app.asar')
    : path.join(__dirname, '..')
  const hud = require(path.join(root, 'src', 'main', 'dictation', 'hud.js'))
  hud.configure({ isDev: false, preload: path.join(root, 'src', 'preload', 'preload.js') })

  /** @param {string} name */
  async function shoot(name) {
    await sleep(450)
    const img = await hud._window().capturePage()
    const file = path.join(OUT, `${name}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log('wrote', file, `${img.getSize().width}x${img.getSize().height}`)
  }

  // 錄音中：波形要有高低起伏，不是一排等高
  hud.update({ state: 'recording', level: 0.05 })
  await sleep(600)
  const win = hud._window()
  const shown = () => win.webContents.executeJavaScript(
    "document.getElementById('pill').classList.contains('is-shown') && getComputedStyle(document.getElementById('pill')).opacity === '1'"
  )
  assert.equal(await shown(), true, '第一次錄音就要看得到膠囊')
  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  win.webContents.reload()
  await loaded
  await sleep(250)
  assert.equal(await shown(), true, '重新載入後仍要看得到錄音膠囊')
  assert.equal(win.isFocusable(), false)
  assert.equal(win.isFocused(), false)
  console.log('PASS: 冷啟動與重新載入後膠囊可見，未搶焦點（在 capturePage 前驗證）')
  for (const lv of [0.2, 0.55, 0.8, 0.35, 0.9, 0.15, 0.6, 0.75, 0.3, 0.85, 0.25, 0.7, 0.4, 0.95, 0.5, 0.65, 0.45]) {
    hud.update({ state: 'recording', level: lv })
    await sleep(60)
  }
  await shoot('recording')

  hud.update({ state: 'processing' })
  await shoot('processing')

  hud.update({
    state: 'error',
    message: '雲端語音辨識模型「x-ai/grok-stt-1.0」無法使用（HTTP 403）。金鑰本身沒問題，請換一個轉錄模型'
  })
  await shoot('error')

  // 波形真的有動嗎：量一次 DOM
  const heights = await hud._window().webContents.executeJavaScript(
    "(() => { window.__hudRender({state:'recording', level:0.8});"
    + " return [...document.querySelectorAll('#hudWave span')].map(s => s.style.height) })()"
  )
  console.log('bar heights:', heights.join(' '))

  hud.close()
  app.exit(0)
}

main().catch((e) => { console.error(e); app.exit(1) })
