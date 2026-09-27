/**
 * 檔案總管右側詳情：預覽＋詳細資訊。操作鈕在上方命令列。
 */

import { electronAPI } from './app.js'
import { previewKind } from './explorer-preview.js'

let detailSeq = 0
let sizeToken = ''
/** @type {HTMLElement | null} */
let sizeDd = null
/** @type {((n: number) => string) | null} */
let sizeFormat = null
/** @type {(() => void) | null} */
let unsubSize = null
/** @type {MutationObserver | null} */
let pageObserver = null

function explorerApi() {
  return (electronAPI && electronAPI.explorer) || null
}

function explorerPageActive() {
  const page = typeof document === 'undefined' ? null : document.getElementById('page-explorer')
  return !page || page.classList.contains('active')
}

function cancelSize() {
  const tok = sizeToken
  sizeToken = ''
  sizeDd = null
  sizeFormat = null
  const api = explorerApi()
  if (tok && api && typeof api.folderSizeCancel === 'function') {
    void api.folderSizeCancel(tok)
  }
}

function watchPageLeave() {
  if (pageObserver || typeof MutationObserver === 'undefined') return
  const page = document.getElementById('page-explorer')
  if (!page) return
  pageObserver = new MutationObserver(() => {
    if (!page.classList.contains('active')) cancelSize()
  })
  pageObserver.observe(page, { attributes: true, attributeFilter: ['class'] })
}

function prettyBytes(n, formatSize) {
  const bytes = Number(n) || 0
  if (bytes <= 0) return '0 B'
  return formatSize(bytes)
}

function sizeLabel(info, formatSize, done) {
  const files = Number(info && info.files) || 0
  const pretty = prettyBytes(info && info.bytes, formatSize)
  const count = `${files.toLocaleString('zh-TW')} 個檔案`
  if (!done) return (info && (info.bytes || info.files)) ? `計算中… ${pretty}` : '計算中…'
  if (info && info.incomplete) return `至少 ${pretty}（${count}）`
  return `${pretty}（${count}）`
}

function ensureSizeProgress() {
  const api = explorerApi()
  if (unsubSize || !api || typeof api.onFolderSizeProgress !== 'function') return
  unsubSize = api.onFolderSizeProgress((info) => {
    if (!info || info.done || info.token !== sizeToken || !sizeDd || !sizeFormat) return
    sizeDd.textContent = sizeLabel(info, sizeFormat, false)
  })
}

/**
 * @param {string} dirPath
 * @param {HTMLElement} dd
 * @param {number} seq
 * @param {(n: number) => string} formatSize
 */
async function fillFolderSize(dirPath, dd, seq, formatSize) {
  const api = explorerApi()
  if (!api || typeof api.folderSize !== 'function') {
    dd.textContent = '算不出來'
    return
  }
  if (!explorerPageActive()) return
  const token = `sz${seq}`
  sizeToken = token
  sizeDd = dd
  sizeFormat = formatSize
  ensureSizeProgress()
  watchPageLeave()
  try {
    const result = await api.folderSize(dirPath, token)
    if (seq !== detailSeq || token !== sizeToken || !explorerPageActive()) return
    if (!result || result.ok === false) {
      dd.textContent = '算不出來'
      return
    }
    const data = result.data || result
    if (data && data.cancelled) return
    dd.textContent = sizeLabel(data, formatSize, true)
  } catch {
    if (seq !== detailSeq) return
    dd.textContent = '算不出來'
  }
}

/**
 * @param {{
 *   host: HTMLElement,
 *   items: object[],
 *   inRecycle: boolean,
 *   inspect: (path: string) => Promise<object>,
 *   mediaUrl?: (path: string) => Promise<string>,
 *   details?: (path: string) => Promise<{ title: string, facts: string[][] }[]>,
 *   formatSize: (n: number) => string,
 *   formatTime: (n: number) => string
 * }} opts
 */
export async function paintDetail(opts) {
  const seq = ++detailSeq
  cancelSize()
  watchPageLeave()
  const host = opts.host
  if (!host) return
  releaseMedia()
  host.replaceChildren()
  const items = opts.items || []
  if (!items.length) {
    const hint = document.createElement('p')
    hint.className = 'setting-hint'
    hint.textContent = '選一個項目看詳情。'
    host.appendChild(hint)
    return
  }
  if (items.length > 1) {
    const title = document.createElement('h2')
    title.className = 'ex-detail-name'
    title.textContent = `已選 ${items.length} 項`
    host.appendChild(title)
    const total = items.reduce((sum, item) => sum + (item.dir ? 0 : Number(item.size) || 0), 0)
    const dl = document.createElement('dl')
    addFact(dl, '數量', `${items.length}`)
    addFact(dl, '大小', opts.formatSize(total))
    host.appendChild(dl)
    return
  }
  const item = items[0]
  const title = document.createElement('h2')
  title.className = 'ex-detail-name'
  title.textContent = item.name
  host.appendChild(title)

  let info = null
  if (!opts.inRecycle) {
    try {
      info = await opts.inspect(item.path)
    } catch {
      info = null
    }
  }
  if (seq !== detailSeq) return
  const box = previewEl(item, info, opts.onPreviewClick)
  host.appendChild(box)
  if (typeof opts.mediaUrl === 'function') void fillMediaPreview(box, item, info, seq, opts.mediaUrl, opts.onPreviewClick)

  const dl = document.createElement('dl')
  addFact(dl, '類型', (info && info.type) || (item.dir ? '資料夾' : '檔案'))
  addFact(dl, '位置', item.path)
  // 手機的資料夾不算大小：要把整棵樹從手機一層層列回來，幾千張照片要好幾分鐘
  const folder = Boolean(item.dir) && !opts.inRecycle && !item.phone
  const sizeDdEl = addFact(dl, '大小', folder ? '計算中…' : (item.dir ? '資料夾' : opts.formatSize((info && info.size) || item.size)))
  addFact(dl, '建立', opts.formatTime((info && info.ctimeMs) || 0))
  addFact(dl, '修改', opts.formatTime((info && info.mtimeMs) || item.mtimeMs))
  addFact(dl, '存取', opts.formatTime((info && info.atimeMs) || 0))
  if (info && info.width && info.height) addFact(dl, '尺寸', `${info.width} × ${info.height}`)
  if (info && info.shortcutTarget) addFact(dl, '目標', info.shortcutTarget)
  if (info && info.linkTarget) addFact(dl, '連結', info.linkTarget)
  host.appendChild(dl)
  if (folder && explorerPageActive()) void fillFolderSize(item.path, sizeDdEl, seq, opts.formatSize)
  if (!item.dir && !opts.inRecycle && typeof opts.details === 'function') void fillDetails(item.path, host, dl, seq, opts.details)
}

/**
 * 依類型補的那幾段（影音串流、相片 EXIF、文件、程式版本、文字編碼）。影音要叫 ffmpeg，
 * 所以先畫基本資料、這裡晚一點補上；跟上面那份重複（例如尺寸）的就不再列一次。
 * @param {string} filePath
 * @param {HTMLElement} host
 * @param {HTMLElement} basic
 * @param {number} seq
 * @param {(path: string) => Promise<{ title: string, facts: string[][] }[]>} load
 */
async function fillDetails(filePath, host, basic, seq, load) {
  let groups = []
  try {
    groups = await load(filePath)
  } catch {
    return
  }
  if (seq !== detailSeq || !Array.isArray(groups)) return
  const shown = new Map([...basic.querySelectorAll('div')].map((d) => [d.firstChild?.textContent, d.lastChild?.textContent]))
  for (const group of groups) {
    const facts = (group.facts || []).filter(([key, value]) => shown.get(key) !== value)
    if (!facts.length) continue
    const title = document.createElement('h3')
    title.className = 'ex-detail-group'
    title.textContent = group.title
    const dl = document.createElement('dl')
    for (const [key, value] of facts) addFact(dl, key, String(value))
    host.append(title, dl)
  }
}

/** @type {HTMLVideoElement | null} 正在抓第一格的影片（不放進畫面） */
let grabbing = null

/**
 * 放掉抓畫面用的影片：`vi-media://` 的串流抓著檔案，不放的話剛選過的影片刪不掉、改不了名。
 */
function releaseMedia() {
  const video = grabbing
  grabbing = null
  if (!video) return
  video.removeAttribute('src')
  video.load()
}

/**
 * 影片的第一格畫到 canvas 上，畫完馬上把影片放掉（見 releaseMedia）。
 * @param {string} url
 * @param {(canvas: HTMLCanvasElement) => void} done
 */
function grabFrame(url, done) {
  releaseMedia()
  const video = document.createElement('video')
  grabbing = video
  video.muted = true
  video.preload = 'auto'
  video.addEventListener('loadeddata', () => {
    if (grabbing !== video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (ctx && canvas.width && canvas.height) {
      ctx.drawImage(video, 0, 0)
      done(canvas)
    }
    releaseMedia()
  }, { once: true })
  // 解不開（瀏覽器不支援的編碼）就維持圖示，一樣要放掉
  video.addEventListener('error', () => { if (grabbing === video) releaseMedia() }, { once: true })
  // 跳到 0.1 秒，才不會停在很多片頭那一格全黑
  video.setAttribute('src', `${url}#t=0.1`)
}

/**
 * 小預覽換成真的畫面：超過 2MB 的照片（手機拍的幾乎都是）`inspect` 不給 data: URI，
 * 影片抓第一格。走 `vi-media://` 邊讀邊送；拿不到或解不開（HEIC、4:4:4 的 H.264）就維持原本的圖示。
 * 手機／壓縮檔裡的影片不做：要先整支複製到暫存。
 * @param {HTMLElement} box
 * @param {object} item
 * @param {object | null} info
 * @param {number} seq
 * @param {(path: string) => Promise<string>} load
 * @param {(() => void) | null | undefined} onClick
 */
async function fillMediaPreview(box, item, info, seq, load, onClick) {
  const kind = previewKind(item)
  const video = kind === 'video' && !item.phone && !(info && info.zip) && !/\.zip\\/i.test(item.path)
  if (!video && !(kind === 'image' && !(info && info.image))) return
  let url = ''
  try {
    url = await load(item.path)
  } catch {
    return
  }
  if (!url || seq !== detailSeq || !box.isConnected) return
  const show = (el) => {
    if (seq !== detailSeq || !box.isConnected) return
    el.classList.add('ex-detail-preview')
    if (typeof onClick === 'function') {
      el.title = '點一下看大圖'
      el.addEventListener('click', () => onClick())
    }
    box.replaceChildren(el)
  }
  if (video) {
    grabFrame(url, show)
    return
  }
  const img = document.createElement('img')
  img.alt = item.name
  img.addEventListener('load', () => show(img), { once: true })
  img.src = url
}

/**
 * @param {object} item
 * @param {object | null} info
 * @param {(() => void) | null} [onPreviewClick] 點小預覽要不要開大預覽（只有圖片會給）
 */
function previewEl(item, info, onPreviewClick) {
  const box = document.createElement('div')
  box.className = 'ex-detail-preview-box'
  if (info && info.image) {
    const img = document.createElement('img')
    img.className = 'ex-detail-preview'
    img.alt = item.name
    img.src = info.image
    if (typeof onPreviewClick === 'function') {
      img.title = '點一下看大圖'
      img.addEventListener('click', () => onPreviewClick())
    }
    box.appendChild(img)
    return box
  }
  if (info && info.text) {
    const pre = document.createElement('pre')
    pre.className = 'ex-detail-text'
    pre.textContent = info.text
    box.appendChild(pre)
    return box
  }
  const icon = document.createElement('div')
  icon.className = 'ex-detail-preview-icon'
  icon.textContent = item.dir ? '📁' : ((item.ext || '').toLowerCase() === 'lnk' ? '🔗' : '📄')
  box.appendChild(icon)
  const cap = document.createElement('p')
  cap.className = 'ex-detail-preview-cap'
  cap.textContent = (info && info.shortcutTarget) || item.name
  box.appendChild(cap)
  if (typeof onPreviewClick === 'function') {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'btn btn-secondary btn-sm ex-detail-preview-open'
    open.textContent = '開啟預覽'
    open.addEventListener('click', onPreviewClick)
    box.appendChild(open)
  }
  return box
}

function addFact(dl, key, value) {
  const wrap = document.createElement('div')
  const dt = document.createElement('dt')
  dt.textContent = key
  const dd = document.createElement('dd')
  dd.textContent = value || '—'
  wrap.append(dt, dd)
  dl.appendChild(wrap)
  return dd
}
