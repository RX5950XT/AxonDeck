/**
 * 翻譯術語表：每行「英文=繁中」。只挑原文裡真的出現的詞交給模型，
 * 雲端放進 system prompt，Index-Translate 用官方 instTrans 的術語約束；LinguaForge 的格式吃不下，不套用。
 * 從沒設定過＝內建清單（數學／理工的臺灣譯名）；使用者清空就是不用。
 * 另有內建學術名詞庫（國家教育研究院理工 45 科，約 55 萬條片語，可關），使用者詞條優先。
 */

const KEY = 'translateGlossary'
/** 內建學術名詞庫開關；沒設定過＝開 */
const BUILTIN_KEY = 'translateGlossaryBuiltin'
const MAX_CHARS = 50000
const MAX_MATCHES = 30

const DEFAULT_GLOSSARY = `ordinary differential equation=常微分方程
partial differential equation=偏微分方程
differential equation=微分方程
exact equation=正合方程
inexact equation=非正合方程
integrating factor=積分因子
homogeneous=齊次
inhomogeneous=非齊次
nonhomogeneous=非齊次
nonlinear=非線性
linear=線性
initial value problem=初值問題
boundary value problem=邊界值問題
general solution=通解
particular solution=特解
complementary function=餘函數
singular solution=奇異解
explicit solution=顯式解
implicit solution=隱式解
separable equation=可分離方程
Bernoulli equation=白努利方程
harmonic oscillator=諧振子
simple pendulum=單擺
growth rate=成長率
exponential growth=指數成長
exponential decay=指數衰減
population growth=人口成長
eigenvalue=特徵值
eigenvector=特徵向量
matrix=矩陣
determinant=行列式
partial derivative=偏導數
derivative=導數
integral=積分
convergence=收斂
Laplace transform=拉普拉斯轉換
Fourier series=傅立葉級數
Fourier transform=傅立葉轉換
power series=冪級數
Taylor series=泰勒級數
vector=向量
scalar=純量
coefficient=係數
parameter=參數
variable=變數
probability=機率
random variable=隨機變數
standard deviation=標準差
variance=變異數
algorithm=演算法
software=軟體
hardware=硬體
signal=訊號
circuit=電路
voltage=電壓
capacitor=電容器
inductor=電感器
thermodynamics=熱力學
entropy=熵
momentum=動量
torque=力矩
acceleration=加速度
velocity=速度
friction=摩擦力
equilibrium=平衡
degree of freedom=自由度`

/**
 * @param {{ get: (key: string, fallback?: unknown) => unknown }} store
 * @returns {string}
 */
function read(store) {
  const value = store?.get(KEY)
  return typeof value === 'string' ? value.slice(0, MAX_CHARS) : DEFAULT_GLOSSARY
}

/**
 * null＝恢復內建清單（呼叫端刪掉設定）；其餘只收字串
 * @param {unknown} value
 * @returns {string | null}
 */
function sanitize(value) {
  if (value === null) return null
  return typeof value === 'string' ? value.slice(0, MAX_CHARS) : DEFAULT_GLOSSARY
}

/**
 * @param {string} text
 * @returns {{ source: string, target: string, pattern: RegExp }[]}
 */
function parse(text) {
  const entries = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at < 1) continue
    const source = line.slice(0, at).trim()
    const target = line.slice(at + 1).trim()
    if (!source || !target || source.length > 100 || target.length > 100) continue
    const words = source.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    // 字界＋可帶複數：exact equation 也對到 Exact equations，但不會對到 inexact equations
    entries.push({ source, target, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?:s|es)?(?![\\p{L}\\p{N}])`, 'iu') })
  }
  return entries
}

/**
 * 原文裡出現的詞條；長詞先比，短詞若只出現在長詞裡面就不算（linear 不跟 nonlinear 重複）
 * @param {ReturnType<typeof parse>} entries
 * @param {string} text
 * @returns {{ source: string, target: string }[]}
 */
function match(entries, text) {
  return matchRest(entries, text).found
}

/** match 加上剩下沒被對到的文字（給內建詞庫接著比，使用者的詞優先） */
function matchRest(entries, text) {
  let rest = String(text || '')
  const found = []
  for (const entry of [...entries].sort((a, b) => b.source.length - a.source.length)) {
    if (found.length >= MAX_MATCHES) break
    if (!entry.pattern.test(rest)) continue
    found.push({ source: entry.source, target: entry.target })
    rest = rest.replace(new RegExp(entry.pattern.source, 'giu'), ' ')
  }
  return { found, rest }
}

// ===== 內建學術名詞庫（國家教育研究院，scripts/build-glossary-data.js 產生） =====
// 整段排序好的文字＋行首位移做二分搜尋：建成 Map 要多吃約 60 MB，這樣約 30 MB。
let builtin = null

function loadBuiltin() {
  if (builtin) return builtin
  const zlib = require('zlib')
  const file = require('path').join(__dirname, 'glossary-data', 'naer-terms.tsv.gz')
  const text = zlib.gunzipSync(require('fs').readFileSync(file)).toString('utf8')
  // 檔案以換行結尾、依 JS 字串順序排好（建檔腳本保證）
  const starts = [0]
  for (let at = text.indexOf('\n'); at >= 0 && at + 1 < text.length; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  builtin = { text, starts: Int32Array.from(starts) }
  return builtin
}

/** @returns {string[] | null} 譯名候選（依各學科出現次數排序） */
function lookupBuiltin(key) {
  const { text, starts } = loadBuiltin()
  let low = 0, high = starts.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const start = starts[mid]
    const tab = text.indexOf('\t', start)
    const source = text.slice(start, tab)
    if (source === key) return text.slice(tab + 1, text.indexOf('\n', tab)).split('\t')
    if (source < key) low = mid + 1
    else high = mid - 1
  }
  return null
}

/** 複數只看最後一個字：equations→equation、properties→property、gases→gas */
function singular(key) {
  if (/ies$/.test(key)) return [key.replace(/ies$/, 'y')]
  if (/(?:ses|xes|zes|ches|shes)$/.test(key)) return [key.replace(/es$/, ''), key.replace(/s$/, '')]
  if (/[^s]s$/.test(key)) return [key.replace(/s$/, '')]
  return []
}

/**
 * 最長優先、不重疊：「ordinary differential equation」吃掉了就不會再出「differential equation」
 * @param {string} text
 * @param {number} limit
 * @returns {{ source: string, targets: string[] }[]}
 */
function matchBuiltin(text, limit) {
  const words = [...String(text || '').matchAll(/[A-Za-z][A-Za-z0-9'-]*/g)].map((m) => m[0].toLowerCase())
  const found = []
  const seen = new Set()
  for (let i = 0; i < words.length && found.length < limit;) {
    let hit = null
    for (let n = Math.min(5, words.length - i); n >= 1 && !hit; n--) {
      const key = words.slice(i, i + n).join(' ')
      for (const candidate of [key, ...singular(key)]) {
        const targets = lookupBuiltin(candidate)
        if (targets) { hit = { source: candidate, targets, n }; break }
      }
    }
    if (!hit) { i++; continue }
    if (!seen.has(hit.source)) { seen.add(hit.source); found.push({ source: hit.source, targets: hit.targets }) }
    i += hit.n
  }
  return found
}

/**
 * 翻譯時要用的設定：使用者詞條＋是否用內建詞庫
 * @param {{ get: (key: string, fallback?: unknown) => unknown }} store
 */
function load(store) {
  return { entries: parse(read(store)), builtin: store?.get(BUILTIN_KEY) !== false }
}

/**
 * 原文出現的術語：使用者詞條（唯一譯名）優先，再補內建詞庫（可能有多個候選）
 * @param {ReturnType<typeof load> | undefined} glossary
 * @param {string} text
 * @returns {{ source: string, targets: string[] }[]}
 */
function find(glossary, text) {
  if (!glossary) return []
  const { found, rest } = matchRest(glossary.entries, text)
  const terms = found.map((term) => ({ source: term.source, targets: [term.target] }))
  if (!glossary.builtin || terms.length >= MAX_MATCHES) return terms
  return terms.concat(matchBuiltin(rest, MAX_MATCHES - terms.length))
}

module.exports = { KEY, BUILTIN_KEY, DEFAULT_GLOSSARY, read, sanitize, parse, match, load, find }
