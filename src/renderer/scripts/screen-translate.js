const { electronAPI } = window
const pauseButton = document.getElementById('pause')
const modeButton = document.getElementById('displayMode')
const statusLabel = document.getElementById('status')
const translationLabel = document.getElementById('translation')
let paused = false
const LANGUAGES = { auto: '自動', 'zh-TW': '繁中', 'zh-CN': '簡中', en: '英文', ja: '日文', ko: '韓文' }
const STAGES = { preparing: '準備模型…', waiting: '對準要翻譯的文字…', ocr: '辨識中…', translate: '翻譯中…',
  watching: '自動翻譯中', empty: '框內沒有文字', paused: '已暫停' }
const PAUSE_LABELS = { pause: '暫停', play: '繼續', retry: '重試' }
const MIN_SIZE = { width: 240, height: 110 }

function paint(state) {
  if (!state.open) return
  paused = state.paused
  document.getElementById('language').textContent = `${LANGUAGES[state.sourceLang]} → ${LANGUAGES[state.targetLang]}`
  statusLabel.textContent = state.error || STAGES[state.stage] || '準備中…'
  statusLabel.dataset.stage = state.error ? 'error' : state.stage
  statusLabel.title = `${statusLabel.textContent}\nOCR：PaddleOCR-VL · 翻譯：${state.model}`
  const mode = state.error ? 'retry' : paused ? 'play' : 'pause'
  pauseButton.dataset.mode = mode
  pauseButton.setAttribute('aria-label', PAUSE_LABELS[mode])
  pauseButton.title = PAUSE_LABELS[mode]
  document.getElementById('source').textContent = state.translation ? state.source : ''
  translationLabel.textContent = state.translation || (state.stage === 'translate' ? state.source : '把視窗蓋到要翻譯的文字上')
  translationLabel.dataset.empty = String(!state.translation)
}

function showError(message) {
  statusLabel.textContent = message
  statusLabel.dataset.stage = 'error'
}

async function action(name, value) {
  try {
    const result = await electronAPI.screenTranslate[name](value)
    if (!result.ok) { showError(result.error?.message || '操作失敗，請重試'); return }
    if (result.data?.open && name !== 'resize') paint(result.data)
  } catch { showError('操作失敗，請重試') }
}

function applyDisplayMode(mode) {
  const translationOnly = mode === 'translation'
  document.body.dataset.mode = translationOnly ? 'translation' : 'bilingual'
  modeButton.textContent = translationOnly ? '譯文' : '雙語'
  modeButton.title = translationOnly ? '僅譯文（點擊切為雙語）' : '雙語（點擊切為僅譯文）'
  modeButton.setAttribute('aria-label', translationOnly ? '切換為雙語' : '切換為僅譯文')
}

modeButton.addEventListener('click', () => {
  const next = document.body.dataset.mode === 'translation' ? 'bilingual' : 'translation'
  applyDisplayMode(next)
  electronAPI.store.set('screenTranslateDisplayMode', next).catch(() => showError('顯示模式沒存起來，下次會用預設'))
})
electronAPI.store.get('screenTranslateDisplayMode', 'bilingual').then(applyDisplayMode).catch(() => applyDisplayMode('bilingual'))

/** 依拖曳的邊算出新視窗大小；從左／上縮時固定右／下緣，不讓視窗跟著跑。 */
function resizedBounds(edge, start, dx, dy) {
  const width = edge.includes('e') ? start.width + dx : edge.includes('w') ? start.width - dx : start.width
  const height = edge.includes('s') ? start.height + dy : edge.includes('n') ? start.height - dy : start.height
  const next = { width: Math.max(MIN_SIZE.width, width), height: Math.max(MIN_SIZE.height, height) }
  return { ...next,
    x: edge.includes('w') ? start.x + start.width - next.width : start.x,
    y: edge.includes('n') ? start.y + start.height - next.height : start.y }
}

/** 按住後每個畫面最多送一次新大小給 main。 */
function trackPointer(element, event, boundsFor) {
  const start = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }
  const origin = { x: event.screenX, y: event.screenY }
  let frame = 0, latest = null
  element.setPointerCapture(event.pointerId)
  element.classList.add('active')
  const move = (moveEvent) => {
    latest = boundsFor(start, moveEvent.screenX - origin.x, moveEvent.screenY - origin.y)
    frame ||= requestAnimationFrame(() => { frame = 0; void action('resize', latest) })
  }
  const end = () => {
    element.classList.remove('active')
    element.removeEventListener('pointermove', move)
    element.removeEventListener('lostpointercapture', end)
  }
  element.addEventListener('pointermove', move)
  element.addEventListener('lostpointercapture', end)
}

for (const handle of document.querySelectorAll('[data-edge]')) {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button === 0) trackPointer(handle, event, (start, dx, dy) => resizedBounds(handle.dataset.edge, start, dx, dy))
  })
}
const textArea = document.getElementById('text')
const markScrollable = () => textArea.classList.toggle('scrollable', textArea.scrollHeight > textArea.clientHeight)
new ResizeObserver(markScrollable).observe(textArea)
new MutationObserver(markScrollable).observe(textArea, { childList: true, subtree: true, characterData: true })

pauseButton.addEventListener('click', async () => {
  pauseButton.disabled = true
  await action('pause', !paused)
  pauseButton.disabled = false
})
document.getElementById('close').addEventListener('click', () => action('close'))
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') void action('close') })
electronAPI.screenTranslate.onState(paint)
void action('status')
