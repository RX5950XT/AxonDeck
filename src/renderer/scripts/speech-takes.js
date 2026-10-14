/**
 * 生成結果區：版本切換、波形播放器、分句清單（逐句試聽、修改、重做）。
 * 版本存在 main（userData/breeze-tts/takes），這裡只拿目前選的那一版來播。
 */
import { drawWave, svgIcon } from './speech-wave.js'
import { formatTime } from './speech-script.js'
import { askConfirm } from './app-dialog.js'
import { syncCustomSelects } from './custom-select.js'

const RATE = 24000
const $ = (id) => document.getElementById(id)

export function createTakeDock({ call, onRedo, onError }) {
  const player = $('speechPlayer')
  const canvas = $('speechWave')
  const select = $('speechTakes')
  const list = $('speechSegments')
  let takes = []
  let current = null
  let peaks = []
  let url = ''
  let stopAt = Infinity
  let busy = false
  let editing = -1

  const duration = () => current?.duration || 0
  const segmentAt = (time) => current?.segments.findIndex((s) => time >= s.offset / RATE && time < (s.offset + s.length) / RATE) ?? -1

  function paint() {
    const total = duration()
    const index = segmentAt(player.currentTime)
    const segment = current?.segments[index]
    const marks = current && current.segments.length > 1 ? current.segments.slice(1).map((s) => s.offset / RATE / total) : []
    drawWave(canvas, peaks, { progress: total ? player.currentTime / total : -1, marks,
      active: segment && current.segments.length > 1 ? [segment.offset / RATE / total, (segment.offset + segment.length) / RATE / total] : null })
    $('speechTime').textContent = `${formatTime(player.currentTime)} / ${formatTime(total)}`
    for (const row of list.children) row.classList.toggle('playing', Number(row.dataset.index) === index && !player.paused)
  }

  function frame() {
    if (player.currentTime >= stopAt) { player.pause(); stopAt = Infinity }
    paint()
    if (!player.paused) requestAnimationFrame(frame)
  }

  function paintButtons() {
    const empty = !current
    $('speechPlay').disabled = empty
    $('speechPlay').innerHTML = svgIcon(player.paused ? 'play' : 'pause')
    $('speechPlay').setAttribute('aria-label', player.paused ? '播放' : '暫停')
    $('speechExport').disabled = empty || busy
    $('speechDeleteTake').disabled = empty || busy
    select.disabled = !takes.length || busy
    for (const button of list.querySelectorAll('.seg-redo, .seg-edit')) button.disabled = busy
  }

  function label(take, index) {
    const time = new Date(take.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
    const title = take.title ? ` · ${take.title.slice(0, 18)}${take.title.length > 18 ? '…' : ''}` : ''
    return `版本 ${takes.length - index} · ${time} · ${take.duration.toFixed(1)} 秒${title}`
  }

  function renderSegments() {
    editing = -1
    const segments = current?.segments || []
    list.hidden = segments.length < 2
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
      row.querySelector('.seg-edit').title = '修改這句的文字，再按重做'
      row.querySelector('.seg-redo').setAttribute('aria-label', `重做第 ${n} 句`)
      row.querySelector('.seg-redo').title = '用目前的聲音設定重新生成這一句，其他句不變'
      return row
    })))
    paintButtons()
  }

  function playRange(start, end = Infinity) {
    player.currentTime = start
    stopAt = end
    void player.play()
  }

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.speech-seg')
    if (!row || !current) return
    const index = Number(row.dataset.index)
    const segment = current.segments[index]
    if (event.target.closest('.seg-play')) return playRange(segment.offset / RATE, (segment.offset + segment.length) / RATE)
    if (event.target.closest('.seg-edit')) {
      if (editing === index) return
      editing = index
      const area = document.createElement('textarea')
      area.className = 'input seg-input'
      area.value = segment.text
      area.rows = 2
      area.maxLength = 10000
      area.setAttribute('aria-label', `第 ${index + 1} 句的文字`)
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

  async function load(id) {
    if (!id) { current = null; peaks = []; player.removeAttribute('src'); renderSegments(); paint(); return }
    const data = await call('loadTake', { id })
    const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0))
    if (url) URL.revokeObjectURL(url)
    url = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }))
    player.src = url
    current = data.take
    peaks = data.peaks
    select.value = id
    syncCustomSelects()
    $('speechResultTitle').textContent = current.title || '語音版本'
    renderSegments()
    requestAnimationFrame(paint)
  }

  async function refresh(selectId) {
    takes = await call('listTakes')
    select.replaceChildren(...takes.map((take, index) => new Option(label(take, index), take.id)))
    $('speechDockEmpty').hidden = takes.length > 0
    $('speechDockBody').hidden = takes.length === 0
    const id = selectId && takes.some((t) => t.id === selectId) ? selectId : current && takes.some((t) => t.id === current.id) ? current.id : takes[0]?.id
    if (id !== current?.id || selectId) await load(id)
    else { if (id) select.value = id; syncCustomSelects() }
    paintButtons()
  }

  select.addEventListener('change', () => { player.pause(); load(select.value).catch(onError) })
  $('speechPlay').addEventListener('click', () => { if (player.paused) { stopAt = Infinity; void player.play() } else player.pause() })
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
  $('speechDeleteTake').addEventListener('click', async () => {
    if (!current || !await askConfirm('刪除這個版本？', { desc: '這個版本的音檔會從這台電腦移除。', confirmText: '刪除', danger: true })) return
    try {
      player.pause()
      const id = current.id
      current = null
      await call('removeTake', { id })
      await refresh()
    } catch (error) { onError(error) }
  })
  new ResizeObserver(() => paint()).observe(canvas)

  return {
    refresh,
    get current() { return current },
    setBusy(value) { busy = value; paintButtons() },
    pause() { player.pause() },
    dispose() { player.pause(); if (url) URL.revokeObjectURL(url) }
  }
}
