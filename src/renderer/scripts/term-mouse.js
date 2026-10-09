/**
 * 不攔截 CLI 開的滑鼠模式。xterm 收到追蹤後，點擊、拖曳與滾輪都交給 CLI；
 * Shift+拖曳仍是 xterm 自己的選取。Ctrl+滾輪回傳 false，外層用它改字級。
 *
 * @param {import('@xterm/xterm').Terminal} term
 */
export function blockMouseReporting(term, onCtrlWheel) {
  term.attachCustomWheelEventHandler(event => !event.ctrlKey)
  // 滑鼠模式開著時，xterm 會在 bubble 把滾輪吃掉。capture 先攔 Ctrl，字級才收得到。
  if (!term.element || typeof onCtrlWheel !== 'function') return
  term.element.addEventListener('wheel', event => {
    if (!event.ctrlKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    onCtrlWheel(event.deltaY)
  }, { capture: true, passive: false })
}
