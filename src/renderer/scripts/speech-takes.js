/**
 * 生成結果：底部播放列（波形），上方抽屜切換「版本」或「分句」清單。
 * 版本存在 main（userData/breeze-tts/takes），這裡只拿目前選的那一版來播。
 */
import { drawWave, svgIcon } from './speech-wave.js'
import { formatTime } from './speech-script.js'
import { askConfirm } from './app-dialog.js'

const RATE = 24000
const $ = (id) => document.getElementById(id)

function stamp(time) {
  const date = new Date(time)
  const clock = date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
  return date.toDateString() === new Date().toDateString() ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

export function createTakeDock({ call, onRedo, onError }) {
  const player = $('speechPlayer')
  const canvas = $('speechWave')
  const takeList = $('speechTakes')
  const list = $('speechSegments')
  const dockEl = document.querySelector('.speech-dock')
  let takes = []
  let current = null
  let peaks = []
  let url = ''
  let stopAt = Infinity
  let busy = false
  let editing = -1
  let drawer = 'segments' // 播放列上方的抽屜：'segments' | 'takes' | ''（收起）
  let followed = -1
  let live = null // 邊生成邊播放中：播放鍵改成暫停／繼續那段串流

  const duration = () => current?.duration || 0
  // 播放中換版本會讓上一個 play() 以 AbortError 結束，那是預期的；其他錯誤照常回報
  const play = () => player.play().catch((error) => { if (error.name !== 'AbortError') onError(error) })
  const segmentAt = (time) => current?.segments.findIndex((s) => time >= s.offset / RATE && time < (s.offset + s.length) / RATE) ?? -1

  /** 播到哪一句就把那句捲進分句清單的可視範圍（只捲清單本身，不動整頁）。 */
  function follow(index) {
    if (index === followed || index < 0 || player.paused) return
    followed = index
    const row = list.children[index]
    if (!row) return
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop - list.clientHeight / 3
    }
  }

  function paint() {
    const total = duration()
    const index = segmentAt(player.currentTime)
    const segment = current?.segments[index]
    const marks = current && current.segments.length > 1 ? current.segments.slice(1).map((s) => s.offset / RATE / total) : []
    drawWave(canvas, peaks, { progress: total ? player.currentTime / total : -1, marks,
      active: segment && current.segments.length > 1 ? [segment.offset / RATE / total, (segment.offset + segment.length) / RATE / total] : null })
    $('speechTime').textContent = `${formatTime(player.currentTime)} / ${formatTime(total)}`
    for (const row of list.children) row.classList.toggle('playing', Number(row.dataset.index) === index && !player.paused)
    follow(index)
  }

  function frame() {
    if (player.currentTime >= stopAt) { player.pause(); stopAt = Infinity }
    paint()
    if (!player.paused) requestAnimationFrame(frame)
  }

  function paintButtons() {
    const empty = !current
    const paused = live ? live.paused : player.paused
    $('speechPlay').disabled = empty && !live
    $('speechPlay').innerHTML = svgIcon(paused ? 'play' : 'pause')
    $('speechPlay').setAttribute('aria-label', live ? (paused ? '繼續播放生成中的聲音' : '暫停生成中的聲音') : paused ? '播放' : '暫停')
    $('speechPlay').classList.toggle('live', Boolean(live))
    $('speechExport').disabled = empty || busy
    for (const button of takeList.querySelectorAll('.take-delete')) button.disabled = busy
    for (const button of list.querySelectorAll('.seg-redo, .seg-edit')) button.disabled = busy
  }

  function paintDrawer() {
    const count = current?.segments.length || 0
    const showSegments = drawer === 'segments' && count > 1
    const showTakes = drawer === 'takes' && takes.length > 0
    $('speechSegToggle').hidden = count < 2
    $('speechSegCount').textContent = String(count)
    $('speechSegToggle').setAttribute('aria-expanded', String(showSegments))
    $('speechSegBox').hidden = !showSegments
    $('speechTakesToggle').hidden = !takes.length
    $('speechTakeCount').textContent = String(takes.length)
    $('speechTakesToggle').setAttribute('aria-expanded', String(showTakes))
    $('speechTakeBox').hidden = !showTakes
  }

  function toggleDrawer(name) {
    drawer = drawer === name ? '' : name
    paintDrawer()
    if (drawer === 'takes') takeList.querySelector('.current .take-pick')?.scrollIntoView({ block: 'nearest' })
  }

  function renderTakes() {
    takeList.replaceChildren(...takes.map((take, index) => {
      const n = takes.length - index
      const row = document.createElement('li')
      row.className = 'speech-take'
      row.dataset.id = take.id
      row.innerHTML = `<button type="button" class="btn-icon take-play">${svgIcon('play')}</button>
        <button type="button" class="take-pick"><span class="take-title"></span><span class="take-meta"></span></button>
        <button type="button" class="btn-icon take-delete">${svgIcon('trash')}</button>`
      const meta = [`版本 ${n}`, stamp(take.createdAt), `${take.duration.toFixed(1)} 秒`, take.mode, take.voice].filter(Boolean).join(' · ')
      row.querySelector('.take-title').textContent = take.title || '未命名'
      row.querySelector('.take-meta').textContent = meta
      row.querySelector('.take-pick').title = take.title || ''
      row.querySelector('.take-play').setAttribute('aria-label', `播放版本 ${n}`)
      row.querySelector('.take-delete').setAttribute('aria-label', `刪除版本 ${n}`)
      return row
    }))
    paintDrawer()
    paintCurrent()
  }

  function paintCurrent() {
    for (const row of takeList.children) {
      const on = row.dataset.id === current?.id
      row.classList.toggle('current', on)
      if (on) row.querySelector('.take-pick').setAttribute('aria-current', 'true')
      else row.querySelector('.take-pick').removeAttribute('aria-current')
    }
  }

  function renderSegments() {
    editing = -1
    followed = -1
    const segments = current?.segments || []
    list.replaceChildren(...(segments.length < 2 ? [] : segments.map((segment, index) => {
      const row = document.createElement('li')
      row.className = 'speech-seg'
      row.dataset.index = String(index)
      row.innerHTML = `<button type="button" class="btn-icon seg-play">${svgIcon('play')}</button>
        <span class="seg-time"></span><span class="seg-speaker"></span><p class="seg-text"></p>
        <button type="button" class="btn-icon seg-edit">${svgIcon('pencil')}</button>
        <button type="button" class="btn-icon seg-redo">${svgIcon('redo')}</button>`
      row.querySelector('.seg-time').textContent = formatTime(segment.offset / RATE)
      row.querySelector('.seg-speaker').textContent = segment.speaker || ''
      row.querySelector('.seg-speaker').hidden = !segment.speaker
      row.querySelector('.seg-text').textContent = segment.text || '（沒有文字）'
      const n = index + 1
      row.querySelector('.seg-play').setAttribute('aria-label', `播放第 ${n} 句`)
      row.querySelector('.seg-edit').setAttribute('aria-label', `修改第 ${n} 句`)
      row.querySelector('.seg-edit').title = '修改這句的文字，再按重做（Ctrl+Enter）'
      row.querySelector('.seg-redo').setAttribute('aria-label', `重做第 ${n} 句`)
      row.querySelector('.seg-redo').title = '用目前的聲音設定重新生成這一句，其他句不變'
      return row
    })))
    paintDrawer()
    paintButtons()
  }

  function playRange(start, end = Infinity) {
    player.currentTime = start
    stopAt = end
    play()
  }

  function stopEditing(row, segment) {
    const area = row.querySelector('.seg-input')
    if (!area) return
    const text = document.createElement('p')
    text.className = 'seg-text'
    text.textContent = segment.text || '（沒有文字）'
    area.replaceWith(text)
    editing = -1
    row.querySelector('.seg-edit').focus()
  }

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.speech-seg')
    if (!row || !current) return
    const index = Number(row.dataset.index)
    const segment = current.segments[index]
    if (event.target.closest('.seg-play')) return playRange(segment.offset / RATE, (segment.offset + segment.length) / RATE)
    if (event.target.closest('.seg-edit')) {
      if (editing === index) return
      if (editing >= 0) stopEditing(list.children[editing], current.segments[editing])
      editing = index
      const area = document.createElement('textarea')
      area.className = 'input seg-input'
      area.value = segment.text
      area.rows = 2
      area.maxLength = 10000
      area.setAttribute('aria-label', `第 ${index + 1} 句的文字（Ctrl+Enter 重做，Esc 取消）`)
      row.querySelector('.seg-text').replaceWith(area)
      area.focus()
      return
    }
    if (event.target.closest('.seg-redo')) {
      const text = row.querySelector('.seg-input')?.value.trim() ?? segment.text
      void onRedo(current, index, text)
      return
    }
    if (!event.target.closest('textarea')) { player.currentTime = segment.offset / RATE; paint() }
  })
  list.addEventListener('keydown', (event) => {
    const row = event.target.closest('.speech-seg')
    if (!row || !event.target.matches('.seg-input') || !current) return
    if (event.key === 'Escape') { event.preventDefault(); stopEditing(row, current.segments[Number(row.dataset.index)]) }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); row.querySelector('.seg-redo').click() }
  })

  async function load(id) {
    if (!id) {
      current = null; peaks = []; player.removeAttribute('src')
      $('speechResultTitle').textContent = '你的聲音會出現在這裡'
      dockEl.dataset.empty = ''
      renderSegments(); paintCurrent(); paint(); return
    }
    const data = await call('loadTake', { id })
    const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0))
    if (url) URL.revokeObjectURL(url)
    url = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }))
    player.src = url
    current = data.take
    peaks = data.peaks
    delete dockEl.dataset.empty
    $('speechResultTitle').textContent = current.title || '語音版本'
    $('speechResultTitle').title = current.title || ''
    renderSegments()
    paintCurrent()
    requestAnimationFrame(paint)
  }

  async function refresh(selectId) {
    takes = await call('listTakes')
    renderTakes()
    const id = selectId && takes.some((t) => t.id === selectId) ? selectId : current && takes.some((t) => t.id === current.id) ? current.id : takes[0]?.id
    if (id !== current?.id || selectId) await load(id)
    paintButtons()
  }

  async function pick(id, autoplay) {
    if (id !== current?.id) { player.pause(); await load(id) }
    if (autoplay) { stopAt = Infinity; player.currentTime = 0; play() }
  }

  async function removeTake(id) {
    const n = takes.length - takes.findIndex((take) => take.id === id)
    if (!await askConfirm(`刪除版本 ${n}？`, { desc: '這個版本的音檔會從這台電腦移除。', confirmText: '刪除', danger: true })) return
    if (current?.id === id) { player.pause(); current = null }
    await call('removeTake', { id })
    await refresh()
  }

  takeList.addEventListener('click', (event) => {
    const row = event.target.closest('.speech-take')
    if (!row) return
    const id = row.dataset.id
    const task = event.target.closest('.take-delete') ? removeTake(id) : pick(id, Boolean(event.target.closest('.take-play')))
    task.catch(onError)
  })
  // 版本清單：方向鍵在版本之間移動並切換（清單會換行成多欄，左右也能用）
  takeList.addEventListener('keydown', (event) => {
    const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key]
    if (!step || !event.target.matches('.take-pick')) return
    event.preventDefault()
    const rows = [...takeList.children]
    const next = rows[rows.indexOf(event.target.closest('.speech-take')) + step]
    if (!next) return
    next.querySelector('.take-pick').focus()
    pick(next.dataset.id, false).catch(onError)
  })
  $('speechSegToggle').addEventListener('click', () => toggleDrawer('segments'))
  $('speechTakesToggle').addEventListener('click', () => toggleDrawer('takes'))
  $('speechPlay').addEventListener('click', () => {
    if (live) { live.toggle().then(paintButtons, onError); return }
    if (player.paused) { stopAt = Infinity; play() } else player.pause()
  })
  player.addEventListener('play', () => { paintButtons(); requestAnimationFrame(frame) })
  player.addEventListener('pause', () => { paintButtons(); paint() })
  player.addEventListener('ended', () => { paintButtons(); paint() })
  canvas.addEventListener('pointerdown', (event) => {
    if (!current) return
    player.currentTime = (event.offsetX / canvas.clientWidth) * duration()
    paint()
  })
  canvas.addEventListener('keydown', (event) => {
    if (!current) return
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); $('speechPlay').click() }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      player.currentTime = Math.max(0, Math.min(duration(), player.currentTime + (event.key === 'ArrowLeft' ? -5 : 5)))
      paint()
    }
  })
  $('speechExport').addEventListener('click', async () => {
    try {
      const result = await call('saveAudio', { takeId: current.id })
      if (result.saved) $('speechProgress').textContent = 'WAV 已匯出。'
    } catch (error) { onError(error) }
  })
  new ResizeObserver(() => paint()).observe(canvas)

  return {
    refresh,
    get current() { return current },
    setBusy(value) { busy = value; paintButtons() },
    /** 串流播放開始／結束時呼叫；有串流時播放鍵控制它。 */
    setLive(stream) { live = stream; paintButtons() },
    /** 生成進度：null 隱藏，-1 不確定（整段），0～1 逐句完成比例。 */
    setProgress(value) {
      const bar = $('speechBar')
      bar.hidden = value === null
      bar.classList.toggle('indeterminate', value === -1)
      bar.firstElementChild.style.width = value >= 0 ? `${Math.max(4, value * 100)}%` : ''
    },
    pause() { player.pause() },
    dispose() { player.pause(); if (url) URL.revokeObjectURL(url) }
  }
}
