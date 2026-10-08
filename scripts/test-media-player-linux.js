'use strict'

/**
 * Linux App 內播放器（src/main/media-linux/）：
 *   - plan：HTML5 判斷、同資料夾播放清單（自然排序、同種類）、.m3u8／.pls 解析、同名字幕、SRT→VTT、後端順序、工具只找絕對路徑
 *   - protocol：只送播放清單裡的檔案、Range、換清單後舊網址作廢
 *   - mpv JSON IPC：用 ffmpeg 產生的真檔案跑真的 mpv（沒有 mpv 就跳過這段）
 *   - controller：mpv 還在啟動（IPC 還沒連上）就關掉播放視窗，mpv 也要跟著結束，不留孤兒
 * 用法：node scripts/test-media-player-linux.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const { makeSamples } = require('./fixtures/media/make-samples')
const plan = require('../src/main/media-linux/plan')
const proto = require('../src/main/media-linux/protocol')
const { createMpvSession } = require('../src/main/media-linux/mpv-ipc')
const { EventEmitter } = require('events')
const { spawn } = require('child_process')

function testPlan() {
  assert.equal(plan.planItem('/m/a.mp4').html5, true)
  assert.equal(plan.planItem('/m/a.MKV').html5, true)
  assert.equal(plan.planItem('/m/a.avi').html5, false)
  assert.equal(plan.planItem('/m/a.wma').kind, 'audio')
  assert.equal(plan.planItem('/m/a.wma').html5, false)
  assert.equal(plan.planItem('/m/a.opus').mime, 'audio/ogg')

  const names = ['ep10.mkv', 'ep2.mkv', 'ep1.mp4', 'song.mp3', 'cover.jpg', 'ep3.avi', 'sub/x', 'list.m3u']
  assert.deepEqual(plan.siblings('/m/ep2.mkv', names), ['/m/ep1.mp4', '/m/ep2.mkv', '/m/ep3.avi', '/m/ep10.mkv'], '影片只跟影片排、自然排序')
  assert.deepEqual(plan.siblings('/m/song.mp3', names), ['/m/song.mp3'])

  const m3u = '\ufeff#EXTM3U\n#EXTINF:1,x\nb.flac\nhttps://e.com/x.mp3\nfile:///etc/x.mp3\nnotes.txt\nnested.m3u8\n"c d.mp3"\n/abs/e.wav\n\n'
  assert.deepEqual(plan.parsePlaylist('/m/list.m3u8', m3u), ['/m/b.flac', '/m/c d.mp3', '/abs/e.wav'])
  assert.deepEqual(plan.parsePlaylist('/m/x.pls', '[playlist]\nFile1=a.mp3\nTitle1=t\nFile2=../up.ogg\nFile3=/etc/passwd\n'), ['/m/a.mp3', '/up.ogg'])
  assert.deepEqual(plan.parsePlaylist('/m/x.cue', 'REM x\nFILE "album.flac" WAVE\n  TRACK 01 AUDIO\n'), ['/m/album.flac'])

  const subs = plan.findSubtitles('/m/movie.mkv', ['movie.srt', 'movie.zh-TW.srt', 'movie.en.vtt', 'movie.ass', 'movie2.srt', 'movie.final.cut.srt', 'other.srt'])
  assert.deepEqual(subs.map((s) => s.path), ['/m/movie.srt', '/m/movie.ass', '/m/movie.en.vtt', '/m/movie.zh-TW.srt'])
  assert.equal(subs.find((s) => s.lang === 'zh-TW').label, 'zh-TW（srt）')

  const vtt = plan.srtToVtt('\ufeff1\r\n00:00:01,500 --> 00:00:02,000\r\n{\\an8}<i>hi</i>\r\n')
  assert.equal(vtt, 'WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.000\n<i>hi</i>\n')

  const T = { mpv: '/usr/bin/mpv', ffplay: '/usr/bin/ffplay' }
  assert.equal(plan.chooseBackend({ html5: true }, T), 'html5')
  assert.equal(plan.chooseBackend({ html5: true }, T, { html5Failed: true }), 'mpv')
  assert.equal(plan.chooseBackend({ html5: false }, { mpv: '', ffplay: T.ffplay }), 'ffplay')
  assert.equal(plan.chooseBackend({ html5: false }, { mpv: '', ffplay: '' }), 'system')
  assert.equal(plan.findTool('mpv', (f) => f === '/usr/local/bin/mpv'), '/usr/local/bin/mpv')
  assert.equal(plan.findTool('mpv', () => false), '')
  console.log('ok plan：HTML5 判斷、同種類自然排序、m3u8／pls／cue 只收本機媒體、同名字幕、SRT→VTT、後端順序 HTML5→mpv→ffplay→系統')
}

async function testProtocol(samples) {
  const [url, none] = proto.publish([{ path: samples.mp4, mime: 'video/mp4' }, { path: samples.avi, mime: '' }])
  assert.match(url, new RegExp(`^axd-player://${proto.TOKEN}/[0-9a-f]{18}$`))
  assert.equal(none, '', '不是 HTML5 的不發網址')
  const size = fs.statSync(samples.mp4).size
  const req = (range) => ({ method: 'GET', headers: { get: (n) => (n.toLowerCase() === 'range' ? range : null) } })
  let res = await proto.respond(url, req(null))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(Number(res.headers.get('content-length')), size)
  res = await proto.respond(url, req('bytes=100-199'))
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${size}`)
  assert.equal((await res.arrayBuffer()).byteLength, 100)
  assert.equal((await proto.respond(url, req(`bytes=${size + 10}-`))).status, 416)
  assert.equal((await proto.respond(url.replace(proto.TOKEN, 'f'.repeat(32)), req(null))).status, 404, '別的 token')
  assert.equal((await proto.respond(`axd-player://${proto.TOKEN}/etc/passwd`, req(null))).status, 404, '不能拿路徑當 id')
  proto.publish([{ path: samples.webm, mime: 'video/webm' }])
  assert.equal((await proto.respond(url, req(null))).status, 404, '換清單後舊網址作廢')
  console.log('ok protocol：只送清單裡的檔案（隨機 id）、Range 206／416、換清單舊網址 404')
}

function waitFor(fn, ms = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      let v
      try { v = fn() } catch { v = false }
      if (v) return resolve(v)
      if (Date.now() - start > ms) return reject(new Error('timeout'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function testMpv(samples) {
  const mpvPath = plan.findTool('mpv', (f) => fs.existsSync(f))
  if (!mpvPath) { console.log('SKIP mpv IPC（沒有安裝 mpv）'); return }
  const root = tempDir('mpv-sock-')
  const s = createMpvSession({ mpvPath, tmpRoot: root, extraArgs: ['--vo=null', '--ao=null', '--force-window=no'] })
  const events = []
  s.on('event', (e) => events.push(e.event + (e.reason ? `:${e.reason}` : '')))
  await s.start()
  const dir = path.dirname(s.socketPath)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'socket 資料夾只有自己進得去')
  await s.command(['loadfile', samples.avi, 'replace'])
  await waitFor(() => events.includes('file-loaded'))
  await waitFor(() => s.props.duration > 5)
  const aviDuration = s.props.duration
  assert.ok(Math.abs(aviDuration - 6) < 0.5, `avi 長度 ${aviDuration}`)
  await waitFor(() => s.props['time-pos'] > 0.3)
  await s.command(['set_property', 'pause', true])
  await waitFor(() => s.props.pause === true)
  await s.command(['seek', 4, 'absolute'])
  await waitFor(() => Math.abs(s.props['time-pos'] - 4) < 0.3)
  await s.command(['set_property', 'volume', 55])
  await waitFor(() => s.props.volume === 55)
  await assert.rejects(s.command(['no_such_command']), { code: 'MPV_COMMAND' })
  await s.command(['set_property', 'pause', false])
  await waitFor(() => events.includes('end-file:eof'), 8000)
  await s.command(['loadfile', samples.wma, 'replace'])
  await waitFor(() => events.filter((e) => e === 'file-loaded').length === 2)
  await waitFor(() => s.props['track-list']?.some((t) => t.type === 'audio' && t.codec === 'wmav2'))
  const exited = new Promise((r) => s.on('exit', r))
  s.quit()
  await exited
  assert.equal(fs.existsSync(dir), false, '結束後 socket 與資料夾都收掉')
  console.log(`ok mpv JSON IPC（${mpvPath}）：avi 載入、長度 ${aviDuration.toFixed(1)} 秒、暫停／跳到 4 秒／音量 55、播完 end-file:eof、換 wma（wmav2）、結束清掉 socket`)
}

/** 最小的假 Electron：只夠 controller 開播放視窗、收 IPC */
function fakeElectron() {
  const handlers = new Map()
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor() {
      super()
      this.destroyed = false
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, isLoading: () => true, send() {}, isDestroyed: () => this.destroyed })
      windows.push(this)
    }
    setMenu() {}
    loadFile() { return Promise.resolve() }
    isDestroyed() { return this.destroyed }
    isVisible() { return false }
    close() { this.destroyed = true; this.emit('closed') }
  }
  return { electron: { BrowserWindow, Menu: {}, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } }, windows }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function testCloseDuringStart(samples) {
  const mpvPath = plan.findTool('mpv', (f) => fs.existsSync(f))
  if (!mpvPath) { console.log('SKIP controller 關窗收 mpv（沒有安裝 mpv）'); return }
  const { createController } = require('../src/main/media-linux/controller')
  const { electron, windows } = fakeElectron()
  const children = []
  const ctl = createController({
    electron,
    openWithSystem: async () => '',
    exists: (f) => f === mpvPath,
    mpvArgs: ['--vo=null', '--ao=null', '--force-window=no'],
    mpvTmpRoot: tempDir('mpv-ctl-'),
    spawnFn: (...a) => { const c = spawn(...a); children.push(c); return c }
  })
  assert.equal(await ctl.open(samples.avi), true)
  // 播放視窗一要求 load，mpv 程序就起來了，但 IPC 還沒連上（controller.mpv 還是 null）
  const loading = ctl.mpvAction({ action: 'load', index: 0 })
  await waitFor(() => children[0]?.pid)
  const pid = children[0].pid
  assert.equal(ctl.mpv, null, '還在啟動中')
  windows[0].close()
  await assert.rejects(loading, { code: 'MEDIA_MPV_CANCELLED' })
  await waitFor(() => !alive(pid) || children[0].exitCode !== null || children[0].signalCode !== null, 5000)
  assert.equal(ctl.mpv, null, '關窗後不能再接上舊的 mpv')

  // 對照：正常啟動完成後關窗也會收掉
  assert.equal(await ctl.open(samples.avi), true)
  await ctl.mpvAction({ action: 'load', index: 0 })
  const pid2 = ctl.mpv.pid
  windows[1].close()
  await waitFor(() => children[1].exitCode !== null || children[1].signalCode !== null, 5000)
  assert.equal(ctl.mpv, null)

  // App 結束時，還在啟動中的那一個也要同步收掉
  assert.equal(await ctl.open(samples.avi), true)
  const loading3 = ctl.mpvAction({ action: 'load', index: 0 }).catch((e) => e)
  await waitFor(() => children[2]?.pid)
  ctl.shutdown()
  await waitFor(() => children[2].exitCode !== null || children[2].signalCode !== null, 5000)
  await loading3
  console.log(`ok controller：mpv 啟動途中關播放視窗（pid ${pid}）會收掉、啟動完再關（pid ${pid2}）也會收掉、App 結束時收掉啟動中的 mpv`)
}

;(async () => {
  testPlan()
  const dir = tempDir('media-linux-')
  const samples = makeSamples(dir)
  if (!samples) { console.log('SKIP 真檔案（沒有 ffmpeg）'); return }
  await testProtocol(samples)
  await testMpv(samples)
  await testCloseDuringStart(samples)
  console.log('test-media-player-linux: all passed')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
