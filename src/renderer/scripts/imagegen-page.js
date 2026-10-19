/**
 * AxonDeck — 生成圖片影像頁
 *
 * 內嵌 Miroxen 工作台（iframe，`?embed=1`）。引擎與模型在 Local SI 裝；這頁只管：
 * 缺什麼就帶過去裝、在跑就顯示工作台、配色跟著 App 主題（網址帶初始值，之後用 postMessage 換）。
 * 切頁回來網址沒變就不重載 iframe，畫到一半的表單與佇列都留著。
 * 重新啟動／停止／輸出資料夾是工作台裡的按鈕，按了 postMessage `miroxen:host` 回來給這頁執行。
 */

import { electronAPI, showToast, cleanIpcError, openInFilesPage, switchPage } from './app.js'

/** App 主題代幣 → Miroxen 的顏色名稱 */
const COLOR_MAP = [
  ['bg', '--app-bg'], ['panel', '--surface-solid'], ['ink', '--text-primary'], ['ink-muted', '--text-secondary'],
  ['line', '--glass-border-strong'], ['accent', '--accent-primary'], ['accent-ink', '--select-option-selected-text'],
  ['danger', '--danger'], ['warn', '--warning'], ['ok', '--success']
]

let bound = false
let refreshing = null
let updateNoticed = false
/** @type {Record<string, any> | null} */
let latest = null

/** @param {string} id */
const $ = (id) => document.getElementById(id)

async function call(promise) {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error?.message || '圖片影像引擎操作失敗')
  return result.data
}

function themeColors() {
  const css = getComputedStyle(document.documentElement)
  const colors = Object.fromEntries(COLOR_MAP.map(([name, token]) => [name, css.getPropertyValue(token).trim()]).filter(([, v]) => v))
  // 卡片底色比面板淺一階／兩階，從面板色往文字色混一點
  if (colors.panel && colors.ink) {
    colors.surface = `color-mix(in srgb, ${colors.panel} 94%, ${colors.ink})`
    colors['surface-2'] = `color-mix(in srgb, ${colors.panel} 87%, ${colors.ink})`
  }
  return colors
}

const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')

/** @param {string} url main 給的 `http://127.0.0.1:<port>/?embed=1#key=…` */
function frameUrl(url) {
  const [base, hash] = url.split('#')
  const query = new URLSearchParams({ theme: currentTheme() })
  for (const [name, value] of Object.entries(themeColors())) query.set(`c-${name}`, value)
  return `${base}&${query}#${hash}`
}

function postTheme() {
  const frame = /** @type {HTMLIFrameElement} */ ($('imagegenFrame'))
  if (!frame?.dataset.base || !frame.contentWindow) return
  frame.contentWindow.postMessage({ type: 'miroxen:theme', theme: currentTheme(), colors: themeColors() },
    new URL(frame.dataset.base).origin)
}

/** @param {string} action */
async function hostAction(action) {
  if (action === 'stop') return stopEngine()
  if (action === 'restart') {
    if (latest?.running) await stopEngine()
    return refreshImagegenPage()
  }
  if (action === 'output') {
    try { await openInFilesPage(await call(electronAPI.miroxen.openOutput())) }
    catch (error) { showToast(cleanIpcError(error), 'error') }
  }
}

function bindOnce() {
  if (bound) return
  bound = true
  window.addEventListener('message', (event) => {
    const frame = /** @type {HTMLIFrameElement} */ ($('imagegenFrame'))
    if (!frame?.dataset.base || event.source !== frame.contentWindow || event.origin !== new URL(frame.dataset.base).origin) return
    if (event.data?.type === 'miroxen:host' && typeof event.data.action === 'string') void hostAction(event.data.action)
  })
  new MutationObserver(postTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  // 更新引擎前 main 會先停服務：iframe 接的是已關掉的那顆，先收起來
  electronAPI.models.onProgress((payload) => {
    if (payload?.key !== 'miroxenruntime') return
    resetFrame()
    showEmpty({ title: 'Miroxen 引擎更新中…', text: '裝好後按「重新連線」。',
      action: '重新連線', onAction: () => void refreshImagegenPage() })
  })
}

function resetFrame() {
  const frame = /** @type {HTMLIFrameElement} */ ($('imagegenFrame'))
  frame.removeAttribute('src')
  delete frame.dataset.base
  latest = latest && { ...latest, running: false }
}

/** @param {{ title: string, text: string, action?: string, onAction?: () => void } | null} state */
function showEmpty(state) {
  const empty = $('imagegenEmpty')
  const frame = $('imagegenFrame')
  if (!empty || !frame) return
  empty.hidden = !state
  frame.hidden = !!state
  if (!state) return
  $('imagegenEmptyTitle').textContent = state.title
  $('imagegenEmptyText').textContent = state.text
  const button = /** @type {HTMLButtonElement} */ ($('imagegenEmptyAction'))
  button.hidden = !state.action
  button.textContent = state.action || ''
  button.onclick = state.onAction || null
}

function emptyStateFor(status) {
  if (!status.gpuReady) {
    return { title: '需要 NVIDIA 顯示卡', text: status.hasNvidia
      ? 'Miroxen 需要 CUDA 13，請把 NVIDIA 驅動更新到 580 以上再回來。'
      : '這台沒有偵測到 NVIDIA 顯示卡；Miroxen 只支援 RTX 30／40／50 系列。' }
  }
  if (!status.installed) {
    return { title: '還沒安裝圖片影像引擎', text: '到 Local SI 的「執行環境」安裝 Miroxen 引擎（約 700 MB），之後 Miroxen 發新版可以在這裡直接更新。',
      action: '前往執行環境', onAction: () => switchPage('hfmodels', 'runtime') }
  }
  if (!status.models.some((model) => model.downloaded)) {
    return { title: '還沒有生成模型', text: '到 Local SI 的「推薦」下載圖片（Qwen-Image-2.1）或影音（MiniMax-H3）模型。圖片建議先下 Turbo。',
      action: '前往推薦', onAction: () => switchPage('hfmodels', 'recommend') }
  }
  return null
}

/** 進頁就呼叫：缺東西顯示引導，否則確保服務在跑並接上 iframe */
export function refreshImagegenPage() {
  bindOnce()
  refreshing ||= refresh().finally(() => { refreshing = null })
  return refreshing
}

async function refresh() {
  // 新開的頁面兩塊都藏著，查狀態那幾秒不要整片空白
  if (!$('imagegenFrame')?.dataset.base) showEmpty({ title: '連線中…', text: '' })
  try {
    latest = await call(electronAPI.miroxen.status({ checkUpdate: true }))
    const empty = emptyStateFor(latest)
    if (empty) return showEmpty(empty)
    if (latest.update && !updateNoticed) {
      updateNoticed = true
      showToast(`Miroxen 有新版 ${latest.latest}，可到 Local SI 的執行環境更新`, 'info')
    }
    if (!latest.running) showEmpty({ title: '啟動引擎中…', text: '第一次約 10 秒。' })
    const { url } = await call(electronAPI.miroxen.start())
    const frame = /** @type {HTMLIFrameElement} */ ($('imagegenFrame'))
    if (frame.dataset.base !== url) {
      frame.dataset.base = url
      frame.src = frameUrl(url)
    }
    showEmpty(null)
    latest = { ...latest, running: true }
  } catch (error) {
    showEmpty({ title: '引擎沒有啟動', text: cleanIpcError(error), action: '再試一次', onAction: () => void refreshImagegenPage() })
  }
}

async function stopEngine() {
  try { await call(electronAPI.miroxen.stop()) }
  catch (error) { showToast(cleanIpcError(error), 'error') }
  resetFrame()
  showEmpty({ title: '引擎已停止', text: '顯存已釋放。需要時再啟動，模型會在第一次生成時載入。',
    action: '啟動', onAction: () => void refreshImagegenPage() })
}
