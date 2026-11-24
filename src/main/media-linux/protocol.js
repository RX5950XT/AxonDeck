'use strict'

/**
 * Linux 播放頁的媒體來源 `axd-player://<token>/<item id>`，邊讀邊送（支援 Range，拖得動進度條）。
 *
 * 跟工作區的 `vi-media://` 分開，因為：
 * - 只送「目前播放清單裡」的檔案：網址只有隨機 id，沒有路徑，猜不到也換不到別的檔
 * - 播放器要的容器（mkv／mov／opus…）比預覽多，不想因此放寬工作區預覽（Windows 也共用那張表）
 */

const crypto = require('crypto')
const { Readable } = require('stream')
const rawFs = require('../raw-fs')
const { parseRange } = require('../workspace/media')

const SCHEME = 'axd-player'
const TOKEN = crypto.randomBytes(16).toString('hex')
const PRIVILEGES = { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }

/** @type {Map<string, { path: string, mime: string }>} */
const allowed = new Map()

/**
 * 換播放清單：舊的 id 全部作廢。
 * @param {Array<{ path: string, mime: string }>} items
 * @returns {string[]} 每一首的網址（不是 HTML5 能播的回空字串）
 */
function publish(items) {
  allowed.clear()
  return items.map((item) => {
    if (!item.mime) return ''
    const id = crypto.randomBytes(9).toString('hex')
    allowed.set(id, { path: item.path, mime: item.mime })
    return `${SCHEME}://${TOKEN}/${id}`
  })
}

/**
 * @param {string} url
 * @param {{ method: string, headers: { get(name: string): string | null } }} request
 */
async function respond(url, request) {
  const u = new URL(url)
  if (u.hostname !== TOKEN) return new Response(null, { status: 404 })
  const entry = allowed.get(u.pathname.slice(1))
  if (!entry) return new Response(null, { status: 404 })
  const stat = await rawFs.promises.stat(entry.path).catch(() => null)
  if (!stat?.isFile()) return new Response(null, { status: 404 })
  const size = stat.size
  const headers = { 'Content-Type': entry.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  const { start, end } = range || { start: 0, end: size - 1 }
  headers['Content-Length'] = String(size ? end - start + 1 : 0)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  if (request.method === 'HEAD' || !size) return new Response(null, { status: range ? 206 : 200, headers })
  const body = Readable.toWeb(rawFs.createReadStream(entry.path, { start, end }))
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** @param {Electron.Protocol} protocol */
function register(protocol) {
  protocol.handle(SCHEME, async (request) => {
    try {
      return await respond(request.url, request)
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

module.exports = { SCHEME, TOKEN, PRIVILEGES, publish, respond, register }
