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
