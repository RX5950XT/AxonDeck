/**
 * ```mermaid 碼塊 → 圖。mermaid 很大，第一次碰到才載，而且在隱藏 iframe 裡跑（理由見 mermaid-frame.js）。
 *
 * 畫出來的 SVG 用 `<img src="data:image/svg+xml…">` 放：圖片裡的 SVG 不跑腳本、不載外部資源，
 * 不必把字串塞進 DOM（維持零 innerHTML）。securityLevel strict＋不用 HTML 標籤，字都是 SVG text。
 */

/** @type {Promise<(source: string, theme: string) => Promise<string>> | null} */
let renderer = null
/** 同一段原始碼＋主題畫過就直接用（預覽每打一個字都會整份重畫） */
const cache = new Map()
const MAX_CACHE = 50
let queue = Promise.resolve()

function theme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark'
}

/**
 * srcdoc 的 iframe 跟這頁同源、沿用同一份 CSP，但有自己的全域（沒有 Monaco 的 `define`）。
 * 它的模組腳本跑完才會觸發 load，那時 `renderMermaid` 已經掛好。
 */
function frameRenderer() {
  renderer ||= new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    // mermaid 要量字寬，不能 display:none；移到畫面外
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0;visibility:hidden'
    const script = new URL('./mermaid-frame.js', import.meta.url).href.replace(/"/g, '%22')
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script type="module" src="${script}"></script>`
    frame.addEventListener('load', () => {
      const render = frame.contentWindow?.renderMermaid
      if (typeof render === 'function') resolve(render)
      else { frame.remove(); reject(new Error('mermaid 載入失敗')) }
    }, { once: true })
    document.body.appendChild(frame)
  })
  renderer.catch(() => { renderer = null })
  return renderer
}

/**
 * @param {string} source
 * @returns {Promise<{ url: string, width: number }>} data URL 與圖本身的寬度（0＝不知道）
 */
function draw(source) {
  const wanted = theme()
  const key = `${wanted}\n${source}`
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  // mermaid.render 同時跑好幾個會互相踩（共用暫存節點），排隊
  const job = queue.then(async () => {
    const svg = await (await frameRenderer())(source, wanted)
    // mermaid 的 SVG 是 width="100%"＋max-width：當成圖片會被拉滿整欄。取它自己的寬度，太寬再由 CSS 縮
    const width = Number(/max-width:\s*([\d.]+)px/.exec(svg)?.[1]) || 0
    const drawn = { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width }
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
    cache.set(key, drawn)
    return drawn
  })
  queue = job.catch(() => {})
  return job
}

/** 畫面上的圖（切換深淺色時照新主題重畫）；預覽重畫後舊圖已不在頁面上，下次登記時順手清掉 */
const shown = new Set()
let watching = false

function placeImage(img, { url, width }) {
  img.setAttribute('src', url)
  img.style.width = width ? `${Math.ceil(width)}px` : ''
}

function watchTheme() {
  if (watching) return
  watching = true
  new MutationObserver(() => {
    for (const entry of shown) {
      if (!entry.img.isConnected) {
        shown.delete(entry)
        continue
      }
      // 重畫失敗就留著舊主題的圖，總比空掉好
      draw(entry.source).then((drawn) => placeImage(entry.img, drawn), () => {})
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

function remember(img, source) {
  for (const entry of shown) if (!entry.img.isConnected) shown.delete(entry)
  shown.add({ img, source })
  watchTheme()
}

/**
 * 碼塊外框裡補一張圖、原始碼收起來（標頭多一顆切換鈕）。畫不出來就維持原始碼並註明。
 * @param {HTMLElement} box `.md-code`
 * @param {HTMLElement} pre
 * @param {string} source
 */
export function mountMermaid(box, pre, source) {
  const head = box.querySelector('.md-code-head')
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'md-copy md-mermaid-toggle'
  toggle.textContent = '原始碼'
  toggle.hidden = true
  head?.insertBefore(toggle, head.lastChild)
  draw(source).then((drawn) => {
    const img = document.createElement('img')
    img.className = 'md-mermaid'
    img.setAttribute('alt', 'Mermaid 圖表')
    placeImage(img, drawn)
    box.insertBefore(img, pre)
    remember(img, source)
    pre.hidden = true
    toggle.hidden = false
    toggle.addEventListener('click', () => {
      const toCode = !img.hidden
      pre.hidden = !toCode
      img.hidden = toCode
      toggle.textContent = toCode ? '圖表' : '原始碼'
    })
  }, (error) => {
    const lang = box.querySelector('.md-code-lang')
    if (!lang) return
    lang.textContent = 'mermaid（畫不出來，顯示原文）'
    // mermaid 的錯誤只講語法哪一行出錯，不含路徑或內容以外的東西
    lang.title = String(error?.message || error).slice(0, 300)
  })
}
