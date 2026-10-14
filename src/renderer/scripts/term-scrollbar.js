/** 五家 AI。純 shell 的 PageUp／End 仍是分頁程式與行尾，不收。 */
const AI_PRESETS = new Set(['claude', 'codex', 'opencode', 'agy', 'grok'])

/**
 * 五家 AI 的一般畫面：PageUp 上移一頁、PageDown 下移一頁、End 回到最底。
 * xterm 預設把這三顆鍵送給 CLI，而且送出前會把捲軸拉回最底，所以上移永遠失敗。
 * 全螢幕仍交給 CLI。已經在最底時 End 也交給 CLI，游標才能移到行尾；
 * 按住不放的重複 End 不再補送，避免一次跳底之後連送好幾個行尾。
 * 回 true 表示已處理，呼叫端要 `return false` 吞掉。
 *
 * @param {import('@xterm/xterm').Terminal} term
 * @param {Pick<KeyboardEvent, 'key' | 'type' | 'repeat' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'preventDefault'>} event
 * @param {string | undefined} preset
 */
export function scrollAiViewport(term, event, preset) {
  if (!AI_PRESETS.has(preset)) return false
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
  if (term.buffer.active.type !== 'normal') return false
  const buffer = term.buffer.active
  if (event.key === 'End') {
    const atBottom = buffer.viewportY === buffer.baseY
    if (atBottom && !event.repeat) return false
    event.preventDefault()
    if (event.type === 'keydown' && !atBottom) term.scrollToBottom()
    return true
  }
  if (event.key !== 'PageUp' && event.key !== 'PageDown') return false
  event.preventDefault()
  if (event.type === 'keydown') term.scrollPages(event.key === 'PageUp' ? -1 : 1)
  return true
}

/** 共用原 CLI 的捲軸：與滑鼠滾輪共用 xterm 的實際列號。 */
export function bindTermScrollbar({ pane, term }) {
  const bar = document.createElement('input')
  bar.type = 'range'; bar.className = 'term-scrollbar'; bar.min = '0'; bar.step = '1'
  bar.setAttribute('aria-label', '終端機捲軸')
  bar.setAttribute('aria-orientation', 'vertical')
  pane.append(bar)
  let dragging = false
  function sync() {
    const buffer = term.buffer.active, alternate = buffer.type === 'alternate'
    bar.dataset.alternate = String(alternate)
    bar.max = String(buffer.baseY)
    bar.disabled = alternate || buffer.baseY === 0
    if (!dragging) bar.value = String(buffer.viewportY)
    bar.setAttribute('aria-valuetext', alternate ? '目前 CLI 使用全螢幕模式' : `第 ${buffer.viewportY + 1} 列`)
  }
  bar.addEventListener('input', () => {
    const value = Number(bar.value)
    if (term.buffer.active.type === 'normal') term.scrollToLine(value)
  })
  bar.addEventListener('pointerdown', () => { dragging = true })
  const release = () => { dragging = false; sync() }
  bar.addEventListener('change', release)
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
  const subscriptions = [term.onScroll(sync), term.onResize(sync), term.onWriteParsed(sync)]
  sync()
  return () => {
    for (const subscription of subscriptions) subscription.dispose()
    window.removeEventListener('pointerup', release)
    window.removeEventListener('pointercancel', release)
    bar.remove()
  }
}
