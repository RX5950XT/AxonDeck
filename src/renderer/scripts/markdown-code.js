/**
 * 碼塊上色：highlight.js（自包含 ESM 版，內建常用 36 種語言；其他語言第一次碰到才載）。
 *
 * highlight.js 回的是 HTML 字串（只有 `<span class="hljs-…">` 和跳脫過的文字）。
 * 不塞 innerHTML：DOMParser 解成惰性文件，再只照抄 span 與文字。
 */

const BASE = new URL('../../../node_modules/@highlightjs/cdn-assets/es/', import.meta.url).href

/** 常見但 highlight.js 不認的寫法 → 它的語言檔名 */
const ALIAS = {
  ps1: 'powershell', psm1: 'powershell', pwsh: 'powershell', ps: 'powershell',
  bat: 'dos', cmd: 'dos', batch: 'dos', docker: 'dockerfile', containerfile: 'dockerfile',
  tex: 'latex', toml: 'ini', proto: 'protobuf', hs: 'haskell', ex: 'elixir', exs: 'elixir',
  jl: 'julia', vue: 'xml', svelte: 'xml', zsh: 'bash', console: 'shell', terminal: 'shell'
}

/** @type {any} */
let hljs = null
/** @type {Promise<void> | null} */
let loading = null
/** 語言檔載入結果（失敗的也記著，不重複去要） */
const extra = new Map()

function load() {
  loading ||= import(`${BASE}highlight.min.js`).then((mod) => { hljs = mod.default }, (error) => {
    loading = null
    throw error
  })
  return loading
}

/** @param {string} name */
function ensureLanguage(name) {
  if (hljs.getLanguage(name)) return Promise.resolve()
  // 只認純字母數字的檔名：不讓碼塊標頭組出別的路徑
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return Promise.reject(new Error('unknown language'))
  if (!extra.has(name)) {
    extra.set(name, import(`${BASE}languages/${name}.min.js`).then((mod) => hljs.registerLanguage(name, mod.default)))
  }
  return extra.get(name)
}

/**
 * @param {HTMLElement} code `<code>`（內容已是原文；上色成功才換掉）
 * @param {string} lang 碼塊標頭寫的語言
 * @param {string} source
 */
export function highlightCode(code, lang, source) {
  const key = lang.toLowerCase()
  const name = ALIAS[key] || key
  if (!name || name === 'text' || name === 'plaintext' || name === 'txt') return
  if (hljs?.getLanguage(name)) {
    paint(code, name, source)
    return
  }
  // 不認得的語言（或元件載不到）就維持單色原文；上色只是加分，不打擾使用者
  load().then(() => ensureLanguage(name)).then(() => paint(code, name, source), () => {})
}

function paint(code, name, source) {
  let html
  try {
    html = hljs.highlight(source, { language: name, ignoreIllegals: true }).value
  } catch {
    return // 語法檔自己出錯：維持單色原文，不能讓整份預覽跟著壞
  }
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  const out = document.createDocumentFragment()
  for (const node of Array.from(parsed.body.childNodes)) out.appendChild(copy(node))
  code.textContent = ''
  code.appendChild(out)
  code.classList.add('hljs')
}

/** 只抄 span（class 限字母數字）與文字；其他元素只留字 */
function copy(node) {
  if (node.nodeType !== 1) return document.createTextNode(node.textContent || '')
  if (node.localName !== 'span') return document.createTextNode(node.textContent || '')
  const span = document.createElement('span')
  const cls = node.getAttribute('class') || ''
  if (/^[\w\s-]+$/.test(cls)) span.className = cls
  for (const child of Array.from(node.childNodes)) span.appendChild(copy(child))
  return span
}
