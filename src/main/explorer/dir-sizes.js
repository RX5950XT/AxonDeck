'use strict'

/**
 * 清單裡子資料夾的大小（Main Process）。
 *
 * 開了「資料夾大小」時，renderer 進一個資料夾就叫 `scan`：背景一個一個算子資料夾（走 size.measure，
 * 有 axondeck-probe.exe 就用原生版），算好的記在 `cache`；`listDir` 帶 `dirSizes` 時用 `apply` 套進
 * entry.size，排序與顯示就跟檔案一樣。左右欄各一條 lane，同一條 lane 新請求取消舊的。
 * 不跟 symlink／junction 走（readdir 的 isDirectory 對它們是 false）。
 */

const fsp = require('../raw-fs').promises
const path = require('path')
const paths = require('./paths')
const size = require('./size')

/** 5 分鐘內算過的不重算，過期再進來就重算。 */
const FRESH_MS = 5 * 60_000
/** 單一子資料夾上限；超過顯示「至少」。 */
const PER_DIR_MS = 20_000
const MAX_CACHE = 20_000

/** @type {Map<string, { bytes: number, incomplete: boolean, at: number }>} 小寫路徑 → 大小 */
const cache = new Map()
let version = 0
/** @type {Map<string, { token: string, cancelled: boolean, kill?: (() => void) | null }>} */
const lanes = new Map()

function laneOf(raw) {
  return raw === 'second' ? 'second' : 'main'
}

function remember(full, out) {
  const key = full.toLowerCase()
  cache.delete(key)
  cache.set(key, { bytes: Number(out.bytes) || 0, incomplete: Boolean(out.incomplete), at: Date.now() })
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  version += 1
}

/**
 * 把算過的資料夾大小套進 entries（不改原物件）。
 * @param {object[]} entries
 * @returns {object[]}
 */
function apply(entries) {
  if (!cache.size) return entries
  return entries.map((entry) => {
    if (!entry || !entry.dir || entry.link) return entry
    const hit = cache.get(String(entry.path || '').toLowerCase())
    return hit ? { ...entry, size: hit.bytes, sizeIncomplete: hit.incomplete } : entry
  })
}

/** @param {unknown} lane */
function cancel(lane) {
  const key = laneOf(lane)
  const job = lanes.get(key)
  if (job) size.cancelJob(job)
  lanes.delete(key)
  return true
}

/**
 * @param {unknown} dirPath
 * @param {unknown} lane 'main' | 'second'
 * @param {{ exe?: string, onProgress: (info: object) => void }} opts
 */
async function scan(dirPath, lane, opts) {
  const key = laneOf(lane)
  cancel(key)
  const job = { token: key, cancelled: false }
  lanes.set(key, job)
  const full = paths.resolveExisting(dirPath)
  let dirents
  try {
    dirents = await fsp.readdir(full, { withFileTypes: true })
  } catch {
    if (lanes.get(key) === job) lanes.delete(key)
    throw paths.fail('READ_FAILED', '讀不到這個資料夾')
  }
  const now = Date.now()
  const todo = dirents
    .filter((d) => d.isDirectory())
    .map((d) => path.join(full, d.name))
    .filter((child) => {
      const hit = cache.get(child.toLowerCase())
      return !hit || now - hit.at > FRESH_MS
    })
  for (const child of todo) {
    if (job.cancelled) break
    try {
      const out = await size.measure(child, job, { exe: opts.exe, maxMs: PER_DIR_MS })
      // 被取消的那一個只算到一半，不記
      if (job.cancelled) break
      remember(child, out)
      opts.onProgress({ path: full, lane: key, child, bytes: out.bytes, done: false })
    } catch {
      // 沒權限的子資料夾略過，維持「—」
    }
  }
  if (lanes.get(key) === job) lanes.delete(key)
  opts.onProgress({ path: full, lane: key, done: true, cancelled: job.cancelled })
  return { path: full, cancelled: job.cancelled }
}

module.exports = {
  scan,
  cancel,
  apply,
  version: () => version
}
