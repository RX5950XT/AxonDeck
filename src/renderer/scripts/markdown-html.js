/**
 * Markdown 裡的內嵌 HTML（README 常見的 `<p align="center"><img …></p>`、`<details>`）。
 *
 * DOMParser 解出來的文件是 inert 的（不跑腳本、不載圖），這裡只**讀**它，
 * 再用 createElement 照白名單重建一份：標籤、屬性都要在表上，網址另外過關。
 * 全程仍然零 innerHTML。
 */

const SAFE_HREF = /^(?:https?:|mailto:)/i

/** 照原樣重建的標籤 */
const TAGS = new Set([
  'p', 'div', 'span', 'a', 'img', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark',
  'small', 'sub', 'sup', 'kbd', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'details', 'summary', 'center', 'figure', 'figcaption'
])

/** 連內容一起丟掉；其他不認得的標籤只拆殼、留內容 */
const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'form', 'input',
  'button', 'textarea', 'select', 'link', 'meta', 'title', 'head', 'source', 'video', 'audio', 'canvas'
])

const SIZE = /^\d{1,4}%?$/
const ALIGN = /^(?:left|right|center|justify)$/i

/**
 * @param {string} html
 * @returns {Document}
 */
function parse(html) {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
}

/**
 * 一個來源元素 → 白名單內的新元素（只抄允許的屬性）。不認得就回 null（由呼叫端拆殼）。
 * @param {Element} src
 * @param {(raw: string) => string} resolveImage 回空字串＝這張圖不准載
 * @returns {HTMLElement | null}
 */
export function cleanElement(src, resolveImage) {
  const tag = src.tagName.toLowerCase()
  if (!TAGS.has(tag)) return null
  if (tag === 'a') {
    const href = (src.getAttribute('href') || '').trim()
    if (!SAFE_HREF.test(href)) return document.createElement('span')
  }
  const out = document.createElement(tag === 'center' ? 'div' : tag)
  if (tag === 'center') out.style.textAlign = 'center'
  const align = src.getAttribute('align') || ''
  if (ALIGN.test(align)) {
    if (tag === 'img') out.style.float = /^(?:left|right)$/i.test(align) ? align.toLowerCase() : ''
    else out.style.textAlign = align.toLowerCase()
  }
  for (const name of ['title', 'alt']) {
    const value = src.getAttribute(name)
    if (value !== null) out.setAttribute(name, value)
  }
  if (tag === 'a') {
    out.className = 'md-link'
    out.setAttribute('href', src.getAttribute('href').trim())
    out.setAttribute('target', '_blank')
    out.setAttribute('rel', 'noopener noreferrer')
  } else if (tag === 'img') {
    const source = resolveImage(src.getAttribute('src') || '')
    if (!source) return null
    out.className = 'md-image'
    out.setAttribute('src', source)
    out.setAttribute('loading', 'lazy')
    out.setAttribute('decoding', 'async')
    out.setAttribute('referrerpolicy', 'no-referrer')
    for (const name of ['width', 'height']) {
      const value = (src.getAttribute(name) || '').trim()
      if (SIZE.test(value)) out.setAttribute(name, value)
    }
  } else if (tag === 'details' && src.hasAttribute('open')) {
    out.setAttribute('open', '')
  } else if (tag === 'ol' && /^\d{1,9}$/.test(src.getAttribute('start') || '')) {
    out.setAttribute('start', src.getAttribute('start'))
  } else if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const value = src.getAttribute(name) || ''
      if (/^\d{1,3}$/.test(value)) out.setAttribute(name, value)
    }
  }
  if (tag === 'table') out.className = 'md-table'
  else if (tag === 'details' || tag === 'kbd') out.className = `md-${tag}`
  return out
}

/**
 * @param {Node} src
 * @param {Node} parent
 * @param {(raw: string) => string} resolveImage
 */
function copyChildren(src, parent, resolveImage) {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === 3) {
      parent.appendChild(document.createTextNode(child.data))
      continue
    }
    if (child.nodeType !== 1) continue // 註解、處理指令
    const tag = /** @type {Element} */ (child).tagName.toLowerCase()
    if (DROP.has(tag)) continue
    const made = cleanElement(/** @type {Element} */ (child), resolveImage)
    // <img> 被擋時連殼都不要（沒有內容可留）；其他不認得的拆殼留內容
    if (!made && tag === 'img') continue
    copyChildren(child, made || parent, resolveImage)
    if (made) parent.appendChild(made)
  }
}

/**
 * 一段 HTML → 白名單 DOM
 * @param {string} html
 * @param {(raw: string) => string} resolveImage
 * @returns {DocumentFragment}
 */
export function sanitizeHtml(html, resolveImage) {
  const out = document.createDocumentFragment()
  copyChildren(parse(html).body, out, resolveImage)
  return out
}

/**
 * 只解一個開頭標籤的屬性（行內 `<kbd>`、`<img …>` 用），回白名單元素或 null
 * @param {string} openTag 例如 `<img src="a.png" width="20">`
 * @param {(raw: string) => string} resolveImage
 * @returns {HTMLElement | null}
 */
export function cleanTag(openTag, resolveImage) {
  const src = parse(openTag).body.firstElementChild
  return src ? cleanElement(src, resolveImage) : null
}
