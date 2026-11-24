/**
 * Linux 播放視窗（pages/media-player.html）。主視窗不載入這支。
 *
 * 每一首用的後端由 main 的 controller.js 決定順序：HTML5 → mpv（JSON IPC 遙控）→ ffplay → 系統預設程式。
 * HTML5 播不動（編碼不支援）就把這一首標成失敗，改走下一個後端。
 */

const api = window.axdPlayer
const $ = (id) => document.getElementById(id)
const video = /** @type {HTMLVideoElement} */ ($('mpVideo'))
const ui = {
  seek: /** @type {HTMLInputElement} */ ($('mpSeek')),
  play: $('mpPlay'),
  prev: $('mpPrev'),
  next: $('mpNext'),
  time: $('mpTime'),
  backend: $('mpBackend'),
  mute: $('mpMute'),
  volume: /** @type {HTMLInputElement} */ ($('mpVolume')),
  speed: /** @type {HTMLSelectElement} */ ($('mpSpeed')),
  subs: /** @type {HTMLSelectElement} */ ($('mpSubs')),
  repeat: $('mpRepeat'),
  shuffle: $('mpShuffle'),
  list: $('mpList'),
  full: $('mpFull'),
  helpBtn: $('mpHelpBtn'),
  help: $('mpHelp'),
  queue: $('mpQueue'),
  queueList: $('mpQueueList'),
  queueCount: $('mpQueueCount'),
  audioArt: $('mpAudioArt'),
  audioName: $('mpAudioName'),
  panel: $('mpPanel'),
  panelTitle: $('mpPanelTitle'),
  panelText: $('mpPanelText'),
  panelActions: $('mpPanelActions'),
  toast: $('mpToast')
}

const BACKEND_LABEL = { html5: '內建', mpv: 'mpv', ffplay: 'ffplay', system: '系統程式' }
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const st = {
  snap: /** @type {any} */ (null),
  index: 0,
  backend: '',
  failed: new Set(),
  repeat: 'off', // off → all → one
  shuffle: false,
  volume: 100,
  muted: false,
  speed: 1,
  mpv: { time: 0, duration: 0, pause: false },
  subUrls: /** @type {string[]} */ ([]),
  subIndex: -1,
  seeking: false,
  token: 0
}

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

let toastTimer = 0
function toast(text) {
  ui.toast.textContent = text
  ui.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { ui.toast.hidden = true }, 1600)
}

function current() { return st.snap?.items?.[st.index] || null }

function chooseBackend(index) {
  const item = st.snap.items[index]
  if (item.html5 && item.url && !st.failed.has(index)) return 'html5'
  if (st.snap.tools.mpv) return 'mpv'
  if (st.snap.tools.ffplay) return 'ffplay'
  return 'system'
}

function times() {
  if (st.backend === 'mpv') return { time: st.mpv.time, duration: st.mpv.duration, paused: st.mpv.pause }
  if (st.backend === 'html5') return { time: video.currentTime, duration: video.duration, paused: video.paused }
  return { time: 0, duration: 0, paused: true }
}

function paintTime() {
  const { time, duration, paused } = times()
  ui.time.textContent = `${fmt(time)} / ${fmt(duration)}`
  if (!st.seeking) ui.seek.value = duration > 0 ? String(Math.round((time / duration) * 1000)) : '0'
  ui.play.textContent = paused ? '▶' : '⏸'
  ui.play.setAttribute('aria-label', paused ? '播放' : '暫停')
  document.body.dataset.time = String(Math.round(time * 10) / 10)
  document.body.dataset.duration = String(Math.round((duration || 0) * 10) / 10)
  document.body.dataset.paused = String(paused)
}

function paintToggles() {
  ui.repeat.classList.toggle('is-on', st.repeat !== 'off')
  ui.repeat.textContent = st.repeat === 'one' ? '🔂' : '🔁'
  ui.repeat.title = { off: '重複：關（R）', all: '重複：整個清單（R）', one: '重複：這一首（R）' }[st.repeat]
  ui.shuffle.classList.toggle('is-on', st.shuffle)
  ui.mute.textContent = st.muted || st.volume === 0 ? '🔇' : '🔊'
  ui.volume.value = String(st.volume)
  ui.speed.value = String(st.speed)
  if (ui.speed.value !== String(st.speed)) {
    const opt = document.createElement('option')
    opt.value = String(st.speed)
    opt.textContent = `${st.speed}×`
    ui.speed.appendChild(opt)
    ui.speed.value = String(st.speed)
  }
}

function paintQueue() {
  const items = st.snap?.items || []
  ui.queueCount.textContent = `${st.index + 1}／${items.length}`
  ui.queueList.replaceChildren(...items.map((item, i) => {
    const li = document.createElement('li')
    li.textContent = item.name
    li.title = `${item.dir}/${item.name}`
    if (!item.html5) {
      const tag = document.createElement('span')
      tag.className = 'mp-tag'
      tag.textContent = st.snap.tools.mpv ? 'mpv' : '外部'
      li.appendChild(tag)
    }
    li.classList.toggle('is-current', i === st.index)
    li.addEventListener('click', () => void play(i))
    return li
  }))
  ui.prev.disabled = items.length < 2
  ui.next.disabled = items.length < 2
}

function showPanel(title, text, actions) {
  ui.panel.hidden = false
  ui.panelTitle.textContent = title
  ui.panelText.textContent = text
  ui.panelActions.replaceChildren(...actions.map(([label, fn]) => {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }))
}

function clearSubs() {
  for (const t of [...video.querySelectorAll('track')]) t.remove()
  for (const u of st.subUrls) URL.revokeObjectURL(u)
  st.subUrls = []
  ui.subs.replaceChildren()
}

function stopHtml5() {
  video.pause()
  video.removeAttribute('src')
  clearSubs()
  video.load()
}

async function loadSubs(index, token) {
  clearSubs()
  const item = st.snap.items[index]
  const off = new Option('字幕：關', '-1')
  if (st.backend === 'mpv') {
    ui.subs.append(new Option('字幕：mpv 自動', 'mpv'), new Option('下一個字幕（C）', 'mpv-next'), new Option('字幕開關（V）', 'mpv-toggle'))
    ui.subs.hidden = item.kind !== 'video'
    return
  }
  ui.subs.hidden = item.kind !== 'video'
  if (item.kind !== 'video') return
  const list = await api.subtitles(index).catch(() => [])
  if (token !== st.token) return
  ui.subs.append(off)
  list.forEach((sub, i) => {
    if (!sub.vtt) {
      const opt = new Option(`${sub.label}（需 mpv）`, '')
      opt.disabled = true
      ui.subs.append(opt)
      return
    }
    const url = URL.createObjectURL(new Blob([sub.vtt], { type: 'text/vtt' }))
    st.subUrls.push(url)
    const track = document.createElement('track')
    track.kind = 'subtitles'
    track.label = sub.label
    if (sub.lang) track.srclang = sub.lang.split(/[-_]/)[0]
    track.src = url
    video.appendChild(track)
    ui.subs.append(new Option(sub.label, String(i)))
  })
  const first = video.querySelector('track')
  if (first) first.default = true
  st.subIndex = video.textTracks.length ? 0 : -1
  applySubs()
  ui.subs.value = st.subIndex >= 0 ? '0' : '-1'
  document.body.dataset.subs = String(video.textTracks.length)
}

/** Chromium 載入時會依系統語言自動挑字幕（可能同時開兩條），所以每次載入後再套一次自己選的那條 */
function applySubs() {
  ;[...video.textTracks].forEach((t, i) => { t.mode = i === st.subIndex ? 'showing' : 'disabled' })
}

function selectSub(value) {
  if (st.backend === 'mpv') {
    if (value === 'mpv-next') void mpv('subCycle')
    if (value === 'mpv-toggle') void mpv('subToggle')
    ui.subs.value = 'mpv'
    return
  }
  // 選單裡停用的（.ass，需 mpv）沒有對應的 <track>，所以用「可選項目的第幾個」對回 textTracks
  const enabledOptions = [...ui.subs.options].filter((o) => o.value !== '' && o.value !== '-1')
  st.subIndex = enabledOptions.findIndex((o) => o.value === value)
  applySubs()
}

function cycleSub(step) {
  if (st.backend === 'mpv') { void mpv(step === 0 ? 'subToggle' : 'subCycle'); return }
  const tracks = [...video.textTracks]
  if (!tracks.length) { toast('沒有字幕'); return }
  const on = tracks.findIndex((t) => t.mode === 'showing')
  let next
  if (step === 0) next = on >= 0 ? -1 : 0
  else next = on + 1 >= tracks.length ? -1 : on + 1
  st.subIndex = next
  applySubs()
  const enabledOptions = [...ui.subs.options].filter((o) => o.value !== '' && o.value !== '-1')
  ui.subs.value = next >= 0 ? enabledOptions[next].value : '-1'
  toast(next >= 0 ? `字幕：${tracks[next].label}` : '字幕：關')
}

function mpv(action, value) {
  return api.mpv({ action, value }).catch((err) => {
    if (action !== 'getProps') toast('mpv 沒有回應')
    throw err
  })
}

async function play(index, opts = {}) {
  if (!st.snap || index < 0 || index >= st.snap.items.length) return
  const token = ++st.token
  const before = st.backend
  st.index = index
  void api.select(index).catch(() => {})
  const item = st.snap.items[index]
  const backend = chooseBackend(index)
  st.backend = backend
  document.body.dataset.backend = backend
  document.body.dataset.index = String(index)
  document.title = `${item.name} — AxonDeck 播放器`
  ui.backend.textContent = BACKEND_LABEL[backend]
  ui.panel.hidden = true
  ui.audioArt.hidden = item.kind !== 'audio' || backend !== 'html5'
  ui.audioName.textContent = item.name
  video.classList.toggle('is-audio', item.kind === 'audio')
  paintQueue()
  if (before === 'mpv' && backend !== 'mpv') void mpv('stop').catch(() => {})
  if (backend !== 'html5') stopHtml5()

  if (backend === 'html5') {
    video.src = item.url
    video.playbackRate = st.speed
    video.volume = st.volume / 100
    video.muted = st.muted
    await loadSubs(index, token)
    if (token !== st.token) return
    video.play().catch(() => { /* 錯誤由 error 事件處理 */ })
  } else if (backend === 'mpv') {
    st.mpv = { time: 0, duration: 0, pause: false }
    showPanel(item.name, `${opts.reason ? `${opts.reason}。` : ''}在 mpv 視窗播放；這裡可以遙控、看進度、切播放清單。`, [
      ['顯示／隱藏 mpv 全螢幕', () => void mpv('fullscreen')],
      ['改用系統預設程式開啟', () => void external(index, 'system')]
    ])
    try {
      await api.mpv({ action: 'load', index })
    } catch {
      if (token === st.token) showPanel(item.name, 'mpv 無法啟動或無法播放這個檔案。', [['改用系統預設程式開啟', () => void external(index, 'system')]])
      return
    }
    if (token !== st.token) return
    await loadSubs(index, token)
    void mpv('volume', st.volume).catch(() => {})
    void mpv('mute', st.muted).catch(() => {})
    void mpv('speed', st.speed).catch(() => {})
  } else {
    const why = opts.reason || '內建播放器不支援這個格式'
    const text = backend === 'ffplay'
      ? `${why}，也沒有安裝 mpv。可以用 ffplay 播放（另開視窗，這裡無法遙控）；安裝 mpv 後可在 AxonDeck 裡遙控播放。`
      : `${why}，也沒有安裝 mpv 或 ffplay。可以交給系統預設程式；安裝 mpv（例如 sudo apt install mpv）後可在 AxonDeck 裡遙控播放。`
    showPanel(item.name, text, [
      ...(backend === 'ffplay' ? [['用 ffplay 播放', () => void external(index, 'ffplay')]] : []),
      ['用系統預設程式開啟', () => void external(index, 'system')]
    ])
    ui.subs.hidden = true
  }
  paintTime()
}

async function external(index, which) {
  try {
    await api.external(index, which)
    toast(which === 'ffplay' ? '已用 ffplay 開啟' : '已交給系統預設程式')
  } catch {
    toast('開啟失敗')
  }
}

function pickNext(step, auto) {
  const n = st.snap?.items?.length || 0
  if (!n) return -1
  if (auto && st.repeat === 'one') return st.index
  if (st.shuffle && n > 1) {
    let i = st.index
    while (i === st.index) i = Math.floor(Math.random() * n)
    return i
  }
  const i = st.index + step
  if (i >= 0 && i < n) return i
  if (!auto || st.repeat === 'all') return (i + n) % n
  return -1
}

function next(step = 1, auto = false) {
  const i = pickNext(step, auto)
  if (i < 0) { paintTime(); return }
  void play(i)
}

function togglePlay() {
  if (st.backend === 'mpv') { void mpv('toggle'); return }
  if (st.backend !== 'html5') return
  if (video.paused) void video.play().catch(() => {})
  else video.pause()
}

function seekBy(sec) {
  if (st.backend === 'mpv') { void mpv('seek', sec); return }
  if (st.backend === 'html5' && Number.isFinite(video.duration)) {
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + sec))
  }
}

function seekTo(sec) {
  if (st.backend === 'mpv') { void mpv('seekTo', sec); return }
  if (st.backend === 'html5' && Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, Math.max(0, sec))
}

function setVolume(v) {
  st.volume = Math.max(0, Math.min(100, Math.round(v)))
  if (st.volume > 0) st.muted = false
  video.volume = st.volume / 100
  video.muted = st.muted
  if (st.backend === 'mpv') { void mpv('volume', st.volume).catch(() => {}); void mpv('mute', st.muted).catch(() => {}) }
  paintToggles()
}

function setMuted(m) {
  st.muted = m
  video.muted = m
  if (st.backend === 'mpv') void mpv('mute', m).catch(() => {})
  paintToggles()
  toast(m ? '靜音' : `音量 ${st.volume}%`)
}

function setSpeed(s) {
  st.speed = Math.max(0.25, Math.min(4, Math.round(s * 100) / 100))
  video.playbackRate = st.speed
  if (st.backend === 'mpv') void mpv('speed', st.speed).catch(() => {})
  paintToggles()
  toast(`速度 ${st.speed}×`)
}

function stepSpeed(dir) {
  const i = SPEEDS.findIndex((s) => s >= st.speed - 1e-6)
  const at = i < 0 ? SPEEDS.length - 1 : i
  setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + dir))])
}

function toggleFull() {
  if (st.backend === 'mpv') { void mpv('fullscreen'); return }
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void $('mpStage').requestFullscreen().catch(() => {})
}

function frameStep(dir) {
  if (st.backend === 'mpv') { void mpv('frameStep', dir); return }
  if (st.backend !== 'html5') return
  video.pause()
  video.currentTime = Math.max(0, video.currentTime + dir / 30)
}

function mpvOnly(action, value, label) {
  if (st.backend !== 'mpv') { toast(`${label}要用 mpv 播放時才有`); return }
  void mpv(action, value)
}

// ---------- HTML5 事件 ----------
video.addEventListener('timeupdate', paintTime)
video.addEventListener('play', paintTime)
video.addEventListener('pause', paintTime)
video.addEventListener('durationchange', paintTime)
video.addEventListener('ended', () => next(1, true))
video.addEventListener('loadedmetadata', () => {
  const item = current()
  if (st.backend !== 'html5' || !item) return
  applySubs()
  document.body.dataset.ready = String(st.index)
  // 影片容器對了、畫面編碼不支援（例如 HEVC）時，Chromium 只放得出聲音：有 mpv／ffplay 就改走它們；
  // 都沒有就留著聲音並提示（也可能真的是只有聲音的 .mp4）
  if (item.kind === 'video' && video.videoWidth === 0) {
    if (st.snap.tools.mpv || st.snap.tools.ffplay) fallback('內建播放器解不開這個影片的畫面')
    else toast('內建播放器解不開畫面，只播得出聲音；安裝 mpv 可完整播放')
  }
})
video.addEventListener('error', () => {
  if (st.backend !== 'html5' || !video.getAttribute('src')) return
  fallback('內建播放器不支援這個檔案的編碼')
})

function fallback(reason) {
  st.failed.add(st.index)
  document.body.dataset.fallback = `${st.index}:${reason}`
  void play(st.index, { reason })
}

// Chromium 自動選字幕（依系統語言）會在之後才發生：模式跟使用者選的不一樣就拉回來
video.textTracks.addEventListener('change', () => {
  const tracks = [...video.textTracks]
  if (tracks.some((t, i) => (t.mode === 'showing') !== (i === st.subIndex))) applySubs()
})

// ---------- mpv 狀態 ----------
api.onMpvState((msg) => {
  if (st.backend !== 'mpv') return
  if (msg.props) {
    const p = msg.props
    if ('time-pos' in p && Number.isFinite(p['time-pos'])) st.mpv.time = p['time-pos']
    if ('duration' in p && Number.isFinite(p.duration)) st.mpv.duration = p.duration
    if ('pause' in p) st.mpv.pause = Boolean(p.pause)
    paintTime()
  }
  if (msg.event === 'file-loaded') document.body.dataset.ready = String(st.index)
  if (msg.event === 'end-file' && msg.reason === 'eof') next(1, true)
  if (msg.event === 'exit') {
    showPanel(current()?.name || '', 'mpv 視窗已經關閉。', [['重新播放', () => void play(st.index)]])
  }
})

// ---------- 控制列 ----------
ui.play.addEventListener('click', togglePlay)
ui.prev.addEventListener('click', () => next(-1))
ui.next.addEventListener('click', () => next(1))
ui.seek.addEventListener('input', () => {
  st.seeking = true
  const { duration } = times()
  ui.time.textContent = `${fmt((Number(ui.seek.value) / 1000) * duration)} / ${fmt(duration)}`
})
ui.seek.addEventListener('change', () => {
  st.seeking = false
  const { duration } = times()
  if (duration > 0) seekTo((Number(ui.seek.value) / 1000) * duration)
})
ui.volume.addEventListener('input', () => setVolume(Number(ui.volume.value)))
ui.mute.addEventListener('click', () => setMuted(!st.muted))
ui.speed.addEventListener('change', () => setSpeed(Number(ui.speed.value)))
ui.subs.addEventListener('change', () => selectSub(ui.subs.value))
ui.repeat.addEventListener('click', () => {
  st.repeat = { off: 'all', all: 'one', one: 'off' }[st.repeat]
  paintToggles()
  toast(ui.repeat.title.replace('（R）', ''))
})
ui.shuffle.addEventListener('click', () => { st.shuffle = !st.shuffle; paintToggles(); toast(st.shuffle ? '隨機：開' : '隨機：關') })
ui.list.addEventListener('click', () => { ui.queue.hidden = !ui.queue.hidden })
ui.full.addEventListener('click', toggleFull)
ui.helpBtn.addEventListener('click', () => { ui.help.hidden = !ui.help.hidden })
video.addEventListener('click', togglePlay)
video.addEventListener('dblclick', toggleFull)
$('mpStage').addEventListener('wheel', (e) => { e.preventDefault(); setVolume(st.volume + (e.deltaY < 0 ? 5 : -5)) }, { passive: false })

// ---------- 快捷鍵（比照 Windows 原生播放器 actions.rs） ----------
document.addEventListener('keydown', (e) => {
  const tag = /** @type {HTMLElement} */ (e.target).tagName
  if (tag === 'SELECT' || (tag === 'INPUT' && e.key !== ' ' && !e.key.startsWith('Arrow'))) return
  const k = e.key
  if (e.ctrlKey) {
    if (k === 'l' || k === 'L') { ui.queue.hidden = !ui.queue.hidden; e.preventDefault() }
    return
  }
  const handled = (() => {
    switch (k) {
      case ' ': togglePlay(); return true
      case 'Enter': case 'f': case 'F': toggleFull(); return true
      case 'Escape':
        if (!ui.help.hidden) ui.help.hidden = true
        else if (document.fullscreenElement) void document.exitFullscreen()
        return true
      case 'F1': ui.help.hidden = !ui.help.hidden; return true
      case 'PageUp': next(-1); return true
      case 'PageDown': next(1); return true
      case 'Home': seekTo(0); return true
      case 'End': { const { duration } = times(); if (duration > 0) seekTo(Math.max(0, duration - 0.5)); return true }
      case 'ArrowLeft': seekBy(e.shiftKey ? -30 : -5); return true
      case 'ArrowRight': seekBy(e.shiftKey ? 30 : 5); return true
      case 'ArrowUp': setVolume(st.volume + 5); toast(`音量 ${st.volume}%`); return true
      case 'ArrowDown': setVolume(st.volume - 5); toast(`音量 ${st.volume}%`); return true
      case 'm': case 'M': setMuted(!st.muted); return true
      case 'r': case 'R': ui.repeat.click(); return true
      case 'l': case 'L': ui.shuffle.click(); return true
      case '[': stepSpeed(-1); return true
      case ']': stepSpeed(1); return true
      case 'Backspace': setSpeed(1); return true
      case '.': frameStep(1); return true
      case ',': frameStep(-1); return true
      case 'v': case 'V': cycleSub(0); return true
      case 'c': case 'C': cycleSub(1); return true
      case 'j': case 'J': mpvOnly('subDelay', -0.1, '字幕時間微調'); return true
      case 'k': case 'K': mpvOnly('subDelay', 0.1, '字幕時間微調'); return true
      case 'a': case 'A': mpvOnly('audioCycle', undefined, '切換音軌'); return true
      case 's': case 'S': mpvOnly('screenshot', undefined, '截圖'); return true
      default: return false
    }
  })()
  if (handled) e.preventDefault()
})

// ---------- 載入 ----------
async function load(snap) {
  st.snap = snap
  st.failed.clear()
  document.body.className = snap.theme === 'light' ? 'light' : 'dark'
  ui.queue.hidden = snap.items.length < 2
  paintToggles()
  await play(snap.index)
}

api.onQueue((snap) => void load(snap))
api.state().then((snap) => load(snap)).catch(() => {
  showPanel('無法載入', '播放清單讀取失敗。', [])
})
