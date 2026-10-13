/**
 * 參考音／原錄音輸入：選檔或直接錄音，看波形、拖曳選一段裁掉頭尾。
 * 錄音與轉檔都在 main 做；這裡只管畫面、麥克風與選取範圍。
 */
import { drawWave, svgIcon } from './speech-wave.js'

const MAX_RECORD_SECONDS = 120

export function createAudioInput({ root, kind, pickId, nameId, call, onChange, onBusy }) {
  root.classList.add('speech-input')
  root.innerHTML = `
    <div class="speech-input-actions">
      <button id="${pickId}" type="button" class="btn btn-secondary btn-sm">${svgIcon('upload')}選擇檔案</button>
      <button type="button" class="btn btn-secondary btn-sm speech-record" aria-pressed="false">${svgIcon('mic')}<span>錄音</span></button>
    </div>
    <p id="${nameId}" class="speech-file-name">尚未選擇 · 支援 WAV、MP3、M4A、FLAC 等</p>
    <div class="speech-input-wave" hidden>
      <canvas class="speech-wave-canvas" height="56" aria-label="錄音波形，可拖曳選取要保留的段落"></canvas>
      <div class="speech-input-trim">
        <span class="speech-trim-range" aria-live="polite"></span>
        <button type="button" class="btn-icon speech-trim-play" title="試聽選取段落" aria-label="試聽選取段落">${svgIcon('play')}</button>
        <button type="button" class="btn btn-secondary btn-sm speech-trim-apply" disabled>${svgIcon('scissors')}只留選取段落</button>
      </div>
    </div>`
  const recordBtn = root.querySelector('.speech-record')
  const name = root.querySelector(`#${CSS.escape(nameId)}`)
  const wave = root.querySelector('.speech-input-wave')
  const canvas = root.querySelector('canvas')
  const rangeLabel = root.querySelector('.speech-trim-range')
  const playBtn = root.querySelector('.speech-trim-play')
  const applyBtn = root.querySelector('.speech-trim-apply')
  const preview = new Audio()
  let audio = null
  let selection = null
  let recorder = null
  let recordTimer = 0
  let previewUrl = ''

  const seconds = (x) => audio ? Math.max(0, Math.min(audio.duration, (x / canvas.clientWidth) * audio.duration)) : 0

  function paint() {
    if (!audio) return
    const range = selection ? [selection[0] / audio.duration, selection[1] / audio.duration] : null
    drawWave(canvas, audio.peaks, { range })
    const [a, b] = selection || [0, audio.duration]
    rangeLabel.textContent = selection ? `選取 ${a.toFixed(1)}–${b.toFixed(1)} 秒（${(b - a).toFixed(1)} 秒）` : '拖曳波形選一段，可裁掉雜音或空白'
    applyBtn.disabled = !selection || b - a < 0.3
    playBtn.hidden = !previewUrl
  }

  function set(next) {
    audio = next
    selection = null
    preview.pause()
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    previewUrl = ''
    if (next?.previewBase64) {
      const bytes = Uint8Array.from(atob(next.previewBase64), (c) => c.charCodeAt(0))
      previewUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      preview.src = previewUrl
    }
    name.textContent = next ? `${next.name} · ${Number(next.duration).toFixed(1)} 秒` : '尚未選擇 · 支援 WAV、MP3、M4A、FLAC 等'
    wave.hidden = !next?.peaks?.length
    requestAnimationFrame(paint)
    onChange(next)
  }

  async function run(task, message) {
    onBusy(true, message)
    try { const next = await task(); if (next && !next.canceled) set(next) }
    finally { onBusy(false) }
  }

  let drag = null
  canvas.addEventListener('pointerdown', (event) => {
    if (!audio) return
    canvas.setPointerCapture(event.pointerId)
    drag = seconds(event.offsetX)
    selection = null
  })
  canvas.addEventListener('pointermove', (event) => {
    if (drag === null) return
    const at = seconds(event.offsetX)
    selection = Math.abs(at - drag) < 0.05 ? null : [Math.min(drag, at), Math.max(drag, at)]
    paint()
  })
  canvas.addEventListener('pointerup', () => { drag = null; paint() })
  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { selection = null; paint() }
  })
  canvas.tabIndex = 0

  playBtn.addEventListener('click', () => {
    if (!previewUrl) return
    const [a, b] = selection || [0, audio.duration]
    preview.currentTime = a
    void preview.play()
    const stop = () => { if (preview.currentTime >= b) { preview.pause(); preview.removeEventListener('timeupdate', stop) } }
    preview.addEventListener('timeupdate', stop)
  })

  applyBtn.addEventListener('click', () => {
    const [start, end] = selection
    void run(() => call('trimAudio', { audioId: audio.audioId, start, end }), '正在裁切並重新辨識逐字稿…').catch(report)
  })

  root.querySelector(`#${CSS.escape(pickId)}`).addEventListener('click', () => {
    void run(() => call('pickAudio', { kind }), kind === 'reference' ? '正在讀取錄音並辨識逐字稿…' : '正在讀取錄音…').catch(report)
  })

  function report(error) { root.dispatchEvent(new CustomEvent('speech-error', { bubbles: true, detail: error })) }

  async function stopRecording() {
    if (!recorder) return
    clearInterval(recordTimer)
    recorder.stop()
  }

  recordBtn.addEventListener('click', async () => {
    if (recorder) return stopRecording()
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }) }
    catch { return report(new Error('無法使用麥克風，請到 Windows 隱私權設定允許麥克風。')) }
    const chunks = []
    recorder = new MediaRecorder(stream)
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data) })
    recorder.addEventListener('stop', () => {
      for (const track of stream.getTracks()) track.stop()
      recorder = null
      recordBtn.classList.remove('recording')
      recordBtn.setAttribute('aria-pressed', 'false')
      recordBtn.querySelector('span').textContent = '錄音'
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })
      if (!blob.size) return
      void run(async () => call('importRecording', { kind, data: new Uint8Array(await blob.arrayBuffer()) }), '正在處理錄音…').catch(report)
    })
    recorder.start(250)
    const started = Date.now()
    recordBtn.classList.add('recording')
    recordBtn.setAttribute('aria-pressed', 'true')
    const tick = () => {
      const elapsed = (Date.now() - started) / 1000
      recordBtn.querySelector('span').textContent = `停止 ${elapsed.toFixed(0)} 秒`
      if (elapsed >= MAX_RECORD_SECONDS) void stopRecording()
    }
    tick()
    recordTimer = setInterval(tick, 250)
  })

  new ResizeObserver(() => paint()).observe(canvas)

  return {
    get value() { return audio },
    clear: () => set(null),
    setDisabled(disabled) {
      for (const el of root.querySelectorAll('button')) if (!(el === recordBtn && recorder)) el.disabled = disabled
      if (!disabled) paint()
    },
    dispose() { void stopRecording(); preview.pause(); if (previewUrl) URL.revokeObjectURL(previewUrl) }
  }
}
