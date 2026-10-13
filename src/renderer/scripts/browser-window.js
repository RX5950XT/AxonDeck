/**
 * 彈出成獨立視窗的瀏覽器分頁：這一頁只有工具列，網頁是 main 疊在下面的 WebContentsView
 * （main/browser-window.js）。按鈕與擴充功能都經 preload 的 browserWindowAPI，只能動自己這扇窗的網頁。
 */

import { createBrowserActions } from './browser-actions.js'

const api = /** @type {any} */ (window).browserWindowAPI
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'

/** @param {string} id */
const $ = (id) => /** @type {any} */ (document.getElementById(id))

/** 只收 http(s)；沒打協定就補 https:// */
function safeUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const u = new URL(/^[a-z][\w+.-]*:/i.test(text) ? text : `https://${text}`)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

$('bwUrl').value = safeUrl(params.get('url'))
const refreshActions = createBrowserActions($('bwActions'), () => 0, api)

api.onState((state) => {
  if (document.activeElement !== $('bwUrl') && state.url) $('bwUrl').value = state.url
  $('bwBack').disabled = !state.canGoBack
  $('bwFwd').disabled = !state.canGoForward
  $('bwReload').textContent = state.loading ? '✕' : '⟳'
  $('bwReload').title = state.loading ? '停止載入' : '重新整理 (F5)'
  if (!state.loading) refreshActions() // 徽章跟著網頁走
})

$('bwBack').addEventListener('click', () => api.navigate('back'))
$('bwFwd').addEventListener('click', () => api.navigate('forward'))
$('bwReload').addEventListener('click', () => api.navigate('reload'))
$('bwExt').addEventListener('click', (event) => {
  const { x, y, width, height } = event.currentTarget.getBoundingClientRect()
  void api.extensionsMenu(0, { x, y, width, height })
})
$('bwUrl').addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return
  event.preventDefault()
  const href = safeUrl($('bwUrl').value)
  if (href) void api.navigate('go', href)
})
