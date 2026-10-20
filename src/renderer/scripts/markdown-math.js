/**
 * 數學公式：KaTeX 只輸出 MathML（Chromium 原生會排版，不必帶 KaTeX 的 CSS 與字型）。
 *
 * KaTeX 回 HTML 字串；不塞 innerHTML：DOMParser 解成惰性文件，再照 MathML 白名單重建。
 * trust 關著（\href、\htmlClass 這類一律當錯誤），屬性也只抄排版用的。
 */

const KATEX = new URL('../../../node_modules/katex/dist/katex.mjs', import.meta.url).href
const NS = 'http://www.w3.org/1998/Math/MathML'

const TAGS = new Set([
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mlabeledtr',
  'mstyle', 'mpadded', 'mphantom', 'menclose', 'merror', 'mmultiscripts', 'mprescripts', 'none'
])
const ATTRS = new Set([
  'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder',
  'columnalign', 'columnspacing', 'columnlines', 'rowalign', 'rowspacing', 'rowlines', 'frame', 'framespacing',
  'width', 'height', 'depth', 'voffset', 'scriptlevel', 'displaystyle', 'minsize', 'maxsize', 'movablelimits',
  'symmetric', 'largeop', 'linethickness', 'notation', 'mathcolor', 'mathbackground', 'mathsize', 'form',
  'rowspan', 'columnspan'
])

/** @type {any} */
let katex = null
/** @type {Promise<void> | null} */
let loading = null

function load() {
  loading ||= import(KATEX).then((mod) => { katex = mod.default }, (error) => {
    loading = null
    throw error
  })
  return loading
}

/**
 * 先放原文，KaTeX 載好（第一次才要等）再換成公式；寫錯就留原文並在 title 說原因。
 * @param {HTMLElement} target
 * @param {string} source
 * @param {boolean} display
 */
export function mountMath(target, source, display) {
  target.textContent = display ? `$$${source}$$` : `$${source}$`
  if (katex) {
    paint(target, source, display)
    return
  }
  load().then(() => paint(target, source, display), () => {
    target.classList.add('md-math-error')
    target.title = '公式元件載入失敗'
  })
}

function paint(target, source, display) {
  let html
  try {
    html = katex.renderToString(source, {
      displayMode: display, output: 'mathml', throwOnError: true, trust: false, strict: 'ignore',
      maxSize: 50, maxExpand: 1000
    })
  } catch (error) {
    target.classList.add('md-math-error')
    target.title = String(error?.message || error).slice(0, 300)
    return
  }
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  const math = parsed.querySelector('math')
  if (!math) return
  const node = copy(math)
  if (!node) return
  target.textContent = ''
  target.appendChild(node)
}

/** 白名單外的元素連內容一起丟（annotation 是 TeX 原文，不顯示） */
function copy(node) {
  if (node.nodeType === 3) return document.createTextNode(node.data)
  if (node.nodeType !== 1 || !TAGS.has(node.localName)) return null
  const out = document.createElementNS(NS, node.localName)
  for (const attr of Array.from(node.attributes)) {
    if (ATTRS.has(attr.name)) out.setAttribute(attr.name, attr.value)
  }
  for (const child of Array.from(node.childNodes)) {
    const made = copy(child)
    if (made) out.appendChild(made)
  }
  return out
}
