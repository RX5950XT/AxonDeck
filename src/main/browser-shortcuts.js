'use strict'
/**
 * 工作區／Browser 內建瀏覽器的快捷鍵（焦點在 <webview> 裡時 main 透過 before-input-event 接住）。
 * - 網頁自己就能處理的（上一頁、下一頁、重整、開發人員工具、縮放）直接在 guest WebContents 執行；
 * - 要動到外殼 UI 的（網址列、頁內尋找、開關分頁、切分頁、指令面板）送回宿主頁面處理，必要時把焦點拉回宿主。
 */

/** @param {Electron.Input} input */
function matchBrowserShortcut(input) {
  if (!input || input.type !== 'keyDown') return null
  // AltGr 會同時帶 control + alt，兩者互斥避免誤觸
  const ctrl = Boolean(input.control) && !input.alt && !input.meta
  const alt = Boolean(input.alt) && !input.control && !input.meta
  const plain = !input.control && !input.alt && !input.meta
  const shift = Boolean(input.shift)
  const key = String(input.key || '')
  const lower = key.toLowerCase()
  const code = String(input.code || '')

  if (ctrl && (code === 'Equal' || code === 'NumpadAdd' || key === '+' || key === '=')) return { scope: 'page', action: 'zoom-in' }
  if (ctrl && !shift && (code === 'Minus' || code === 'NumpadSubtract' || key === '-')) return { scope: 'page', action: 'zoom-out' }
  if (input.isAutoRepeat) return null

  if (ctrl && !shift && (code === 'Digit0' || code === 'Numpad0')) return { scope: 'page', action: 'zoom-reset' }
  if (key === 'F5' && !alt && !input.meta) return { scope: 'page', action: (shift || input.control) ? 'reload-hard' : 'reload' }
  if (ctrl && (code === 'KeyR' || lower === 'r')) return { scope: 'page', action: shift ? 'reload-hard' : 'reload' }
  if (alt && !shift && key === 'ArrowLeft') return { scope: 'page', action: 'back' }
  if (alt && !shift && key === 'ArrowRight') return { scope: 'page', action: 'forward' }
  if ((plain && !shift && key === 'F12') || (ctrl && shift && (code === 'KeyI' || lower === 'i'))) return { scope: 'page', action: 'devtools' }

  if ((ctrl && !shift && (code === 'KeyL' || lower === 'l')) || (alt && !shift && (code === 'KeyD' || lower === 'd'))) {
    return { scope: 'host', action: 'focus-url', focusHost: true }
  }
  if (ctrl && !shift && (code === 'KeyF' || lower === 'f')) return { scope: 'host', action: 'find', focusHost: true }
  if (plain && key === 'F3') return { scope: 'host', action: shift ? 'find-prev' : 'find-next' }
  if (ctrl && !shift && (code === 'KeyT' || lower === 't')) return { scope: 'host', action: 'new-tab', focusHost: true }
  if (ctrl && shift && (code === 'KeyT' || lower === 't')) return { scope: 'host', action: 'new-terminal', focusHost: true }
  if (ctrl && (code === 'KeyW' || lower === 'w')) return { scope: 'host', action: 'close-tab' }
  if (ctrl && shift && (code === 'KeyP' || lower === 'p')) return { scope: 'host', action: 'command-palette', focusHost: true }
  if (ctrl && (key === 'Tab' || code === 'Tab')) return { scope: 'host', action: shift ? 'prev-tab' : 'next-tab' }
  if (ctrl && !shift && key === 'PageDown') return { scope: 'host', action: 'next-tab' }
  if (ctrl && !shift && key === 'PageUp') return { scope: 'host', action: 'prev-tab' }
  if (ctrl && !shift && (/^Digit([1-9])$/.test(code) || /^Numpad([1-9])$/.test(code))) {
    return { scope: 'host', action: `tab-${code.slice(-1)}` }
  }
  return null
}

/** @param {Electron.WebContents} contents @param {string} action */
function runPageShortcut(contents, action) {
  if (!contents || contents.isDestroyed()) return
  const nav = contents.navigationHistory
  if (action === 'reload') contents.reload()
  else if (action === 'reload-hard') contents.reloadIgnoringCache()
  else if (action === 'back' && nav.canGoBack()) nav.goBack()
  else if (action === 'forward' && nav.canGoForward()) nav.goForward()
  else if (action === 'devtools') {
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools()
  } else if (action === 'zoom-in') {
    contents.setZoomLevel(Math.min(3, Math.round((contents.getZoomLevel() + 0.5) * 2) / 2))
  } else if (action === 'zoom-out') {
    contents.setZoomLevel(Math.max(-3, Math.round((contents.getZoomLevel() - 0.5) * 2) / 2))
  } else if (action === 'zoom-reset') {
    contents.setZoomLevel(0)
  }
}

/**
 * @param {Electron.WebContents} contents
 * @param {{ shouldSkip?: (input: Electron.Input, url: string) => boolean,
 *   onHostAction?: (matched: { scope: string, action: string, focusHost?: boolean }, contents: Electron.WebContents) => void }} [opts]
 */
function attachBrowserShortcuts(contents, { shouldSkip, onHostAction } = {}) {
  contents.on('before-input-event', (event, input) => {
    if (shouldSkip?.(input, contents.getURL())) return
    const matched = matchBrowserShortcut(input)
    if (!matched) return
    event.preventDefault()
    if (matched.scope === 'page') runPageShortcut(contents, matched.action)
    else onHostAction?.(matched, contents)
  })
}

module.exports = { matchBrowserShortcut, runPageShortcut, attachBrowserShortcuts }
