'use strict'

/**
 * Linux 的 App 內媒體播放器（對應 Windows 的 axondeck-media.exe 原生播放器）。
 *
 * 每一首自己選後端，順序固定：
 *   1. HTML5（Chromium 能播的容器，見 plan.js 的 HTML5_MIME）：在 AxonDeck 的播放視窗裡播
 *   2. mpv（有裝才用，JSON IPC 遙控）：畫面在 mpv 視窗，AxonDeck 播放視窗同步進度、可遙控、管播放清單
 *   3. ffplay（有裝才用）：交出去播，沒有遙控
 *   4. 系統預設程式（xdg-open）
 * HTML5 播到一半發現編碼不支援（例如 HEVC 的 mp4）→ 播放頁回報，那一首改走 2～4。
 *
 * 圖片不在這裡：Linux 維持原本的行為（App 內圖片檢視／系統開啟）。
 */

const path = require('path')
const fs = require('fs')
const rawFs = require('../raw-fs')
const { spawn } = require('child_process')
const plan = require('./plan')
const playerProtocol = require('./protocol')
const { createMpvSession } = require('./mpv-ipc')

const PAGE = path.join(__dirname, '../../renderer/pages/media-player.html')
const PRELOAD = path.join(__dirname, '../../preload/media-player-preload.js')
const ICON = path.join(__dirname, '../../../assets/icon.png')
const MAX_SUB_BYTES = 5 * 1024 * 1024

/**
 * @param {{
 *   electron?: any,
 *   openWithSystem: (file: string) => Promise<string>,
 *   theme?: () => string,
 *   exists?: (file: string) => boolean,
 *   spawnFn?: typeof spawn,
 *   mpvArgs?: string[],
 *   mpvTmpRoot?: string,
 *   windowOptions?: object
 * }} deps
 */
function createController(deps) {
  const exists = deps.exists || ((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true } catch { return false } })
  const spawnFn = deps.spawnFn || spawn
  const theme = deps.theme || (() => 'dark')
  let electron = deps.electron || null
  let win = null
  let ipcReady = false
  /** @type {{ items: ReturnType<typeof plan.planItem>[], urls: string[], index: number, seq: number }} */
  const state = { items: [], urls: [], index: 0, seq: 0 }
  let mpv = null
  let mpvStarting = null
  /** 還在 start()（連 IPC socket）的那一個；這段期間 mpv 程序已經在跑但 mpv 還是 null */
  let startingSession = null
  /** stopMpv／shutdown 每次 +1：啟動途中被叫停的 session 連上後要自己收掉，不能留成孤兒 */
  let mpvGen = 0
  let lastPush = 0
  /** 最近的 mpv 事件（除錯用，不含路徑） */
  const recent = []
  let pendingTime = 0
  let timeTimer = null

  function el() {
    if (!electron) electron = require('electron')
    return electron
  }

  function tools() {
    return { mpv: plan.findTool('mpv', exists), ffplay: plan.findTool('ffplay', exists) }
  }

  async function listDir(dir) {
    try {
      const entries = await rawFs.promises.readdir(dir, { withFileTypes: true })
      return entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name)
    } catch { return [] }
  }

  /** @returns {Promise<{ files: string[], index: number }>} */
  async function buildQueue(file) {
    if (plan.kindOf(file) === 'playlist') {
      const stat = await rawFs.promises.stat(file).catch(() => null)
      if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) return { files: [], index: 0 }
      const text = await rawFs.promises.readFile(file, 'utf8').catch(() => '')
      const listed = plan.parsePlaylist(file, text)
      const files = []
      for (const f of listed) {
        const st = await rawFs.promises.stat(f).catch(() => null)
        if (st?.isFile()) files.push(f)
      }
      return { files, index: 0 }
    }
    const files = plan.siblings(file, await listDir(path.dirname(file)))
    return { files, index: Math.max(0, files.indexOf(file)) }
  }

  function snapshot() {
    const t = tools()
    return {
      seq: state.seq,
      index: state.index,
      theme: theme() === 'light' ? 'light' : 'dark',
      tools: { mpv: Boolean(t.mpv), ffplay: Boolean(t.ffplay) },
      items: state.items.map((item, i) => ({
        name: item.name,
        kind: item.kind,
        html5: item.html5,
        url: state.urls[i] || '',
        dir: path.dirname(item.path)
      }))
    }
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  function isPlayer(event) {
    return Boolean(win && !win.isDestroyed() && event?.sender === win.webContents)
  }

  function itemAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.items.length) {
      throw Object.assign(new Error('MEDIA_BAD_INDEX'), { code: 'MEDIA_BAD_INDEX' })
    }
    return state.items[index]
  }

  async function ensureMpv() {
    if (mpv?.alive) return mpv
    if (mpvStarting) return mpvStarting
    const bin = tools().mpv
    if (!bin) throw Object.assign(new Error('MEDIA_NO_MPV'), { code: 'MEDIA_NO_MPV', userMessage: '沒有安裝 mpv' })
    const session = createMpvSession({ mpvPath: bin, spawnFn, extraArgs: deps.mpvArgs || [], tmpRoot: deps.mpvTmpRoot })
    session.on('property', (name, value) => {
      if (mpv && mpv !== session) return
      if (name !== 'time-pos') { send('mediaPlayer:mpvState', { props: { [name]: value } }); return }
      // 播放進度一秒好幾十次：最多每 200 ms 送一次，但最後一筆一定送到（暫停／跳轉後停在正確位置）
      pendingTime = value
      if (timeTimer) return
      const wait = Math.max(0, 200 - (Date.now() - lastPush))
      timeTimer = setTimeout(() => {
        timeTimer = null
        lastPush = Date.now()
        send('mediaPlayer:mpvState', { props: { 'time-pos': pendingTime } })
      }, wait)
    })
    session.on('event', (msg) => {
      recent.push(`${session.pid}:${msg.event}${msg.reason ? `:${msg.reason}` : ''}`)
      if (recent.length > 40) recent.shift()
      if (mpv && mpv !== session) return
      if (msg.event === 'end-file') send('mediaPlayer:mpvState', { event: 'end-file', reason: msg.reason || '' })
      if (msg.event === 'file-loaded') send('mediaPlayer:mpvState', { event: 'file-loaded' })
    })
    session.on('exit', () => {
      // 只有「正在用的那一個」自己結束（使用者關掉 mpv 視窗）才通知；換清單時收掉的舊程序不算
      if (mpv !== session) return
      mpv = null
      send('mediaPlayer:mpvState', { event: 'exit' })
    })
    const gen = mpvGen
    startingSession = session
    const starting = session.start().then(() => {
      if (gen !== mpvGen) {
        // 啟動途中播放視窗被關掉或換了清單：這個 mpv 已經沒人要了
        session.quit()
        throw Object.assign(new Error('MEDIA_MPV_CANCELLED'), { code: 'MEDIA_MPV_CANCELLED' })
      }
      mpv = session
      return session
    }, (err) => {
      // 連不上 IPC 時程序可能還活著，一起收掉
      session.killNow()
      throw err
    }).finally(() => {
      if (startingSession === session) startingSession = null
      if (mpvStarting === starting) mpvStarting = null
    })
    mpvStarting = starting
    return starting
  }

  function stopMpv() {
    mpvGen += 1
    mpvStarting = null
    const s = mpv
    mpv = null
    if (s) s.quit()
  }

  const num = (v, lo, hi) => {
    const n = Number(v)
    if (!Number.isFinite(n)) throw Object.assign(new Error('MEDIA_BAD_VALUE'), { code: 'MEDIA_BAD_VALUE' })
    return Math.min(hi, Math.max(lo, n))
  }

  /**
   * renderer 只送動作名稱＋數字；mpv 指令全在這裡組。
   * @param {{ action: string, index?: number, value?: unknown }} req
   */
  async function mpvAction(req) {
    const action = String(req?.action || '')
    if (action === 'stop') { stopMpv(); return true }
    if (action === 'load') {
      const item = itemAt(req.index)
      const s = await ensureMpv()
      await s.command(['set_property', 'pause', false])
      await s.command(['loadfile', item.path, 'replace'])
      return true
    }
    const s = mpv
    if (!s?.alive) throw Object.assign(new Error('MEDIA_MPV_IDLE'), { code: 'MEDIA_MPV_IDLE' })
    switch (action) {
      case 'pause': return s.command(['set_property', 'pause', req.value === true])
      case 'toggle': return s.command(['cycle', 'pause'])
      case 'seek': return s.command(['seek', num(req.value, -86400, 86400), 'relative'])
      case 'seekTo': return s.command(['seek', num(req.value, 0, 864000), 'absolute'])
      case 'volume': return s.command(['set_property', 'volume', num(req.value, 0, 130)])
      case 'mute': return s.command(['set_property', 'mute', req.value === true])
      case 'speed': return s.command(['set_property', 'speed', num(req.value, 0.25, 4)])
      case 'subCycle': return s.command(['cycle', 'sub'])
      case 'subToggle': return s.command(['cycle', 'sub-visibility'])
      case 'subDelay': return s.command(['add', 'sub-delay', num(req.value, -10, 10)])
      case 'audioCycle': return s.command(['cycle', 'audio'])
      case 'fullscreen': return s.command(['cycle', 'fullscreen'])
      case 'screenshot': return s.command(['screenshot'])
      case 'frameStep': return s.command([req.value === -1 ? 'frame-back-step' : 'frame-step'])
      case 'getProps': return { ...s.props }
      default: throw Object.assign(new Error('MEDIA_BAD_ACTION'), { code: 'MEDIA_BAD_ACTION' })
    }
  }

  /** 字幕（HTML5 用）：同名 .srt／.vtt 轉成 VTT 文字；.ass／.ssa 只列出來（要 mpv 才看得到樣式） */
  async function subtitles(index) {
    const item = itemAt(index)
    if (item.kind !== 'video') return []
    const found = plan.findSubtitles(item.path, await listDir(path.dirname(item.path)))
    const out = []
    for (const sub of found) {
      if (sub.format !== 'srt' && sub.format !== 'vtt') { out.push({ label: sub.label, lang: sub.lang, format: sub.format, vtt: '' }); continue }
      const st = await rawFs.promises.stat(sub.path).catch(() => null)
      if (!st?.isFile() || st.size > MAX_SUB_BYTES) continue
      const text = await rawFs.promises.readFile(sub.path, 'utf8').catch(() => '')
      out.push({ label: sub.label, lang: sub.lang, format: sub.format, vtt: sub.format === 'srt' ? plan.srtToVtt(text) : text.replace(/^\ufeff/, '') })
    }
    return out
  }

  /** 交給外部：ffplay（沒有遙控）或系統預設程式 */
  async function external(index, which) {
    const item = itemAt(index)
    if (which === 'ffplay') {
      const bin = tools().ffplay
      if (!bin) throw Object.assign(new Error('MEDIA_NO_FFPLAY'), { code: 'MEDIA_NO_FFPLAY' })
      await launchDetached(bin, ['-autoexit', '-window_title', item.name, item.path])
      return true
    }
    const err = await deps.openWithSystem(item.path)
    if (err) throw Object.assign(new Error('MEDIA_SYSTEM_OPEN'), { code: 'MEDIA_SYSTEM_OPEN', userMessage: String(err) })
    return true
  }

  function launchDetached(bin, args) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(bin, args, { detached: true, stdio: 'ignore', shell: false })
      child.once('error', () => reject(Object.assign(new Error('MEDIA_SPAWN'), { code: 'MEDIA_SPAWN' })))
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }

  function setupIpc() {
    if (ipcReady) return
    ipcReady = true
    const { ipcMain } = el()
    const guard = (fn) => async (event, ...args) => {
      if (!isPlayer(event)) throw Object.assign(new Error('MEDIA_FORBIDDEN'), { code: 'MEDIA_FORBIDDEN' })
      return fn(...args)
    }
    ipcMain.handle('mediaPlayer:state', guard(async () => snapshot()))
    ipcMain.handle('mediaPlayer:select', guard(async (index) => { itemAt(index); state.index = index; return true }))
    ipcMain.handle('mediaPlayer:subtitles', guard((index) => subtitles(index)))
    ipcMain.handle('mediaPlayer:mpv', guard((req) => mpvAction(req)))
    ipcMain.handle('mediaPlayer:external', guard((index, which) => external(index, which === 'ffplay' ? 'ffplay' : 'system')))
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win
    const { BrowserWindow, Menu } = el()
    win = new BrowserWindow({
      width: 1024,
      height: 640,
      minWidth: 480,
      minHeight: 320,
      title: 'AxonDeck 播放器',
      icon: ICON,
      backgroundColor: theme() === 'light' ? '#f4f4f5' : '#0d1012',
      autoHideMenuBar: true,
      show: false,
      ...(deps.windowOptions || {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
        preload: PRELOAD
      }
    })
    if (Menu) win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show() })
    win.on('closed', () => {
      win = null
      stopMpv()
    })
    void win.loadFile(PAGE)
    return win
  }

  /**
   * @param {string} file 已過呼叫端路徑守衛的絕對路徑
   * @returns {Promise<boolean>} false＝沒接手（呼叫端改走系統開啟）
   */
  async function open(file) {
    const kind = plan.kindOf(file)
    if (kind !== 'video' && kind !== 'audio' && kind !== 'playlist') return false
    const { files, index } = await buildQueue(file)
    if (!files.length) return false
    const items = files.map((f) => plan.planItem(f))
    const t = tools()
    const first = items[index]
    if (!first.html5 && !t.mpv) {
      // 沒有 mpv 又不是 Chromium 能播的：交給 ffplay，再不行就讓呼叫端走系統開啟
      if (!t.ffplay) return false
      await launchDetached(t.ffplay, ['-autoexit', '-window_title', first.name, first.path])
      return true
    }
    setupIpc()
    stopMpv()
    state.items = items
    state.urls = playerProtocol.publish(items)
    state.index = index
    state.seq += 1
    const w = ensureWindow()
    if (w.webContents.isLoading()) {
      // 頁面還沒載完：載完後自己會來拿 state
    } else {
      send('mediaPlayer:queue', snapshot())
    }
    if (w.isVisible()) { if (w.isMinimized()) w.restore(); w.focus() }
    return true
  }

  function shutdown() {
    mpvGen += 1
    mpvStarting = null
    if (startingSession) startingSession.killNow()
    if (mpv) mpv.killNow()
    mpv = null
  }

  return { open, shutdown, mpvAction, subtitles, external, snapshot, buildQueue, get window() { return win }, get mpv() { return mpv }, get recentEvents() { return [...recent] } }
}

let shared = null
/** @param {Parameters<typeof createController>[0]} deps */
function getController(deps) {
  if (!shared) shared = createController(deps)
  return shared
}

module.exports = { createController, getController }
