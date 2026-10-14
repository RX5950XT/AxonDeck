/**
 * 聊天頁右側的瀏覽器：在對話或網頁版 AI 裡點的連結開在這裡，不切到專案。
 * partition 跟專案瀏覽器同一個（`persist:wsbrowser`），登入狀態與擴充功能共用；
 * 右鍵、F5、擴充功能由 main 依 partition 自動掛上。關掉就拆掉 webview 省記憶體。
 */

import { initResizer } from './pane-resize.js'

let bound = false

/** @param {string} id */
const $ = (id) => document.getElementById(id)

function frame() {
  return /** @type {Electron.WebviewTag | null} */ ($('chatBrowserFrame')?.querySelector('webview') || null)
}

function bind() {
  if (bound) return
  bound = true
  initResizer({
    handleId: 'chatBrowserResizer',
    panelSelector: '.chat-browser',
    cssVar: '--chat-browser-w',
    storageKey: 'chatBrowserWidth',
    invert: true,
    min: 320,
    max: 1400
  })
  $('chatBrowserBackBtn')?.addEventListener('click', () => {
    const guest = frame()
    if (guest?.canGoBack()) guest.goBack()
  })
  $('chatBrowserReloadBtn')?.addEventListener('click', () => frame()?.reload())
  $('chatBrowserCloseBtn')?.addEventListener('click', closeChatBrowser)
}

/** @param {string} url 只收 http(s) */
export function openChatBrowser(url) {
  let href = ''
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href
  } catch { /* 壞網址不開 */ }
  if (!href) return
  bind()
  let guest = frame()
  if (guest) guest.src = href
  else {
    guest = document.createElement('webview')
    // partition 要在插入前設好，建了就不能改
    guest.setAttribute('partition', 'persist:wsbrowser')
    guest.setAttribute('allowpopups', '')
    guest.setAttribute('src', href)
    const showUrl = (event) => {
      const text = $('chatBrowserUrl')
      if (text) text.textContent = text.title = String(/** @type {any} */ (event).url || '')
    }
    guest.addEventListener('did-navigate', showUrl)
    guest.addEventListener('did-navigate-in-page', showUrl)
    $('chatBrowserFrame')?.appendChild(guest)
  }
  const text = $('chatBrowserUrl')
  if (text) text.textContent = text.title = href
  for (const el of document.querySelectorAll('.chat-browser-part')) /** @type {HTMLElement} */ (el).hidden = false
}

export function closeChatBrowser() {
  frame()?.remove()
  for (const el of document.querySelectorAll('.chat-browser-part')) /** @type {HTMLElement} */ (el).hidden = true
}
