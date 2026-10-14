'use strict'

/**
 * Linux 播放視窗端到端（真的 Electron 視窗＋真的 mpv＋ffmpeg 產生的檔案）。
 * 用法（需要 X／Wayland 顯示）：npx electron --no-sandbox scripts/e2e-media-player-linux.js
 *
 * 只載 media-linux 那幾個模組，不開整個 App（不碰使用者設定、不登入任何東西）。
 * 驗：H.264 mp4／VP9 webm 用內建 <video> 播、SRT＋VTT 字幕、快捷鍵（快轉／音量／下一個）、
 *     HEVC mp4 內建播不動自動改走 mpv、avi／wma 直接走 mpv 並遙控（暫停／跳轉）、播放清單 .m3u8、
 *     換回 HTML5 時收掉 mpv、沒有 mpv 時改提供 ffplay／系統開啟、關視窗收掉 mpv。
 */

const { app, protocol, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const assert = require('node:assert/strict')
const { tempDir } = require('./lib/test-temp')
const { makeSamples } = require('./fixtures/media/make-samples')

if (process.platform !== 'linux') { console.log('SKIP（非 Linux）'); process.exit(0) }

const playerProtocol = require('../src/main/media-linux/protocol')
const { createController } = require('../src/main/media-linux/controller')
protocol.registerSchemesAsPrivileged([playerProtocol.PRIVILEGES])

const SHOT = process.env.MEDIA_E2E_SHOT || ''
const hide = { mpv: false, ffplay: false }
const spawned = []
const systemOpened = []

function exists(f) {
  if (hide.mpv && f.endsWith('/mpv')) return false
  if (hide.ffplay && f.endsWith('/ffplay')) return false
  try { fs.accessSync(f, fs.constants.X_OK); return true } catch { return false }
}

/** ffplay 不真的開（測試機會多一扇停不掉的窗）：記下參數，改跑 /bin/true */
function spawnFn(bin, args, opts) {
  spawned.push({ bin, args })
  if (bin.endsWith('/ffplay')) return spawn('/bin/true', [], opts)
  return spawn(bin, args, opts)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const dir = tempDir('media-e2e-')
  const s = makeSamples(dir, { seconds: 8 })
  if (!s) { console.log('SKIP（沒有 ffmpeg）'); return }
  playerProtocol.register(protocol)
  const ctl = createController({
    openWithSystem: async (f) => { systemOpened.push(f); return '' },
    theme: () => 'dark',
    exists,
    spawnFn,
    mpvArgs: ['--ao=null']
  })

  const js = (code) => ctl.window.webContents.executeJavaScript(code)
  const data = () => js('({ ...document.body.dataset })')
  const until = async (fn, label, ms = 15000) => {
    const start = Date.now()
    let last
    while (Date.now() - start < ms) {
      last = await data().catch(() => ({}))
      if (fn(last)) return last
      await sleep(100)
    }
    throw new Error(`等不到：${label}；最後狀態 ${JSON.stringify(last)}；mpv ${JSON.stringify(ctl.mpv?.props || null)}；事件 ${ctl.recentEvents.join(',')}`)
  }
  const key = (k, extra = '') => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true ${extra} }))`)

  // 1. H.264 mp4：內建播放、字幕、播放清單
  assert.equal(await ctl.open(s.mp4), true)
  await until((d) => d.backend === 'html5' && d.ready === '0' && Number(d.time) > 0.5, 'mp4 用內建播放並開始走')
  const v = await js(`(() => { const v = document.getElementById('mpVideo'); return { w: v.videoWidth, h: v.videoHeight, tracks: [...v.textTracks].map(t => t.label + ':' + t.mode), subs: [...document.getElementById('mpSubs').options].map(o => o.textContent + (o.disabled ? '(停用)' : '')), queue: [...document.querySelectorAll('#mpQueueList li')].map(li => li.textContent), backend: document.getElementById('mpBackend').textContent } })()`)
  assert.equal(v.w, 320)
  assert.equal(v.h, 240)
  assert.deepEqual(v.tracks, ['01 h264.srt:showing', 'zh-TW（vtt）:disabled'])
  assert.deepEqual(v.subs, ['字幕：關', '01 h264.srt', '01 h264.ass（需 mpv）(停用)', 'zh-TW（vtt）'])
  assert.deepEqual(v.queue, ['01 h264.mp4', '02 vp9.webm', '03 hevc.mp4', '10 mpeg4.avimpv'], '同資料夾影片、自然排序、非 HTML5 容器標 mpv')
  const cue = await until(async () => true, 'x').then(() => js(`(() => { const t = document.getElementById('mpVideo').textTracks[0]; return t.activeCues && t.activeCues[0] ? t.activeCues[0].text : '' })()`))
  assert.match(cue, /中文字幕/, 'SRT 轉成 VTT 後真的顯示')
  console.log(`ok H.264 mp4：內建 <video> 播放（${v.w}×${v.h}）、SRT＋VTT 字幕（.ass 標需 mpv）、播放清單 4 首自然排序`)
  if (SHOT) fs.writeFileSync(SHOT.replace(/\.png$/, '-html5.png'), (await ctl.window.capturePage()).toPNG())

  // 快捷鍵：→ 快轉 5 秒、↓ 音量、c 換字幕、PgDn 下一首
  const t0 = Number((await data()).time)
  await key('ArrowRight')
  await until((d) => Number(d.time) >= t0 + 4, '→ 快轉 5 秒')
  await key('ArrowDown')
  assert.equal(await js(`document.getElementById('mpVideo').volume`), 0.95)
  await key('c')
  assert.deepEqual(await js(`[...document.getElementById('mpVideo').textTracks].map(t => t.mode)`), ['disabled', 'showing'])
  await key('PageDown')
  await until((d) => d.index === '1' && d.backend === 'html5' && d.ready === '1' && Number(d.time) > 0.3, 'PgDn → VP9 webm 內建播放')
  assert.equal(await js(`document.getElementById('mpVideo').videoWidth`), 320)
  console.log('ok 快捷鍵：→ 快轉、↓ 音量 95%、C 換到 zh-TW 字幕、PgDn 下一首；VP9／Opus webm 內建播放')

  // 2. HEVC mp4：內建播不動 → 自動改 mpv（Chromium 在沒有硬體解碼的 Linux 不解 HEVC）
  await key('PageDown')
  const hevc = await until((d) => d.index === '2' && (d.backend === 'mpv' || (d.backend === 'html5' && Number(d.time) > 0.3)), 'HEVC 播放或改走 mpv')
  if (hevc.backend === 'mpv') {
    assert.match(hevc.fallback || '', /^2:/)
    await until((d) => d.ready === '2' && Number(d.time) > 0.3, 'mpv 播 HEVC 並回報進度')
    assert.ok(ctl.mpv?.alive, 'mpv 在跑')
    console.log(`ok HEVC mp4：內建 <video> 回報不支援（${hevc.fallback.slice(2)}）→ 自動改由 mpv 播放，進度同步回播放頁`)
  } else {
    console.log('ok HEVC mp4：這台的 Chromium 解得了 HEVC，內建播放')
  }

  // 3. avi：直接 mpv；遙控暫停／跳轉
  await key('PageDown')
  await until((d) => d.index === '3' && d.backend === 'mpv' && d.ready === '3' && Number(d.time) > 0.3, 'avi 由 mpv 播放')
  const pid = ctl.mpv.pid
  await key(' ')
  await until((d) => d.paused === 'true', '空白鍵暫停 mpv')
  assert.equal(ctl.mpv.props.pause, true)
  await js(`(() => { const s = document.getElementById('mpSeek'); s.value = '750'; s.dispatchEvent(new Event('change')) })()`)
  await until((d) => Math.abs(Number(d.time) - 6) < 0.6, '拖進度條到 75%（6 秒）')
  if (SHOT) fs.writeFileSync(SHOT.replace(/\.png$/, '-mpv.png'), (await ctl.window.capturePage()).toPNG())
  console.log(`ok MPEG-4 avi：直接由 mpv 播放（pid ${pid}）、空白鍵暫停、拖進度條跳到 6 秒，都經 JSON IPC`)

  // 4. 點播放清單回第一首（HTML5）→ mpv 收掉
  await js(`document.querySelectorAll('#mpQueueList li')[0].click()`)
  await until((d) => d.index === '0' && d.backend === 'html5' && Number(d.time) > 0.3, '回到 mp4 內建播放')
  await sleep(2000)
  assert.equal(ctl.mpv, null)
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  assert.equal(alive, false, `mpv（pid ${pid}）應該結束`)
  console.log('ok 換回內建播放時 mpv 程序收掉')

  // 5. 播放清單 .m3u8：網址／文字檔／巢狀清單不收；wma → mpv，播完自動下一首 flac → 內建
  assert.equal(await ctl.open(s.m3u), true)
  await until((d) => d.index === '0' && d.backend === 'mpv' && d.ready === '0', 'm3u8 第一首 wma 由 mpv 播')
  assert.deepEqual(await js(`[...document.querySelectorAll('#mpQueueList li')].map(li => li.textContent)`), ['a2.wmampv', 'a1.flac'])
  assert.equal(await js(`document.getElementById('mpAudioArt').hidden`), true)
  await js(`(() => { const s = document.getElementById('mpSeek'); s.value = '950'; s.dispatchEvent(new Event('change')) })()`)
  await until((d) => d.index === '1' && d.backend === 'html5' && Number(d.time) > 0.3, 'wma 播完自動下一首 flac（內建）', 20000)
  assert.equal(await js(`document.getElementById('mpAudioArt').hidden`), false, '音訊顯示封面區')
  console.log('ok .m3u8 播放清單：只收本機媒體（網址、txt、巢狀清單丟掉）；wma 經 mpv 播完自動接 flac 內建播放')

  // 6. 沒有 mpv：avi 交給 ffplay（open 直接回 true）；也沒有 ffplay → 回 false 讓呼叫端走系統開啟
  hide.mpv = true
  spawned.length = 0
  assert.equal(await ctl.open(s.avi), true)
  assert.equal(spawned.at(-1).bin.endsWith('/ffplay'), true)
  assert.deepEqual(spawned.at(-1).args, ['-autoexit', '-window_title', '10 mpeg4.avi', s.avi])
  hide.ffplay = true
  assert.equal(await ctl.open(s.avi), false)
  hide.ffplay = false
  // 播放清單裡碰到 HEVC：內建播不動、沒有 mpv → 顯示 ffplay／系統開啟按鈕
  assert.equal(await ctl.open(s.hevc), true)
  const noMpv = await until((d) => d.index === '2' && (d.backend === 'ffplay' || (d.backend === 'html5' && Number(d.time) > 0.3 && !d.fallback)), 'HEVC 無 mpv')
  if (noMpv.backend === 'ffplay') {
    const buttons = await js(`[...document.querySelectorAll('#mpPanelActions button')].map(b => b.textContent)`)
    assert.deepEqual(buttons, ['用 ffplay 播放', '用系統預設程式開啟'])
    spawned.length = 0
    await js(`document.querySelectorAll('#mpPanelActions button')[0].click()`)
    await sleep(300)
    assert.deepEqual(spawned.at(-1)?.args, ['-autoexit', '-window_title', '03 hevc.mp4', s.hevc])
    await js(`document.querySelectorAll('#mpPanelActions button')[1].click()`)
    await sleep(300)
    assert.equal(systemOpened.at(-1), s.hevc)
    if (SHOT) fs.writeFileSync(SHOT.replace(/\.png$/, '-nompv.png'), (await ctl.window.capturePage()).toPNG())
  }
  hide.mpv = false
  console.log('ok 沒有 mpv：avi 交給 ffplay；連 ffplay 都沒有 → 回 false 讓呼叫端用系統程式開；HEVC 播不動時給 ffplay／系統開啟按鈕')

  // 7. 關視窗收掉 mpv
  assert.equal(await ctl.open(s.avi), true)
  await until((d) => d.backend === 'mpv' && d.ready === '3', 'avi 再開一次')
  const pid2 = ctl.mpv.pid
  ctl.window.close()
  await sleep(2500)
  alive = true
  try { process.kill(pid2, 0) } catch { alive = false }
  assert.equal(alive, false, '關播放視窗 → mpv 結束')
  console.log('ok 關掉播放視窗 → mpv 一起結束')
}

app.whenReady().then(main).then(() => {
  console.log('e2e-media-player-linux: all passed')
  app.exit(0)
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
app.on('window-all-closed', () => { /* 測試自己決定何時結束 */ })
