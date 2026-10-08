'use strict'

/**
 * Linux 本機資料夾樹檔名搜尋（UFFS 替代）。
 * 只走目前工作區／指定 root，不掃整機；支援取消與掃描上限。
 */

const path = require('path')
const fsp = require('../raw-fs').promises
const { resolveAbs, fail } = require('./paths')
const { sanitizeSearchFilters, matchesSearchFilters } = require('./search-filter')
const { rankHits } = require('./rank')

const SEARCH_LIMIT = 200
/** 走訪上限（含未命中），避免超大樹卡住 UI。 */
const SEARCH_SCAN_LIMIT = 2000
const MAX_DEPTH = 24
const YIELD_EVERY = 48
/** 常見超大目錄：不遞迴進去（檔名本身仍可比對）。 */
const SKIP_DESCEND = new Set([
  '.git', 'node_modules', '.cache', '__pycache__', '.npm', '.yarn',
  '.turbo', '.next'
])

/**
 * @param {string} pattern
 * @returns {(name: string) => boolean}
 */
function compileMatcher(pattern) {
  const q = String(pattern || '').trim()
  if (/[*?]/.test(q) && !/[\\/]/.test(q)) {
    let body = ''
    for (const ch of q) {
      if (ch === '*') body += '.*'
      else if (ch === '?') body += '.'
      else if (/[.+^${}()|[\]\\]/.test(ch)) body += `\\${ch}`
      else body += ch
    }
    const re = new RegExp(`^${body}$`, 'i')
    return (name) => re.test(name)
  }
  const needle = q.toLowerCase()
  return (name) => String(name).toLowerCase().includes(needle)
}

/**
 * @param {unknown} raw
 * @param {unknown} rawFilters
 * @param {{ isCancelled?: () => boolean }} [opts]
 * @returns {Promise<{ hits: object[], truncated: boolean, warming: boolean, cancelled?: boolean, filters?: object }>}
 */
async function searchLocal(raw, rawFilters, opts = {}) {
  if (typeof raw !== 'string') throw fail('BAD_QUERY', '搜尋條件不合法')
  const pattern = raw.trim()
  if (!pattern || pattern.length > 200) throw fail('BAD_QUERY', '搜尋條件不合法')
  if (pattern.includes('\0') || pattern.startsWith('>') || pattern.startsWith('-')) {
    throw fail('BAD_QUERY', '搜尋條件不合法')
  }

  const filters = sanitizeSearchFilters(rawFilters)
  const rootRaw = filters.root || filters.location
  if (!rootRaw) throw fail('BAD_PATH', '請先開啟一個資料夾再搜尋')

  let root
  try {
    root = resolveAbs(rootRaw)
  } catch {
    throw fail('BAD_PATH', '搜尋根目錄不合法')
  }

  try {
    const st = await fsp.stat(root)
    if (!st.isDirectory()) throw fail('BAD_PATH', '搜尋根目錄不合法')
  } catch (err) {
    if (err && err.code === 'BAD_PATH') throw err
    throw fail('BAD_PATH', '搜尋根目錄不存在')
  }

  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false
  const match = compileMatcher(pattern)
  /** @type {object[]} */
  const hits = []
  let scanned = 0
  let truncated = false
  /** @type {{ dir: string, depth: number }[]} */
  const queue = [{ dir: root, depth: 0 }]
  let sinceYield = 0

  while (queue.length) {
    if (isCancelled()) {
      return { hits: [], truncated: false, warming: false, cancelled: true, filters }
    }
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const ent of entries) {
      if (isCancelled()) {
        return { hits: [], truncated: false, warming: false, cancelled: true, filters }
      }
      const name = ent.name
      if (!name || name === '.' || name === '..') continue

      // 不跟著 symlink 走，避免環與掃到樹外。
      if (ent.isSymbolicLink()) continue

      const full = path.join(dir, name)
      const isDir = ent.isDirectory()
      scanned += 1
      if (scanned > SEARCH_SCAN_LIMIT) {
        truncated = true
        break
      }

      if (match(name)) {
        let size = 0
        let mtimeMs = 0
        let dirFlag = isDir
        try {
          const st = await fsp.stat(full)
          size = Number(st.size) || 0
          mtimeMs = Number(st.mtimeMs) || 0
          dirFlag = st.isDirectory()
        } catch {
          // 列得到但 stat 失敗仍可回檔名命中
        }
        const hit = {
          name,
          path: full,
          dir: dirFlag,
          size: dirFlag ? 0 : size,
          mtimeMs,
          ext: dirFlag ? '' : path.extname(name).slice(1).toLowerCase()
        }
        if (matchesSearchFilters(hit, filters)) {
          hits.push(hit)
          if (hits.length >= SEARCH_LIMIT) {
            truncated = true
            break
          }
        }
      }

      if (isDir && depth < MAX_DEPTH && !SKIP_DESCEND.has(name)) {
        queue.push({ dir: full, depth: depth + 1 })
      }

      sinceYield += 1
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    if (truncated) break
  }

  return {
    hits: rankHits(pattern, hits),
    truncated,
    warming: false,
    filters
  }
}

module.exports = {
  SEARCH_LIMIT,
  SEARCH_SCAN_LIMIT,
  MAX_DEPTH,
  SKIP_DESCEND,
  compileMatcher,
  searchLocal
}
