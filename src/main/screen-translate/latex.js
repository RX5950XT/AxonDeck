'use strict'

/** OCR 的行內 LaTeX → 浮窗能直接顯示的純文字：⟨x²⟩、∂x/∂t、e^(-iEₙt/ℏ)（PDF 那邊是 worker.py 的 latex_plain） */
const SYMBOLS = {
  langle: '⟨', rangle: '⟩', hbar: 'ℏ', infty: '∞', sum: '∑', int: '∫', oint: '∮', partial: '∂', nabla: '∇',
  cdot: '·', times: '×', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  equiv: '≡', propto: '∝', sim: '∼', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', sqrt: '√',
  prime: '′', dagger: '†', ldots: '…', cdots: '⋯', dots: '…', in: '∈', quad: ' ', qquad: ' ',
  varepsilon: 'ε', vartheta: 'ϑ', varphi: 'φ', ell: 'ℓ', circ: '°', degree: '°'
}
const DROP = new Set(['left', 'right', 'big', 'Big', 'displaystyle', ',', ';', '!'])
// Unicode 希臘字母照這個順序排；sigma 之後跳過一格（小寫是詞尾 ς、大寫是空號）
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu',
  'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega']
const table = (from, to) => Object.fromEntries(Array.from(from).map((c, i) => [c, Array.from(to)[i]]))
const SCRIPTS = {
  '^': table('0123456789+-=()niT', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵀ'),
  _: table('0123456789+-=()aeoxijknm', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓᵢⱼₖₙₘ')
}

function command(name) {
  if (SYMBOLS[name]) return SYMBOLS[name]
  const index = GREEK.indexOf(name.toLowerCase())
  if (index >= 0) return String.fromCodePoint((name[0] === name[0].toUpperCase() ? 0x391 : 0x3B1) + index + (index >= 17 ? 1 : 0))
  return DROP.has(name) ? '' : name
}

/** 全部字元都有 Unicode 上下標就直接換，不然寫成 ^(…)／_(…) */
function script(mark, text) {
  const chars = Array.from(text.replace(/\s+/g, '')) // 數學模式裡的空白本來就不顯示
  if (chars.length && chars.every((c) => SCRIPTS[mark][c])) return chars.map((c) => SCRIPTS[mark][c]).join('')
  return chars.length > 1 ? `${mark}(${chars.join('')})` : mark + chars.join('')
}

function latexPlain(expr) {
  let text = expr.replace(/\\(?:text|mathrm|mathbf|mathit|mathcal|operatorname|boldsymbol|mathbb)\s*\{([^{}]*)\}/g, '$1')
  for (let i = 0; i < 3; i++) {
    text = text.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => [a, b].map((p) => p.length <= 1 ? p : `(${p})`).join('/'))
  }
  text = text.replace(/\\([A-Za-z]+|[,;!])(?:\s+(?=\w))?/g, (_, name) => command(name))
  // 先換單字元（括號裡的 E_n），再由內往外換 {…}
  text = text.replace(/([\^_])\s*([^\s{}(（])/g, (_, mark, c) => script(mark, c))
  for (let i = 0; i < 3; i++) text = text.replace(/([\^_])\s*\{([^{}]*)\}/g, (_, mark, inner) => script(mark, inner))
  return text.replace(/[{}]/g, '').replace(/\s+/g, ' ').replace(/\s+([⟩)\],.])/g, '$1').trim()
}

// $$…$$、\(…\)，或內容像公式的 $…$（有 \指令、^、_、{，或不含空白的短式子）；`$5 and $10` 這種價錢不動
const MATH = /\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$([^$\n]*?(?:\\[A-Za-z]|[\^_{])[^$\n]*?|[\w.,/+\-=()]{1,12})\$/g

/** 文字裡的公式換成純文字；OCR 原文和譯文都過一次（雲端模型會把 V₀ 改寫回 $V_0$） */
function mathText(text) {
  return text.replace(MATH, (_, a, b, c) => latexPlain(a ?? b ?? c))
}

module.exports = { latexPlain, mathText }
