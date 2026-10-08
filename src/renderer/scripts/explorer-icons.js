// 只讀可見列的 Windows 圖示；切目錄即丟掉等待中的舊列。
// 方格檢視一律問殼層縮圖（照片／影片／文件／資料夾預覽）；清單維持類型圖示。
// 殼層第一次常回 pending（影片／PDF 還在現生）：先畫暫時的圖，稍後再問，不把暫時的寫進快取。
const cache = new Map()
const visible = new WeakSet()
// 快取鍵 → 還在等它回來的那幾欄。`paintList` 整批重建 DOM 時請求不重發，
// 同一張圖同時只問一次，回來再補畫各欄現行那一列。
/** @type {Map<string, Set<HTMLElement>>} */
const inflight = new Map()
// 快取鍵 → { attempt, at }。重試預算跟著圖走不跟著列走，重畫不能歸零，
// 否則 pending 的影片／PDF 每次重畫都重拿三次預算，永遠停不下來。
/** @type {Map<string, { attempt: number, at: number }>} */
const retryState = new Map()
// 快取鍵 → { id, hosts }。重試計時不綁 pane：重畫只換列不換鍵，計時照跑；
// 離開檔案頁才整批清（`clearFileIconWork`）。
/** @type {Map<string, { id: ReturnType<typeof setTimeout>, hosts: Set<HTMLElement> }>} */
const retryTimers = new Map()
// 每個清單（左欄、右欄）各一份 observer：雙欄時兩欄輪流重畫，
// 共用一份的話後畫的那欄會把另一欄還沒載完的圖示整批丟掉，停在預設圖。
/** @type {Map<HTMLElement, { readIcon: Function, observer: IntersectionObserver | null }>} */
const panes = new Map()
/** @type {{ host: HTMLElement, key: string, size: number }[]} */
let queue = []
let running = 0

const THUMB_SIZE = 96
/** 殼層給得出的最大邊長（`shell.js` 的 `thumbOf` 也夾在這） */
const THUMB_MAX = 256
const RETRY_MS = 400
const MAX_RETRY = 3
// 預算用完後多久才給新的（殼層現生中的縮圖晚一點再問，不要整批重問）。
const RETRY_COOLDOWN_MS = 30_000

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
  if (!pane) {
    queue = queue.filter((item) => item.host !== host)
    return
  }
  pane.observer?.disconnect()
  panes.delete(host)
  queue = queue.filter((item) => item.host !== host)
}

export function clearFileIconWork() {
  for (const host of [...panes.keys()]) dropPane(host)
  for (const [, entry] of retryTimers) clearTimeout(entry.id)
  retryTimers.clear()
  queue = []
}

/**
 * 這張圖還能不能再問（重試預算用完就停，冷卻過了才給新的）。
 * @param {string} key
 */
function budgetOk(key) {
  const state = retryState.get(key)
  if (!state || state.attempt <= MAX_RETRY) return true
  if (Date.now() - state.at >= RETRY_COOLDOWN_MS) {
    retryState.delete(key)
    return true
  }
  return false
}

/**
 * 這一欄現在看得到的那一列（重畫後是新的節點，用鍵找不拿舊引用）。
 * @param {HTMLElement} host
 * @param {string} key
 */
function findCurrentIcon(host, key) {
  let list = []
  try {
    list = host.querySelectorAll('.ex-row-icon[data-path]') || []
  } catch {
    return null
  }
  for (const el of list) {
    try {
      if (cacheKey(el, wantThumb(host, el), thumbSize(host)) === key) return el
    } catch {
      // 這一列的 dataset 壞掉就跳過
    }
  }
  return null
}

function unobserveKey(host, key) {
  const pane = panes.get(host)
  if (!pane) return
  const el = findCurrentIcon(host, key)
  if (el) pane.observer?.unobserve(el)
}

function paintCurrent(hosts, key, data) {
  for (const host of hosts) {
    if (!panes.get(host)) continue
    const el = findCurrentIcon(host, key)
    if (el && el.isConnected) showIcon(el, data)
  }
}

function cancelRetryTimer(key) {
  const entry = retryTimers.get(key)
  if (!entry) return
  clearTimeout(entry.id)
  retryTimers.delete(key)
}

function scheduleRetry(key, hosts, attempt) {
  const live = [...hosts].filter((host) => panes.get(host))
  if (!live.length) return
  const prev = retryTimers.get(key)
  if (prev) {
    for (const host of live) prev.hosts.add(host)
    return
  }
  const delay = RETRY_MS * (2 ** (attempt - 1))
  const entry = { id: 0, hosts: new Set(live) }
  entry.id = setTimeout(() => {
    retryTimers.delete(key)
    for (const host of entry.hosts) {
      if (!panes.get(host)) continue
      const el = findCurrentIcon(host, key)
      if (!el || !el.isConnected || !visible.has(el)) continue
      if (cache.has(key)) continue
      enqueue(el, host)
    }
    pump()
  }, delay)
  retryTimers.set(key, entry)
}

function enqueue(el, host) {
  if (!el || !host) return
  const key = cacheKey(el, wantThumb(host, el), thumbSize(host))
  if (cache.has(key) || !budgetOk(key)) return
  const flying = inflight.get(key)
  if (flying) {
    flying.add(host)
    return
  }
  if (queue.some((item) => item.key === key && item.host === host)) return
  // 要哪個尺寸在**發問當下**就定住：回來時使用者可能已經又滾了一格，
  // 拿新的尺寸當快取鍵會把小圖存成大圖那一格。
  queue.push({ host, key, size: thumbSize(host) })
}

export function paintFileIcons(host, readIcon) {
  dropPane(host)
  const pane = { readIcon, observer: null }
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
    const key = cacheKey(el, wantThumb(host, el), thumbSize(host))
    const cached = cache.get(key)
    if (cached) {
      showIcon(el, cached)
      continue
    }
    if (!budgetOk(key)) continue
    const flying = inflight.get(key)
    if (flying) {
      flying.add(host)
      visible.add(el)
      continue
    }
    pane.observer.observe(el)
  }
}

function pump() {
  while (running < 4 && queue.length) {
    const job = queue.shift()
    if (cache.has(job.key) || !budgetOk(job.key)) continue
    const flying = inflight.get(job.key)
    if (flying) {
      flying.add(job.host)
      continue
    }
    const pane = panes.get(job.host)
    if (!pane) continue
    const el = findCurrentIcon(job.host, job.key)
    if (!el || !el.isConnected) continue
    const hosts = new Set([job.host])
    inflight.set(job.key, hosts)
    running++
    void loadIcon(el, job.host, pane.readIcon, job.size).then((result) => {
      if (!result?.ok || (!result.data?.folder && !result.data?.fallback && !/^data:image\/png;base64,/.test(result.data?.url))) return
      if (result.data.pending === true) {
        paintCurrent(hosts, job.key, result.data)
        const attempt = (retryState.get(job.key)?.attempt || 0) + 1
        retryState.set(job.key, { attempt, at: Date.now() })
        if (retryState.size > 512) retryState.delete(retryState.keys().next().value)
        if (attempt <= MAX_RETRY) scheduleRetry(job.key, hosts, attempt)
        else {
          cancelRetryTimer(job.key)
          for (const host of hosts) unobserveKey(host, job.key)
        }
        return
      }
      retryState.delete(job.key)
      cancelRetryTimer(job.key)
      cache.set(job.key, result.data)
      if (cache.size > 256) cache.delete(cache.keys().next().value)
      paintCurrent(hosts, job.key, result.data)
    }).catch(() => {
      // 檔案可能剛被刪除，保留原本的類型圖示。
    }).finally(() => {
      inflight.delete(job.key)
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
