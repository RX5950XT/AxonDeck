// 只讀可見列的 Windows 圖示；切目錄即丟掉等待中的舊列。
// 方格檢視一律問殼層縮圖（照片／影片／文件／資料夾預覽）；清單維持類型圖示。
// 殼層第一次常回 pending（影片／PDF 還在現生）：先畫暫時的圖，稍後再問，不把暫時的寫進快取。
const cache = new Map()
const visible = new WeakSet()
const inflight = new WeakSet()
const retryCount = new WeakMap()
// 每個清單（左欄、右欄）各一份 observer／重試計時：雙欄時兩欄輪流重畫，
// 共用一份的話後畫的那欄會把另一欄還沒載完的圖示整批丟掉，停在預設圖。
// 回來的結果用「pane 物件還是不是同一個」判斷過期，取代全域 generation。
/** @type {Map<HTMLElement, { readIcon: Function, observer: IntersectionObserver | null, timers: Set<ReturnType<typeof setTimeout>> }>} */
const panes = new Map()
/** @type {{ el: HTMLElement, host: HTMLElement }[]} */
let queue = []
let running = 0

const THUMB_SIZE = 96
/** 殼層給得出的最大邊長（`shell.js` 的 `thumbOf` 也夾在這） */
const THUMB_MAX = 256
const RETRY_MS = 400
const MAX_RETRY = 3

// 同一張折角文件底，靠顏色與符號辨認類型；SVG 在 20px 清單和 256px 方格都不會糊。
const FILE_TYPES = [
  ['pdf', 'pdf', '#cf354e', 'M11 20h10m-10 4h10m-10 4h7'],
  ['doc docx odt rtf pages', 'document', '#2864c5', 'M11 20h10m-10 4h10m-10 4h7'],
  ['xls xlsx ods csv tsv', 'table', '#237b58', 'M10 19h12v10H10Zm0 4h12m-8-4v10'],
  ['ppt pptx odp key', 'slides', '#bd5a24', 'M10 19h12v8H10Zm6 8v3m-4 0h8'],
  ['png jpg jpeg gif webp bmp ico svg avif heic tiff tif raw', 'image', '#9b4ab6', 'M9 19h14v10H9Zm1 8 4-4 4 4 2-2 3 3m-3-6h.1'],
  ['mp4 mkv avi mov webm m4v wmv mpg mpeg', 'video', '#824fc4', 'M13 19v10l9-5Z'],
  ['mp3 wav flac ogg m4a aac wma opus mid midi', 'audio', '#b23c88', 'M14 27V20l7-1v7m-7 1c0-3-5-3-5 0s5 3 5 0m7-1c0-3-5-3-5 0s5 3 5 0'],
  ['zip 7z rar tar gz bz2 xz zst cab iso', 'archive', '#94651d', 'M14 19h4m-4 3h4m-4 3h4m-4 3h4'],
  ['js mjs cjs ts tsx jsx py rs c cpp h cs java go rb php swift kt html htm css scss vue sh ps1 bat cmd sql', 'code', '#19758a', 'm11 20-4 4 4 4m10-8 4 4-4 4m-3-10-4 12'],
  ['json jsonl xml yml yaml toml ini cfg conf db sqlite sqlite3 parquet', 'data', '#197b74', 'M13 19h-2v3l-2 2 2 2v3h2m6-10h2v3l2 2-2 2v3h-2'],
  ['gguf onnx safetensors pt pth bin ckpt', 'model', '#6555bc', 'm16 18-6 3v6l6 3 6-3v-6Zm-6 3 6 3 6-3m-6 3v6'],
  ['ttf otf woff woff2', 'font', '#7f5b42', 'm10 29 6-11 6 11m-10-4h8'],
  ['exe msi msix appx dll com', 'app', '#4e698c', 'M10 19h12v10H10Zm0 3h12m-9-1v.1m3-.1v.1'],
  ['txt md markdown log tex rst', 'text', '#4b6b8e', 'M10 20h12m-12 4h12m-12 4h8']
]

export function paintDefaultFileIcon(el, entry) {
  if (entry.dir) {
    el.textContent = '📁'
    return
  }
  const ext = String(entry.ext || entry.name?.split('.').pop() || '').toLowerCase()
  const type = FILE_TYPES.find(([extensions]) => extensions.split(' ').includes(ext))
    || ['', 'file', '#66758a', 'M11 20h10m-10 4h10m-10 4h7']
  const [, kind, color, mark] = type
  // label 只取英數；未知副檔名也能辨認，但不讓檔名拼成 SVG 標籤。
  const label = /^[a-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : 'FILE'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40"><title>${label}</title>
    <path d="M5 1h15l9 9v26a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z" fill="#f8fafc" stroke="${color}" stroke-width="1.5"/>
    <path d="M20 1v9h9" fill="${color}" fill-opacity=".2" stroke="${color}" stroke-width="1.5"/>
    <rect x="0" y="16" width="32" height="15" rx="3" fill="${color}"/>
    <path d="${mark}" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="16" y="36" text-anchor="middle" fill="${color}" font-family="Segoe UI, sans-serif" font-size="5.5" font-weight="700">${label}</text></svg>`
  el.dataset.fallbackUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
  el.dataset.iconType = kind
  showIcon(el, { fallback: true })
}

/**
 * 這一格要多大的縮圖：跟著方格的圖示大小走（Ctrl+滾輪會改它）。
 * 不跟的話放大之後只是把 96px 那張拉開，照片全糊掉。
 *
 * 讀 `data-tile` 不讀 CSS 變數：`getComputedStyle` 在測試用的假 DOM 裡根本不存在，
 * 而且每一列都問一次 computed style 很貴。`explorer-page.js` 的 `applyTile` 兩邊都寫。
 * @param {HTMLElement} host
 */
function thumbSize(host) {
  const raw = Number.parseInt(host?.dataset?.tile ?? '', 10)
  if (!Number.isFinite(raw) || raw < 16) return THUMB_SIZE
  return Math.min(THUMB_MAX, raw)
}

/**
 * 快取鍵要帶尺寸：同一個檔案在不同大小是兩張圖，共用一個鍵的話縮放完還是舊的那張。
 */
function cacheKey(el, thumb, size) {
  return `${thumb ? `t${size || THUMB_SIZE}` : 'i'}:${el.dataset.iconKey || el.dataset.path}`
}

function wantThumb(host, el) {
  return host.classList.contains('is-grid') && Boolean(el.dataset.path)
}

function loadIcon(el, host, readIcon, size) {
  const fn = window.electronAPI && window.electronAPI.explorer && window.electronAPI.explorer.fileIcon
  if (wantThumb(host, el) && typeof fn === 'function') {
    return fn(el.dataset.path, { thumb: true, size: size || thumbSize(host) })
  }
  return readIcon(el.dataset.path)
}

function dropPane(host) {
  const pane = panes.get(host)
  if (!pane) return
  pane.observer?.disconnect()
  for (const id of pane.timers) clearTimeout(id)
  panes.delete(host)
  queue = queue.filter((item) => item.host !== host)
}

export function clearFileIconWork() {
  for (const host of [...panes.keys()]) dropPane(host)
}

function enqueue(el, host) {
  if (cache.has(cacheKey(el, wantThumb(host, el), thumbSize(host)))) return
  if (inflight.has(el)) return
  if (queue.some((item) => item.el === el)) return
  queue.push({ el, host })
}

function scheduleRetry(el, host, pane, attempt) {
  const delay = RETRY_MS * (2 ** (attempt - 1))
  const id = setTimeout(() => {
    pane.timers.delete(id)
    if (panes.get(host) !== pane) return
    if (!el.isConnected || !visible.has(el)) return
    enqueue(el, host)
    pump()
  }, delay)
  pane.timers.add(id)
}

function applyThumb(el, host, pane, result, thumb, size) {
  if (!result?.ok || (!result.data?.folder && !result.data?.fallback && !/^data:image\/png;base64,/.test(result.data?.url))) return
  if (result.data.pending === true) {
    if (el.isConnected) showIcon(el, result.data)
    const attempt = (retryCount.get(el) || 0) + 1
    retryCount.set(el, attempt)
    if (attempt <= MAX_RETRY) scheduleRetry(el, host, pane, attempt)
    else pane.observer?.unobserve(el)
    return
  }
  retryCount.delete(el)
  pane.observer?.unobserve(el)
  cache.set(cacheKey(el, thumb, size), result.data)
  if (cache.size > 256) cache.delete(cache.keys().next().value)
  if (el.isConnected) showIcon(el, result.data)
}

export function paintFileIcons(host, readIcon) {
  dropPane(host)
  const pane = { readIcon, observer: null, timers: new Set() }
  panes.set(host, pane)
  pane.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visible.add(entry.target)
        enqueue(entry.target, host)
      } else {
        visible.delete(entry.target)
      }
    }
    pump()
  }, { root: host })
  for (const el of host.querySelectorAll('.ex-row-icon[data-path]')) {
    retryCount.delete(el)
    const cached = cache.get(cacheKey(el, wantThumb(host, el), thumbSize(host)))
    if (cached) showIcon(el, cached)
    else pane.observer.observe(el)
  }
}

function pump() {
  while (running < 4 && queue.length) {
    const { el, host } = queue.shift()
    const pane = panes.get(host)
    if (!pane || !el.isConnected || inflight.has(el)) continue
    if (cache.has(cacheKey(el, wantThumb(host, el), thumbSize(host)))) continue
    running++
    inflight.add(el)
    const thumb = wantThumb(host, el)
    // 要哪個尺寸在**發問當下**就定住：回來時使用者可能已經又滾了一格，
    // 拿新的尺寸當快取鍵會把小圖存成大圖那一格。
    const size = thumbSize(host)
    void loadIcon(el, host, pane.readIcon, size).then((result) => {
      if (panes.get(host) !== pane) return
      applyThumb(el, host, pane, result, thumb, size)
    }).catch(() => {
      // 檔案可能剛被刪除，保留原本的類型圖示。
    }).finally(() => {
      inflight.delete(el)
      running--
      pump()
    })
  }
}

function folderContents(data) {
  if (!data.previews?.length) return []
  const cards = data.previews.slice(0, 2).map(entry => {
    const card = document.createElement('span')
    card.className = 'ex-folder-preview'
    paintDefaultFileIcon(card, entry)
    showIcon(card, entry)
    return card
  })
  const front = document.createElement('img')
  front.className = 'ex-folder-front'
  front.src = data.url
  front.alt = ''
  front.draggable = false
  return [...cards, front]
}

function showIcon(el, data) {
  if (data.folder) {
    el.textContent = '📁'
    return
  }
  const src = data.fallback ? el.dataset.fallbackUrl : data.url
  const overlay = /^data:image\/png;base64,/.test(data.overlay || '') ? data.overlay : ''
  const previewKey = JSON.stringify(data.previews || [])
  const badgeSrc = el.children?.[el.children.length - 1]?.className === 'ex-row-overlay'
    ? el.children[el.children.length - 1].src : ''
  // pending 重試常回同一張圖，保留已解碼的 img，避免反覆重畫 SVG。
  if (el.firstElementChild?.src === src && badgeSrc === overlay && (el.dataset.previewKey || '[]') === previewKey) return
  el.dataset.previewKey = previewKey
  const image = document.createElement('img')
  image.src = src
  image.alt = ''
  image.draggable = false
  if (!data.fallback && el.dataset.fallbackUrl) {
    image.onerror = () => { image.onerror = null; image.src = el.dataset.fallbackUrl }
  }
  if (!overlay) {
    el.replaceChildren(image, ...folderContents(data))
    return
  }
  // 縮圖不帶同步標記（Google Drive 綠勾），殼層另給一張 overlay 畫布蓋在左下
  const badge = document.createElement('img')
  badge.className = 'ex-row-overlay'
  badge.src = overlay
  badge.alt = ''
  badge.draggable = false
  el.replaceChildren(image, ...folderContents(data), badge)
}
