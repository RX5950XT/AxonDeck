'use strict'

/**
 * 專案內全文搜尋（Main Process）。
 *
 * ponytail: 自己遞迴走目錄逐檔比對，**不依賴 ripgrep**——這台機器就沒裝 `rg`，
 * 而「多裝一個外部執行檔」跟「多寫一份找不到就退回自己走」都比現在這樣貴。
 * 個人專案的規模（跳掉 `.git`／`node_modules` 之後）實測就是幾百到幾千個檔案，
 * 夠用。真的大到會等，再換成 `rg`（在這裡加一條路徑就好，介面不用動）。
 *
 * 邊界一律在這裡收：`resolveIn` 決定走得到哪裡，其餘四個上限決定會不會把 UI 弄死。
 */

const fsp = require('../raw-fs').promises
const path = require('path')
const { StringDecoder } = require('string_decoder')
const files = require('./files')

/** 最多回幾筆命中（UI 一次也讀不完更多） */
const MAX_HITS = 200
/** 最多掃幾個檔案（防「不小心指到 C:\\」那種） */
const MAX_SCAN_FILES = 8000
/** 單檔超過這個大小就跳過（多半是打包產物或資料檔） */
const MAX_FILE_BYTES = 1024 * 1024
/** 整趟搜尋的時間上限 */
const TIMEOUT_MS = 15000
/** 命中那一行最多留幾個字（整行幾萬字的 minified 檔會塞爆 IPC） */
const MAX_LINE_CHARS = 200
let searchVersion = 0
let searchInflight = Promise.resolve()

function isStopped(state) {
  return Date.now() > state.deadline || (state.version !== undefined && state.version !== searchVersion)
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function fail(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

/**
 * 走一層目錄，把檔案推進 `out`。跳過的規則跟檔案總管同一份（`files.SKIP_DIRS`），
 * 這樣「搜尋找得到但檔案總管看不到」的怪事不會發生。
 *
 * @param {string} root
 * @param {string} dirFull
 * @param {string[]} out
 * @param {{ scanned: number, deadline: number }} state
 */
async function walk(root, dirFull, out, state) {
  if (out.length >= MAX_SCAN_FILES || isStopped(state)) return
  let dirents
  try {
    dirents = await fsp.readdir(dirFull, { withFileTypes: true })
  } catch {
    return // 沒權限的資料夾安靜跳過，不要讓整趟搜尋失敗
  }
  for (const dirent of dirents) {
    if (out.length >= MAX_SCAN_FILES || isStopped(state)) return
    const full = path.join(dirFull, dirent.name)
    if (dirent.isDirectory()) {
      if (files.SKIP_DIRS.has(dirent.name.toLowerCase())) continue
      await walk(root, full, out, state)
    } else if (dirent.isFile()) {
      out.push(full)
    }
    // symlink 一律不追（跟 listDir 同一條規則，免得繞著循環走）
  }
}

/**
 * @param {string} line
 * @param {number} at 命中位置
 * @returns {string}
 */
function trimLine(line, at) {
  if (line.length <= MAX_LINE_CHARS) return line
  const start = Math.max(0, at - Math.floor(MAX_LINE_CHARS / 3))
  return `${start > 0 ? '…' : ''}${line.slice(start, start + MAX_LINE_CHARS)}…`
}

/**
 * 在專案裡找一段文字。**純字串比對，不收 regex**——收 regex 等於讓 renderer
 * 送一個會災難性回溯的 pattern 把 main 卡死（ReDoS）。
 *
 * @param {string} root 專案根目錄
 * @param {unknown} rawQuery
 * @param {unknown} rawCaseSensitive
 * @returns {Promise<{ query: string, hits: Array<{ rel: string, line: number, text: string }>, truncated: boolean, scanned: number }>}
 */
async function search(root, rawQuery, rawCaseSensitive) {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : ''
  if (query.length < 2) throw fail('BAD_QUERY', '至少要輸入兩個字')
  if (query.length > 200) throw fail('BAD_QUERY', '搜尋字串太長')
  const version = ++searchVersion
  const previous = searchInflight
  const pending = (async () => {
    await previous.catch(() => {}) // 前一輪的錯誤由它自己的 caller 處理。
    return searchOnce(root, query, rawCaseSensitive, version)
  })()
  searchInflight = pending
  try { return await pending } finally {
    if (searchInflight === pending) searchInflight = Promise.resolve()
  }
}

async function searchOnce(root, query, rawCaseSensitive, version) {
  const caseSensitive = rawCaseSensitive === true
  const needle = caseSensitive ? query : query.toLowerCase()

  const base = files.resolveIn(root, '')
  const state = { scanned: 0, deadline: Date.now() + TIMEOUT_MS, version }
  /** @type {string[]} */
  const candidates = []
  await walk(root, base, candidates, state)

  /** @type {Array<{ rel: string, line: number, text: string }>} */
  const hits = []
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let truncated = candidates.length >= MAX_SCAN_FILES
  for (const full of candidates) {
    if (hits.length >= MAX_HITS || isStopped(state)) {
      truncated = true
      break
    }
    let stat
    try {
      stat = await fsp.stat(full)
    } catch {
      continue
    }
    if (isStopped(state)) break
    if (stat.size > MAX_FILE_BYTES) continue
    let fileHits
    try {
      fileHits = await scanFile(full, needle, caseSensitive, files.toRel(root, full), state, buffer, MAX_HITS - hits.length)
    } catch {
      continue
    }
    if (isStopped(state)) break
    if (fileHits === null) continue // 二進位檔沒有「行」可言
    state.scanned += 1
    hits.push(...fileHits)
    if (hits.length >= MAX_HITS) truncated = true
  }
  if (version !== searchVersion) return { query, hits: [], truncated: false, scanned: state.scanned, cancelled: true }
  return { query, hits, truncated: truncated || Date.now() > state.deadline, scanned: state.scanned }
}

/** 只保留正在比對的一行，避免把幾十萬行複製成兩大份陣列。 */
function scanLines(text, needle, caseSensitive, rel, hits, firstLine, limit) {
  let start = 0
  let lineNumber = firstLine
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(start, end)
    const at = (caseSensitive ? line : line.toLowerCase()).indexOf(needle)
    if (at >= 0 && hits.length < limit) {
      const snippet = trimLine(line.replace(/\r$/, ''), at)
      hits.push({ rel, line: lineNumber, text: Buffer.from(snippet).toString('utf8') })
    }
    if (newline < 0) break
    start = end + 1
    lineNumber += 1
  }
  return lineNumber
}

/** 固定 64KB 讀取；不保留整檔，也不讓短命中行抓住整份原文。 */
async function scanFile(full, needle, caseSensitive, rel, state, buffer, limit) {
  const handle = await fsp.open(full, 'r')
  const decoder = new StringDecoder('utf8')
  const hits = []
  let tail = ''
  let firstLine = 1
  let bytes = 0
  try {
    while (!isStopped(state)) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      bytes += bytesRead
      if (bytes > MAX_FILE_BYTES || buffer.subarray(0, bytesRead).includes(0)) return null
      const text = tail + decoder.write(buffer.subarray(0, bytesRead))
      const end = text.lastIndexOf('\n') + 1
      if (end) firstLine = scanLines(text.slice(0, end), needle, caseSensitive, rel, hits, firstLine, limit)
      tail = text.slice(end)
    }
    scanLines(tail + decoder.end(), needle, caseSensitive, rel, hits, firstLine, limit)
    return hits
  } finally { await handle.close() }
}

/**
 * 專案裡所有檔案的相對路徑，給「快速開檔」（Ctrl+P）用。
 *
 * 走的是跟全文搜尋同一份 `walk`，跳過的資料夾與上限都一致——
 * 「搜尋找得到但快速開檔找不到」這種怪事不會發生。清單只給路徑不讀內容，
 * 所以幾千個檔案也只是一趟 readdir。
 *
 * @param {string} root 專案根目錄
 * @returns {Promise<{ paths: string[], truncated: boolean }>}
 */
async function listFiles(root) {
  const base = files.resolveIn(root, '')
  const state = { scanned: 0, deadline: Date.now() + TIMEOUT_MS }
  /** @type {string[]} */
  const found = []
  await walk(root, base, found, state)
  return {
    paths: found.map((full) => files.toRel(root, full)),
    truncated: found.length >= MAX_SCAN_FILES || Date.now() > state.deadline
  }
}

module.exports = {
  MAX_HITS,
  MAX_SCAN_FILES,
  MAX_FILE_BYTES,
  MAX_LINE_CHARS,
  trimLine,
  search,
  listFiles
}
