'use strict'

const toml = require('smol-toml')
const { isDeepStrictEqual } = require('util')

function equal(a, b) {
  if (isDeepStrictEqual(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]))
  const plain = value => value && typeof value === 'object' &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value))
  if (!plain(a) || !plain(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

function parse(raw) {
  return toml.parse(raw.replace(/^\uFEFF/, ''))
}

// 只辨認字串外的表頭；多行字串內看似表頭的文字不能拿來切檔。
function scanLine(line, quote) {
  for (let i = 0; i < line.length; i++) {
    if (!quote && line[i] === '#') break
    if (line[i] === '\\' && quote?.startsWith('"')) { i++; continue }
    if (quote && line.startsWith(quote, i)) {
      let count = quote.length
      if (quote.length === 3) while (line[i + count] === quote[0]) count++
      i += count - 1
      quote = ''
    } else if (!quote && /['"]/.test(line[i])) {
      quote = line.slice(i, i + 3) === line[i].repeat(3) ? line[i].repeat(3) : line[i]
      i += quote.length - 1
    }
  }
  return quote
}

function headerPath(header) {
  let node = toml.parse(header.startsWith('[[') ? header.slice(1, -1) : header)
  const keys = []
  while (Object.keys(node).length) {
    const names = Object.keys(node)
    if (names.length !== 1 || Array.isArray(node[names[0]])) throw new Error('UNSAFE_TABLE')
    keys.push(names[0])
    node = node[names[0]]
  }
  return keys
}

function sections(raw) {
  const tables = []
  let quote = ''
  let offset = 0
  for (const line of raw.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const text = offset === 0 ? line.replace(/^\uFEFF/, '') : line
    if (!quote && /^[ \t]*\[/.test(text)) {
      const match = text.match(/^[ \t]*(\[.*\])[ \t]*(?:#[^\r\n]*)?\r?\n?$/)
      if (!match) return null
      tables.push({ start: offset + (text === line ? 0 : 1), keys: headerPath(match[1]), array: match[1].startsWith('[[') })
    }
    quote = scanLine(text, quote)
    offset += line.length
  }
  return tables.map((table, i) => {
    const end = tables[i + 1]?.start ?? raw.length
    const body = raw.slice(table.start, end)
    const lines = body.match(/[^\n]*\n|[^\n]+$/g) || []
    let trivia = 0
    for (let j = lines.length - 1; j > 0 && /^[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(lines[j]); j--) trivia += lines[j].length
    return { ...table, end: end - trivia }
  })
}

function blocksOf(raw, servers) {
  const tables = sections(raw)
  if (!tables) return null
  const blocks = new Map()
  let previous = null
  for (const table of tables) {
    const id = table.keys[0] === 'mcp_servers' && table.keys.length > 1 ? table.keys[1] : null
    if (id === null) { previous = null; continue }
    if (table.array) return null
    if (blocks.has(id) && previous !== id) return null
    if (previous === id) blocks.get(id).end = table.end
    else blocks.set(id, { start: table.start, end: table.end })
    previous = id
  }
  if (Object.keys(servers).some(id => !blocks.has(id))) return null
  return blocks
}

function serverText(id, data, eol) {
  return toml.stringify({ mcp_servers: { [id]: data } }).trimEnd().replace(/\n/g, eol)
}

function patch(raw, before, after) {
  const blocks = blocksOf(raw, before)
  if (!blocks) return null
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const edits = []
  for (const [id, block] of blocks) {
    if (equal(before[id], after[id])) continue
    const ending = raw.slice(block.start, block.end).endsWith('\n') ? eol : ''
    edits.push({ ...block, text: Object.hasOwn(after, id) ? serverText(id, after[id], eol) + ending : '' })
  }
  const added = Object.keys(after).filter(id => !Object.hasOwn(before, id))
  if (added.length) {
    const at = [...blocks.values()].at(-1)?.end ?? raw.length
    // \u8DDF\u4E0A\u4E00\u6BB5\u4E4B\u9593\u7A7A\u4E00\u884C\uFF08\u6C92\u63DB\u884C\u7D50\u5C3E\u7684\u5148\u88DC\u63DB\u884C\uFF09\uFF1B\u6A94\u982D\u6216\u53EA\u6709 BOM \u5C31\u4E0D\u7A7A
    const prefix = at === 0 || raw[at - 1] === '\uFEFF' ? '' : raw[at - 1] === '\n' ? eol : eol + eol
    const suffix = at < raw.length || raw.endsWith('\n') ? eol : ''
    edits.push({ start: at, end: at, text: prefix + added.map(id => serverText(id, after[id], eol)).join(eol + eol) + suffix })
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    raw = raw.slice(0, edit.start) + edit.text + raw.slice(edit.end)
  }
  return raw
}

function matches(text, original, expected) {
  try {
    const { mcp_servers: actualServers = {}, ...actualRest } = parse(text)
    const { mcp_servers: ignored, ...originalRest } = original
    void ignored
    return equal(actualServers, expected.mcp_servers || {}) && equal(actualRest, originalRest)
  } catch {
    return false
  }
}

function editMcpToml(raw, expected) {
  const original = parse(raw)
  let text = null
  try { text = patch(raw, original.mcp_servers || {}, expected.mcp_servers || {}) } catch { /* 不確定邊界就整份重寫 */ }
  if (text !== null && matches(text, original, expected)) return text
  try {
    text = toml.stringify(expected)
    if (matches(text, original, expected)) return text
  } catch { /* 下面統一回固定錯誤，解析器內容不外傳 */ }
  throw new Error('MCP_HOME_TOML_STRINGIFY')
}

module.exports = { editMcpToml }
