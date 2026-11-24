/**
 * CSV／TSV 表格預覽（對照 VS Code 的 Rainbow CSV／Edit CSV、GitHub 的表格檢視）。
 * 欄位照 RFC 4180：雙引號包住的可以有分隔符號、換行與 `""`。只畫前 MAX_ROWS 列，大檔不會卡住。
 */

const MAX_ROWS = 5000
const MAX_COLS = 200
const DELIMITERS = [',', ';', '\t', '|']
const NAMES = { ',': '逗號', ';': '分號', '\t': 'Tab', '|': '直線' }
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/

/**
 * 猜分隔符號：.tsv 一定是 Tab；其他看前幾行哪個符號每行出現次數一樣而且最多。
 * @param {string} text
 * @param {string} name 檔名
 */
export function sniffDelimiter(text, name) {
  if (/\.tsv$/i.test(name)) return '\t'
  const lines = text.slice(0, 8192).split(/\r?\n/).filter(Boolean).slice(0, 6)
  let best = ','
  let bestCount = 0
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => line.split(delimiter).length - 1)
    const steady = counts.length > 0 && counts.every((count) => count === counts[0])
    if (steady && counts[0] > bestCount) {
      best = delimiter
      bestCount = counts[0]
    }
  }
  return best
}

/**
 * @param {string} text
 * @param {string} delimiter
 * @param {number} [maxRows]
 * @returns {{ rows: string[][], truncated: boolean }}
 */
export function parseCsv(text, delimiter, maxRows = MAX_ROWS) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') cell += ch
      else if (text[i + 1] === '"') { cell += '"'; i += 1 }
      else quoted = false
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length >= maxRows) return { rows, truncated: i + 1 < text.length }
    } else cell += ch
  }
  if (cell || row.length) rows.push([...row, cell])
  return { rows, truncated: false }
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** @param {string[]} cells @param {number} cols @param {'th' | 'td'} tag @param {string} label 列號欄 */
function rowOf(cells, cols, tag, label) {
  const tr = document.createElement('tr')
  tr.appendChild(el(tag === 'th' ? 'th' : 'td', 'ed-csv-ln', label))
  for (let c = 0; c < cols; c += 1) {
    const value = cells[c] ?? ''
    const cell = el(tag, NUMBER.test(value.trim()) && value.trim() ? 'is-num' : '', value)
    cell.dataset.col = String(c % 8)
    tr.appendChild(cell)
  }
  return tr
}

/**
 * @param {string} text 檔案內容（大檔只給開頭一段）
 * @param {string} name 檔名
 * @param {boolean} cut 內容是不是只有開頭一段
 */
export function renderCsv(text, name, cut) {
  const delimiter = sniffDelimiter(text, name)
  const { rows, truncated } = parseCsv(text, delimiter)
  const wrap = el('div', 'ed-csv')
  const cols = Math.min(MAX_COLS, rows.reduce((max, row) => Math.max(max, row.length), 0))
  const more = truncated || cut ? `，只顯示前 ${rows.length.toLocaleString()} 列` : ''
  const wide = rows.some((row) => row.length > MAX_COLS) ? `、前 ${MAX_COLS} 欄` : ''
  wrap.appendChild(el('p', 'ed-csv-info', `${rows.length.toLocaleString()} 列 × ${cols} 欄・分隔符號：${NAMES[delimiter]}${more}${wide}`))
  if (!rows.length) return wrap
  const table = el('table', 'ed-csv-table')
  const head = el('thead')
  head.appendChild(rowOf(rows[0], cols, 'th', ''))
  const body = el('tbody')
  for (let r = 1; r < rows.length; r += 1) body.appendChild(rowOf(rows[r], cols, 'td', String(r)))
  table.append(head, body)
  wrap.appendChild(table)
  return wrap
}
