/**
 * AxonDeck - 安全 Markdown 渲染器
 *
 * 只用 createElement / createTextNode / textContent，**全程零 innerHTML**
 * → 任何模型輸出（含 <script>、onerror=）都只會變成文字節點，XSS 先天不可能。
 *
 * 區塊：圍欄碼塊（上色見 markdown-code.js）、標題（# 與底線式）、巢狀清單／待辦清單、
 *       引用與 GitHub 提示框（> [!NOTE]）、表格、分隔線、參考式連結定義、腳註、段落。
 * 行內：code、粗體、斜體、刪除線、連結（http(s)、mailto、#標題錨點）、參考式連結、自動連結、
 *       圖片、跳脫字元、腳註、:emoji:（markdown-emoji.js）。
 * ```mermaid 碼塊畫成圖（markdown-mermaid.js）。
 * 文件模式（`{ html: true }`，只給文件預覽）另外收：內嵌 HTML（白名單重建，markdown-html.js）、
 *   $…$／$$…$$／```math 數學（markdown-math.js）、縮排碼塊；段落裡的換行照 GitHub 當空白。
 * 載入較大的元件（上色、數學、emoji、mermaid）都是第一次用到才載。
 */

import { sanitizeHtml, cleanTag } from './markdown-html.js'
import { mountMermaid } from './markdown-mermaid.js'
import { highlightCode } from './markdown-code.js'
import { mountMath } from './markdown-math.js'
import { emojiFor, mountEmoji } from './markdown-emoji.js'
import {
  SAFE_PROTO, HAS_SCHEME, MAX_DEPTH, RE_FENCE, RE_HEADING, RE_SETEXT, RE_HR, RE_QUOTE, RE_BULLET,
  RE_ORDERED, RE_ITEM, RE_TASK, RE_ALERT, RE_TABLE_SEP, RE_LINK_DEF, RE_NOTE_DEF, RE_MATH_OPEN,
  RE_MATH_CLOSE, RE_HTML_START, ALERTS, INLINE_SRC
} from './markdown-syntax.js'

/** 文件模式（見檔頭）。renderMarkdown 是同步遞迴，最外層進出時設定／還原 */
let docMode = false
/** 這一份文件的參考式連結、腳註、標題錨點 */
let doc = newDoc()

function newDoc(openLink = null) {
  return { refs: new Map(), notes: new Map(), cited: [], slugs: new Map(), openLink }
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function el(tag, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/**
 * 純文字寫入。聊天裡每個換行都換行；文件模式照 GitHub：行尾 `\` 或兩個以上空白＝換行，
 * 其他換行當空白（README 常在 80 字處折行）。
 * @param {Node} parent
 * @param {string} text
 */
function appendText(parent, text) {
  const parts = text.split('\n')
  parts.forEach((part, idx) => {
    const last = idx === parts.length - 1
    const hard = docMode && !last && /(?:\\| {2,})$/.test(part)
    const shown = hard ? part.replace(/(?:\\| +)$/, '') : part
    if (shown) parent.appendChild(document.createTextNode(shown))
    if (!last) parent.appendChild(hard || !docMode ? el('br') : document.createTextNode(' '))
  })
}

/**
 * 行內語法 → DOM
 * @param {Node} parent
 * @param {string} text
 */
function renderInline(parent, text, imageBase = '') {
  const re = new RegExp(INLINE_SRC, 'g')
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    const ref = m[18] !== undefined ? lookupRef(m[0], m[18], m[19]) : undefined
    if (isLiteral(m, ref)) {
      // 這裡其實不是語法（沒定義的 `[x]`、`10:30:00`、聊天裡的 `<b>`）：第一個字當文字，從下一個字重新比對
      re.lastIndex = m.index + (m[0].startsWith('![') ? 2 : 1)
      continue
    }
    if (m.index > last) appendText(parent, text.slice(last, m.index))
    last = re.lastIndex
    appendToken(parent, m, ref, imageBase)
  }
  if (last < text.length) appendText(parent, text.slice(last))
}

function isLiteral(m, ref) {
  // 聊天不收 HTML、公式、跳脫字元（模型常直接寫 Windows 路徑，`C:\Users\x\.claude` 的 `\.` 不能被吃掉）
  if (!docMode && (m[10] ?? m[12] ?? m[15] ?? m[21] ?? m[22]) !== undefined) return true
  return ref === null || (m[20] !== undefined && emojiFor(m[20]) === null)
}

function appendToken(parent, m, ref, imageBase) {
  if (m[1] !== undefined || m[2] !== undefined) appendCode(parent, m[1] ?? m[2])
  else if (m[4] !== undefined) {
    if (m[0].startsWith('!')) appendImage(parent, m[3], m[4], imageBase)
    else appendLink(parent, m[3], m[4], imageBase)
  } else if (m[5] !== undefined || m[6] !== undefined) wrapInline(parent, 'strong', m[5] ?? m[6], imageBase)
  else if (m[7] !== undefined) wrapInline(parent, 'del', m[7], imageBase)
  else if (m[8] !== undefined || m[9] !== undefined) wrapInline(parent, 'em', m[8] ?? m[9], imageBase)
  else if (m[10] !== undefined || m[12] !== undefined) appendInlineHtml(parent, m, imageBase)
  else if (m[15] !== undefined) appendText(parent, m[15])
  else if (m[16] !== undefined || m[17] !== undefined) appendAutolink(parent, m[16] ?? m[17])
  else if (m[18] !== undefined) appendRef(parent, m, ref, imageBase)
  else if (m[20] !== undefined) appendEmoji(parent, m[20])
  else appendMath(parent, m[21] ?? m[22], m[21] !== undefined)
}

function appendCode(parent, text) {
  const code = el('code', 'md-inline-code')
  // ``` `` `x` `` ```：前後各一個空白只是隔開反引號用的
  code.textContent = /^ .* $/.test(text) && text.trim() ? text.slice(1, -1) : text
  parent.appendChild(code)
}

function wrapInline(parent, tag, inner, imageBase) {
  const node = el(tag)
  renderInline(node, inner, imageBase)
  parent.appendChild(node)
}

function externalLink(url) {
  const a = el('a', 'md-link')
  a.setAttribute('href', url)
  a.setAttribute('target', '_blank')
  a.setAttribute('rel', 'noopener noreferrer')
  return a
}

/** `#標題` 連結：在預覽裡捲到那個標題（不改頁面網址） */
function anchorLink(href) {
  const a = el('a', 'md-link')
  a.setAttribute('href', href)
  a.addEventListener('click', (event) => {
    event.preventDefault()
    scrollToAnchor(a, href.slice(1))
  })
  return a
}

/** 錨點寫在 data-anchor（不用 id：預覽裡的標題不能撞到 App 自己的元素 id） */
function scrollToAnchor(from, name) {
  let wanted = name
  try { wanted = decodeURIComponent(name) } catch { /* 不是合法的 %xx：照原字比對 */ }
  const selector = `[data-anchor="${CSS.escape(wanted.toLowerCase())}"]`
  for (let node = from.parentElement; node; node = node.parentElement) {
    const hit = node.querySelector(selector)
    if (hit) {
      hit.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      return
    }
  }
}

/**
 * 連結：外連只收 http(s)／mailto；`#` 捲到標題；專案內的相對路徑只留文字；其他協定降級成原文
 * @param {Node} parent
 * @param {string} label
 * @param {string} url
 */
function appendLink(parent, label, url, imageBase) {
  url = url.replace(/^<|>$/g, '')
  let node
  if (url.startsWith('#') && url.length > 1) node = anchorLink(url)
  else if (SAFE_PROTO.test(url)) node = externalLink(url)
  else if (label && !HAS_SCHEME.test(url)) node = localLink(url)
  else {
    appendText(parent, `[${label}](${url})`)
    return
  }
  renderInline(node, label || url, imageBase)
  parent.appendChild(node)
}

/** 指向別的檔案的相對路徑：呼叫端有給 openLink 就做成連結交給它開（路徑怎麼解、能不能開由它決定），沒給只留文字 */
function localLink(url) {
  const opener = doc.openLink
  if (!opener) {
    const span = el('span', 'md-link-local')
    span.setAttribute('title', url)
    return span
  }
  const a = el('a', 'md-link')
  a.setAttribute('href', url)
  a.setAttribute('title', url)
  a.addEventListener('click', (event) => {
    event.preventDefault()
    opener(url)
  })
  return a
}

/**
 * 相對路徑連結 → 以 fromFile 所在資料夾為準的路徑（`/` 分隔；`/` 開頭以最上層為準）。
 * 去掉 `#段落`／`?參數`、解 %xx。給 openLink 的呼叫端用。
 * @param {string} fromFile 這份 Markdown 自己的路徑（相對於最上層）
 * @param {string} link
 * @returns {{ path: string, dir: boolean } | null} 跑出最上層、空路徑、壞編碼回 null
 */
export function resolveLinkPath(fromFile, link) {
  let target = String(link).split('#')[0].split('?')[0]
  try { target = decodeURIComponent(target) } catch { return null }
  target = target.replace(/\\/g, '/')
  if (!target) return null
  const parts = target.startsWith('/') ? [] : String(fromFile).replace(/\\/g, '/').split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue
    if (seg !== '..') parts.push(seg)
    else if (!parts.length) return null
    else parts.pop()
  }
  return parts.length ? { path: parts.join('/'), dir: target.endsWith('/') } : null
}

function appendAutolink(parent, raw) {
  const a = externalLink(/^www\./i.test(raw) ? `https://${raw}` : raw)
  a.textContent = raw.replace(/^mailto:/i, '')
  parent.appendChild(a)
}

function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** @returns {{ note: string } | { url: string } | null} null＝沒定義，照原文 */
function lookupRef(whole, label, key) {
  if (key === undefined && label.startsWith('^') && !whole.startsWith('!')) {
    const note = label.slice(1).toLowerCase()
    return doc.notes.has(note) ? { note } : null
  }
  const url = doc.refs.get(normLabel(key || label))
  return url === undefined ? null : { url }
}

function appendRef(parent, m, ref, imageBase) {
  if ('note' in ref) appendNoteRef(parent, ref.note)
  else if (m[0].startsWith('!')) appendImage(parent, m[18], ref.url, imageBase)
  else appendLink(parent, m[18], ref.url, imageBase)
}

function appendNoteRef(parent, note) {
  let index = doc.cited.indexOf(note)
  if (index < 0) index = doc.cited.push(note) - 1
  const sup = el('sup', 'md-fnref')
  sup.setAttribute('data-anchor', `fnref-${note}`)
  const a = anchorLink(`#fn-${note}`)
  a.textContent = String(index + 1)
  sup.appendChild(a)
  parent.appendChild(sup)
}

function appendEmoji(parent, name) {
  const emoji = emojiFor(name)
  const span = el('span', 'md-emoji')
  span.setAttribute('title', `:${name}:`)
  span.textContent = emoji ?? `:${name}:`
  if (emoji === undefined) mountEmoji(span, name)
  parent.appendChild(span)
}

function appendMath(parent, source, display) {
  const span = el('span', display ? 'md-math md-math-display' : 'md-math')
  mountMath(span, source, display)
  parent.appendChild(span)
}

/**
 * 行內 `<img …>`／`<br>`／`<kbd>…</kbd>` 這類：標籤照白名單建，成對的內容照樣跑行內語法
 * @param {Node} parent
 * @param {RegExpExecArray} m
 */
function appendInlineHtml(parent, m, imageBase) {
  const made = cleanTag(`<${m[10] ?? m[12]}${m[11] ?? m[13]}>`, (raw) => resolveImage(raw, imageBase))
  if (m[10] !== undefined) {
    if (made) parent.appendChild(made)
    return
  }
  renderInline(made || parent, m[14], imageBase)
  if (made) parent.appendChild(made)
}

/** 圖片只讀 http(s)；專案相對路徑走 main 給的串流網址與原有路徑守衛。回空字串＝不准載。 */
function resolveImage(raw, imageBase) {
  const value = raw.trim().replace(/^<|>$/g, '')
  let source = ''
  try {
    if (/^https?:/i.test(value)) {
      const url = new URL(value)
      if (!url.username && !url.password) source = url.href
    } else if (imageBase && !HAS_SCHEME.test(value)) {
      const base = new URL(imageBase)
      const projectRoot = base.pathname.split('/').slice(0, 2).join('/') + '/'
      const relative = value.replace(/\\/g, '/')
      const url = new URL(relative.startsWith('/') ? projectRoot + relative.slice(1) : relative, base)
      if (base.protocol === 'vi-media:' && url.origin === base.origin
        && url.hostname === base.hostname && url.pathname.startsWith(projectRoot)) source = url.href
    }
  } catch { /* 壞網址維持原文字 */ }
  return source
}

function appendImage(parent, label, raw, imageBase) {
  const source = resolveImage(raw, imageBase)
  if (!source) { appendText(parent, `![${label}](${raw})`); return }
  const img = el('img', 'md-image')
  img.setAttribute('src', source)
  img.setAttribute('alt', label)
  img.setAttribute('loading', 'lazy')
  img.setAttribute('decoding', 'async')
  img.setAttribute('referrerpolicy', 'no-referrer')
  parent.appendChild(img)
}

/** 碼塊外框：標頭（語言、複製鈕）＋ pre/code */
function codeBox(label, source, closed) {
  const box = el('div', closed ? 'md-code' : 'md-code md-code-open')
  const head = el('div', 'md-code-head')
  const lang = el('span', 'md-code-lang')
  lang.textContent = label || 'text'
  const copy = el('button', 'md-copy')
  copy.setAttribute('type', 'button')
  copy.textContent = '複製'
  head.appendChild(lang)
  head.appendChild(copy)
  const pre = el('pre', 'md-pre')
  const code = el('code')
  code.textContent = source
  pre.appendChild(code)
  box.appendChild(head)
  box.appendChild(pre)
  return { box, pre, code }
}

/**
 * 圍欄碼塊；未封閉（串流中）也照樣輸出，額外標記 md-code-open
 * @returns {number} 下一行索引；非碼塊回 -1
 */
function tryFence(lines, i, out) {
  const m = RE_FENCE.exec(lines[i])
  if (!m) return -1
  const close = new RegExp(`^ {0,3}\\${m[1][0]}{${m[1].length},}\\s*$`)
  const body = []
  let j = i + 1
  let closed = false
  for (; j < lines.length; j++) {
    if (close.test(lines[j])) {
      closed = true
      break
    }
    body.push(lines[j])
  }
  const lang = m[2].toLowerCase()
  const source = body.join('\n')
  if (closed && docMode && lang === 'math') {
    out.appendChild(mathBlock(source))
    return j + 1
  }
  const { box, pre, code } = codeBox(m[2], source, closed)
  out.appendChild(box)
  // 串流中還沒收尾的不畫、不上色（每來一個字就重畫一次）
  if (closed && lang === 'mermaid' && source.trim()) mountMermaid(box, pre, source)
  else if (closed && lang) highlightCode(code, lang, source)
  return closed ? j + 1 : j
}

/** 文件開頭 `---` 夾住的 YAML（front matter）：當 yaml 碼塊顯示，不要變成分隔線＋標題 */
function tryFrontMatter(lines, i, out, depth) {
  if (!docMode || i !== 0 || depth !== 0 || lines[0].trim() !== '---') return -1
  const end = lines.findIndex((line, k) => k > 0 && /^(?:---|\.\.\.)\s*$/.test(line))
  if (end < 0) return -1
  const source = lines.slice(1, end).join('\n')
  const { box, code } = codeBox('yaml', source, true)
  out.appendChild(box)
  highlightCode(code, 'yaml', source)
  return end + 1
}

/** 縮排四格的碼塊（文件模式；聊天裡模型常亂縮排，不收） */
function tryIndentedCode(lines, i, out) {
  if (!docMode || indentOf(expandTabs(lines[i])) < 4) return -1
  const { body, end } = readContinuation(lines, i + 1, 4, expandTabs(lines[i]).slice(4), false)
  out.appendChild(codeBox('', body.join('\n'), true).box)
  return end
}

function mathBlock(source) {
  const box = el('div', 'md-math md-math-block')
  mountMath(box, source, true)
  return box
}

/** `$$` 起頭的獨立公式（文件模式），收到結尾的 `$$`；沒收尾就不當公式 */
function tryMath(lines, i, out) {
  if (!docMode) return -1
  const m = RE_MATH_OPEN.exec(lines[i])
  if (!m) return -1
  const same = RE_MATH_CLOSE.exec(m[1])
  if (same) {
    out.appendChild(mathBlock(same[1]))
    return i + 1
  }
  const body = m[1].trim() ? [m[1]] : []
  for (let j = i + 1; j < lines.length; j++) {
    const end = RE_MATH_CLOSE.exec(lines[j])
    if (end) {
      if (end[1].trim()) body.push(end[1])
      out.appendChild(mathBlock(body.join('\n')))
      return j + 1
    }
    body.push(lines[j])
  }
  return -1
}

/**
 * 區塊 HTML：吃到空行為止（CommonMark 的規則）。`<details>` 沒在這段收尾的話，
 * 一路找到配對的 `</details>`，中間照 Markdown 畫進那個 details 裡（README 常這樣寫）。
 */
function tryHtml(lines, i, out, depth, imageBase) {
  if (!docMode || !RE_HTML_START.test(lines[i])) return -1
  const comment = /^ {0,3}<!--/.test(lines[i])
  let j = i
  const head = []
  for (; j < lines.length && (comment || lines[j].trim()); j++) {
    head.push(lines[j])
    if (comment && lines[j].includes('-->')) { j++; break }
  }
  const html = head.join('\n')
  const resolve = (raw) => resolveImage(raw, imageBase)
  const frag = sanitizeHtml(html, resolve)
  const open = count(html, /<details[\s>]/gi) - count(html, /<\/details\s*>/gi)
  if (open > 0 && depth < MAX_DEPTH) {
    const body = []
    let level = open
    for (; j < lines.length; j++) {
      level += count(lines[j], /<details[\s>]/gi) - count(lines[j], /<\/details\s*>/gi)
      if (level <= 0) { j++; break }
      body.push(lines[j])
    }
    const holder = Array.from(frag.querySelectorAll('details')).pop() || frag
    holder.appendChild(renderMarkdown(body.join('\n'), depth + 1, imageBase))
  }
  out.appendChild(frag)
  return j
}

function count(text, re) {
  return (text.match(re) || []).length
}

/** GitHub 的標題錨點規則：小寫、去標點、空白變 `-`，重複的加 `-1`、`-2` */
function slugFor(text) {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-')
  const seen = doc.slugs.get(base) ?? 0
  doc.slugs.set(base, seen + 1)
  return seen ? `${base}-${seen}` : base
}

function appendHeading(out, level, text, imageBase) {
  const h = el(`h${level}`, 'md-h')
  renderInline(h, text, imageBase)
  h.setAttribute('data-anchor', slugFor(h.textContent))
  out.appendChild(h)
}

function tryHeading(lines, i, out, depth, imageBase) {
  const m = RE_HEADING.exec(lines[i])
  if (!m) return -1
  appendHeading(out, m[1].length, m[2].replace(/\s+#+\s*$/, ''), imageBase)
  return i + 1
}

function tryHr(lines, i, out) {
  if (!RE_HR.test(lines[i])) return -1
  out.appendChild(el('hr', 'md-hr'))
  return i + 1
}

function tryQuote(lines, i, out, depth, imageBase) {
  if (!RE_QUOTE.test(lines[i])) return -1
  const inner = []
  let j = i
  for (; j < lines.length; j++) {
    if (RE_QUOTE.test(lines[j])) inner.push(lines[j].replace(RE_QUOTE, ''))
    // 懶續行：引用裡的段落後面直接接的普通文字也算在引用裡
    else if (lines[j].trim() && inner[inner.length - 1].trim() && !isBlockStart(lines, j)) inner.push(lines[j])
    else break
  }
  const quote = el('blockquote', 'md-quote')
  const alert = RE_ALERT.exec(inner[0])
  if (alert) {
    const type = alert[1].toLowerCase()
    quote.className = `md-quote md-alert md-alert-${type}`
    const title = el('p', 'md-alert-title')
    title.textContent = ALERTS[type]
    quote.appendChild(title)
    inner.shift()
  }
  if (depth < MAX_DEPTH) {
    quote.appendChild(renderMarkdown(inner.join('\n'), depth + 1, imageBase))
  } else {
    appendText(quote, inner.join('\n'))
  }
  out.appendChild(quote)
  return j
}

function expandTabs(line) {
  return line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    '))
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * 從 start 往下收縮排 ≥ offset 的行（去掉這段縮排），中間可以夾空行；
 * lazy 為真時，段落後面直接接的不縮排文字也算（CommonMark 的懶續行）。
 * @returns {{ body: string[], end: number, gap: boolean }} gap＝中間夾過空行
 */
function readContinuation(lines, start, offset, first, lazy = true) {
  const body = [first]
  let gap = false
  let j = start
  while (j < lines.length) {
    const line = expandTabs(lines[j])
    if (!line.trim()) {
      let n = j
      while (n < lines.length && !lines[n].trim()) n++
      if (n >= lines.length || indentOf(expandTabs(lines[n])) < offset) break
      for (; j < n; j++) body.push('')
      gap = true
      continue
    }
    if (indentOf(line) >= offset) body.push(line.slice(offset))
    else if (lazy && body[body.length - 1].trim() && !isBlockStart(lines, j) && !isDefinition(lines[j])) body.push(line.trim())
    else break
    j++
  }
  return { body, end: j, gap }
}

/** 清單：子項目縮排到內容那一欄就是巢狀；項目之間或裡面有空行＝寬鬆清單（段落有間距） */
function tryList(lines, i, out, depth, imageBase) {
  const first = RE_ITEM.exec(lines[i])
  if (!first) return -1
  const kind = first[2].slice(-1) // `-` `*` `+` 或有序清單的 `.` `)`；換記號就是另一個清單
  const items = []
  let loose = false
  let j = i
  while (j < lines.length) {
    const m = RE_ITEM.exec(lines[j])
    if (!m || m[2].slice(-1) !== kind || (j > i && RE_HR.test(lines[j]))) break
    // 記號後超過四個空白：內容是縮排碼塊，內容欄只算一格
    const pad = !m[3] || m[3].length > 4 ? 1 : m[3].length
    const lead = m[3] ? ' '.repeat(m[3].length - pad) : ''
    const item = readContinuation(lines, j + 1, m[1].length + m[2].length + pad, lead + (m[4] ?? ''))
    items.push(item.body)
    loose ||= item.gap
    j = item.end
    let k = j
    while (k < lines.length && !lines[k].trim()) k++
    if (k === j) continue
    const next = k < lines.length ? RE_ITEM.exec(lines[k]) : null
    if (!next || next[2].slice(-1) !== kind || RE_HR.test(lines[k])) break
    loose = true
    j = k
  }
  const ordered = kind === '.' || kind === ')'
  const list = el(ordered ? 'ol' : 'ul', 'md-list')
  if (ordered) list.setAttribute('start', String(parseInt(first[2], 10)))
  for (const body of items) list.appendChild(renderItem(body, loose, depth, imageBase))
  out.appendChild(list)
  return j
}

function renderItem(body, loose, depth, imageBase) {
  const li = el('li')
  const task = RE_TASK.exec(body[0])
  if (task) {
    li.className = 'md-task'
    const box = el('input', 'md-task-box')
    box.setAttribute('type', 'checkbox')
    box.setAttribute('disabled', '')
    if (task[1] !== ' ') box.setAttribute('checked', '')
    li.appendChild(box)
    body = [body[0].slice(task[0].length), ...body.slice(1)]
  }
  if (depth >= MAX_DEPTH) {
    renderInline(li, body.join('\n'), imageBase)
    return li
  }
  const inner = renderMarkdown(body.join('\n'), depth + 1, imageBase)
  for (const node of Array.from(inner.childNodes)) {
    // 緊湊清單：段落不包 <p>，字直接放在項目裡
    if (!loose && node.className === 'md-p') {
      for (const child of Array.from(node.childNodes)) li.appendChild(child)
    } else {
      li.appendChild(node)
    }
  }
  return li
}

function tryTable(lines, i, out, depth, imageBase) {
  if (i + 1 >= lines.length) return -1
  if (!lines[i].includes('|') || !lines[i + 1].includes('|')) return -1
  if (!RE_TABLE_SEP.test(lines[i + 1])) return -1
  const align = splitRow(lines[i + 1]).map(cellAlign)
  const table = el('table', 'md-table')
  const thead = el('thead')
  thead.appendChild(buildRow(splitRow(lines[i]), align, 'th', imageBase))
  table.appendChild(thead)
  const tbody = el('tbody')
  let j = i + 2
  for (; j < lines.length && lines[j].trim() && lines[j].includes('|'); j++) {
    tbody.appendChild(buildRow(splitRow(lines[j]), align, 'td', imageBase))
  }
  table.appendChild(tbody)
  const wrap = el('div', 'md-table-wrap')
  wrap.appendChild(table)
  out.appendChild(wrap)
  return j
}

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  // `\|` 是格子裡的字面 `|`，不是欄分隔
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function cellAlign(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'md-center'
  if (right) return 'md-right'
  return ''
}

function buildRow(cells, align, tag, imageBase) {
  const tr = el('tr')
  cells.forEach((cell, idx) => {
    const td = el(tag, align[idx] || '')
    renderInline(td, cell, imageBase)
    tr.appendChild(td)
  })
  return tr
}

function isDefinition(line) {
  return RE_LINK_DEF.test(line) || RE_NOTE_DEF.test(line)
}

function addRef(m) {
  const key = normLabel(m[1])
  if (!doc.refs.has(key)) doc.refs.set(key, m[2].replace(/^<|>$/g, ''))
}

/** 腳註定義：`[^x]: 內文`，後面縮排的行（可以夾空行）也是它的 */
function readNote(lines, i) {
  const m = RE_NOTE_DEF.exec(lines[i])
  const { body, end } = readContinuation(lines, i + 1, 4, m[2])
  return { label: m[1].toLowerCase(), body: body.join('\n'), end }
}

/** 定義行本身不顯示（內容在 collectDefinitions 先收好了） */
function tryDefinition(lines, i) {
  const link = RE_LINK_DEF.exec(lines[i])
  if (link) {
    addRef(link)
    return i + 1
  }
  if (!RE_NOTE_DEF.test(lines[i])) return -1
  const note = readNote(lines, i)
  if (!doc.notes.has(note.label)) doc.notes.set(note.label, note.body)
  return note.end
}

/** 參考式連結與腳註常寫在文末：先掃一遍（略過碼塊；不能接在段落中間，跟 CommonMark 一樣） */
function collectDefinitions(lines) {
  let fence = ''
  for (let i = 0; i < lines.length; i++) {
    const f = RE_FENCE.exec(lines[i])
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) fence = ''
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    const prev = i > 0 ? lines[i - 1] : ''
    if (prev.trim() && !isDefinition(prev) && !isBlockStart(lines, i - 1)) continue
    const link = RE_LINK_DEF.exec(lines[i])
    if (link) addRef(link)
    else if (RE_NOTE_DEF.test(lines[i])) {
      const note = readNote(lines, i)
      if (!doc.notes.has(note.label)) doc.notes.set(note.label, note.body)
    }
  }
}

/** 文末的腳註清單，照第一次被引用的順序編號；每條附一個 ↩ 回到引用處 */
function appendFootnotes(out, imageBase) {
  if (!doc.cited.length) return
  const section = el('section', 'md-footnotes')
  const list = el('ol', 'md-footnote-list')
  // 腳註內文也可能引用別的腳註：cited 會邊畫邊變長
  for (let k = 0; k < doc.cited.length; k++) {
    const note = doc.cited[k]
    const li = el('li')
    li.setAttribute('data-anchor', `fn-${note}`)
    const body = renderMarkdown(doc.notes.get(note), 1, imageBase)
    const back = anchorLink(`#fnref-${note}`)
    back.className = 'md-link md-fnback'
    back.setAttribute('aria-label', '回到內文')
    back.textContent = '↩'
    const tail = body.childNodes[body.childNodes.length - 1]
    if (tail?.className === 'md-p') tail.appendChild(back)
    li.appendChild(body)
    if (tail?.className !== 'md-p') li.appendChild(back)
    list.appendChild(li)
  }
  section.appendChild(list)
  out.appendChild(section)
}

function isBlockStart(lines, i) {
  const line = lines[i]
  return (
    RE_FENCE.test(line) ||
    (docMode && (RE_HTML_START.test(line) || RE_MATH_OPEN.test(line))) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_BULLET.test(line) ||
    RE_ORDERED.test(line)
  )
}

/**
 * Markdown → DocumentFragment（零 innerHTML）
 * @param {string} text
 * @param {number} [depth] 內部遞迴用
 * @param {string} [imageBase] main 提供的專案 Markdown 串流網址，用來解析相對圖片
 * @param {{ html?: boolean, openLink?: (path: string) => void }} [options]
 *   html：文件模式（只給文件預覽；聊天裡模型寫的 `<div>`、`$` 照舊當文字）；
 *   openLink：點到相對路徑連結（`docs/a.md`、`../x#段落`，原字串照給）時呼叫
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text, depth = 0, imageBase = '', options) {
  if (depth > 0) return renderBlocks(text, depth, imageBase)
  const saved = { docMode, doc }
  docMode = options?.html === true
  doc = newDoc(typeof options?.openLink === 'function' ? options.openLink : null)
  try {
    const source = String(text ?? '').replace(/\r\n?/g, '\n')
    collectDefinitions(source.split('\n'))
    const out = renderBlocks(source, 0, imageBase)
    appendFootnotes(out, imageBase)
    return out
  } finally {
    ({ docMode, doc } = saved)
  }
}

/** 文件預覽只畫前這麼多字：幾十 MB 的 Markdown 一次轉成 DOM 會把畫面卡死好幾秒 */
export const PREVIEW_MAX_CHARS = 512 * 1024

/**
 * 預覽要畫的那一段。超過上限就切在上限前最後一個換行（不切斷一行）。
 * @param {string} text 整份，或呼叫端已經先截好的開頭一段
 * @param {number} [total] 整份的長度（`text` 只是開頭時給）
 * @returns {{ text: string, cut: boolean }}
 */
export function previewSlice(text, total = text.length) {
  if (total <= PREVIEW_MAX_CHARS) return { text, cut: false }
  const head = text.slice(0, PREVIEW_MAX_CHARS)
  const end = head.lastIndexOf('\n')
  return { text: end > 0 ? head.slice(0, end) : head, cut: true }
}

const BLOCKS = [tryFrontMatter, tryIndentedCode, tryFence, tryMath, tryHtml, tryHeading, tryHr, tryQuote, tryList, tryTable, tryDefinition]

function renderBlocks(text, depth, imageBase) {
  const out = document.createDocumentFragment()
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++
      continue
    }
    let next = -1
    for (const handler of BLOCKS) {
      next = handler(lines, i, out, depth, imageBase)
      if (next >= 0) break
    }
    i = next >= 0 ? next : appendParagraph(lines, i, out, imageBase)
  }
  return out
}

/** 段落：吃到空行或下一個區塊為止；下一行是 `===`／`---` 的話整段變標題 */
function appendParagraph(lines, i, out, imageBase) {
  const buf = []
  while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
    buf.push(lines[i])
    i++
    const under = i < lines.length ? RE_SETEXT.exec(lines[i]) : null
    if (under) {
      appendHeading(out, under[1][0] === '=' ? 1 : 2, buf.map((line) => line.trim()).join(' '), imageBase)
      return i + 1
    }
  }
  // 什麼都沒吃到（理論上不會：區塊都試過了），至少前進一行免得卡死
  if (!buf.length) {
    buf.push(lines[i])
    i++
  }
  const p = el('p', 'md-p')
  renderInline(p, buf.join('\n'), imageBase)
  out.appendChild(p)
  return i
}
