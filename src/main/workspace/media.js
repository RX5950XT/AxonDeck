'use strict'

/**
 * 工作區的圖片／PDF／影音預覽走自訂協定 `vi-media://`，**邊讀邊送**。
 *
 * 以前是整份讀進來轉 base64 塞進 IPC（再變成 `data:` URI），記憶體是檔案的好幾倍，
 * 只能卡 2MB；影片也拖不了進度條。改成協定之後由 Chromium 自己發 Range 請求，
 * 幾 GB 的影片一樣只讀看得到的那一段。
 *
 * 安全：
 * - 網址的主機名是**每次啟動隨機產生的 token**，只透過主視窗的 `workspace:readFile` 發出去；
 *   內建瀏覽器（`<webview>`）裡的網頁猜不到它。
 * - 路徑一律經 `rootOf` ＋ `files.resolveIn`（跟讀檔同一個入口），只送媒體副檔名。
 */

const crypto = require('crypto')
const path = require('path')
const { Readable } = require('stream')
const rawFs = require('../raw-fs')
const files = require('./files')

const SCHEME = 'vi-media'
const TOKEN = crypto.randomBytes(16).toString('hex')

/**
 * HTML 預覽另用一組 token，主機名是 `<十六進位專案 id>.<SITE_TOKEN>`：每個專案一個來源，
 * `/assets/x.js` 這種根路徑解到專案根目錄。預覽頁跑的是專案裡的腳本，所以它拿得到的只有
 * 這個專案的網頁資源（下面的 SITE_MIME），拿不到上面那組媒體網址、也不回 CORS 標頭。
 */
const SITE_TOKEN = crypto.randomBytes(16).toString('hex')

const SITE_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
}

/** 編輯中還沒存的 HTML：預覽要看到手上這一版，不是磁碟上那版。只留最近幾份 */
const drafts = new Map()
const MAX_DRAFTS = 8
let siteVersion = 0

/** registerSchemesAsPrivileged 要的設定（必須在 app ready 之前註冊） */
const PRIVILEGES = { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }

/** pdf.js 是用 fetch 讀的（跨來源、帶 Range 標頭會先送 OPTIONS） */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
}

/**
 * 檔案總管的大預覽走這個假專案 id：後面接的是**絕對路徑**，由 `register` 收到的
 * `resolveLocal` 把關（檔案總管本來就讀得到那些路徑，這裡沒有放寬任何東西）。
 */
const LOCAL_ID = '~local'

/** Office 文件轉出來的 PDF／xlsx（`office-convert.js` 的快取），後面只接一個快取檔名 */
const OFFICE_ID = '~office'

/** @param {string} name 快取檔名 */
function officeUrlFor(name) {
  return `${SCHEME}://${TOKEN}/${OFFICE_ID}/${encodeURIComponent(name)}`
}

/**
 * @param {string} projectId
 * @param {string} rel 專案內的相對路徑（`/` 分隔）
 */
function urlFor(projectId, rel) {
  const encoded = String(rel).split('/').map(encodeURIComponent).join('/')
  return `${SCHEME}://${TOKEN}/${encodeURIComponent(projectId)}/${encoded}`
}

/**
 * 檔案總管的大預覽網址。整條絕對路徑當成一段，所以反斜線、空白、中文都不會被切壞。
 * @param {string} full 本機絕對路徑
 */
function localUrlFor(full) {
  return `${SCHEME}://${TOKEN}/${LOCAL_ID}/${encodeURIComponent(String(full || ''))}`
}

/**
 * 獨立編輯視窗的 Markdown 圖片基準網址：每層資料夾各一段，`![](img/a.png)` 這種相對路徑才解得開；
 * 收到時一樣走 `~local` 的 `resolveLocal` 把關，而且只送媒體副檔名。
 * @param {string} full 本機絕對路徑
 */
function localBaseFor(full) {
  return `${SCHEME}://${TOKEN}/${LOCAL_ID}/${String(full || '').split(/[\\/]/).map(encodeURIComponent).join('/')}`
}

/**
 * HTML 預覽網址。帶 `draft` 就先記住這份內容，這條路徑改送它；`?v=` 讓 iframe 每次都重新載入。
 * @param {string} projectId
 * @param {string} rel
 * @param {string} [draft]
 */
function siteUrlFor(projectId, rel, draft) {
  const key = `${projectId}\0${rel}`
  if (typeof draft === 'string') {
    drafts.delete(key)
    drafts.set(key, draft)
    if (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value)
  }
  const host = `${Buffer.from(projectId).toString('hex')}.${SITE_TOKEN}`
  const encoded = String(rel).split('/').map(encodeURIComponent).join('/')
  return `${SCHEME}://${host}/${encoded}?v=${++siteVersion}`
}

/**
 * 解析 `Range: bytes=a-b`。只支援單一區段（瀏覽器的媒體與 pdf.js 都只送一段）。
 * @param {string | null} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | 'invalid'} null＝沒有要 Range
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (!m[1] && !m[2])) return null
  let start
  let end
  if (m[1]) {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  } else {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/**
 * @param {string} full 已經過 resolveIn 的絕對路徑
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function serve(full, request, type = files.mediaMime(full), extra = CORS) {
  const stat = await rawFs.promises.stat(full)
  if (!stat.isFile()) return new Response(null, { status: 404 })
  const size = stat.size
  const headers = { ...extra, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  }
  const { start, end } = range || { start: 0, end: size - 1 }
  headers['Content-Length'] = String(size ? end - start + 1 : 0)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const body = size ? Readable.toWeb(rawFs.createReadStream(full, { start, end })) : null
  return new Response(body, { status: range ? 206 : 200, headers })
}

/**
 * HTML 預覽的一個請求：草稿優先，資料夾找 index.html，其餘只送 SITE_MIME／媒體副檔名。
 * @param {URL} url
 * @param {Request} request
 * @param {(projectId: string) => Promise<string>} rootOf
 */
async function serveSite(url, request, rootOf) {
  const projectId = Buffer.from(url.hostname.slice(0, -SITE_TOKEN.length - 1), 'hex').toString()
  const segments = url.pathname.slice(1).split('/').map(decodeURIComponent)
  // 點開頭的（.env、.git）不給：預覽頁跑的是專案裡的腳本
  if (segments.some((segment) => segment.startsWith('.'))) return new Response(null, { status: 404 })
  let rel = segments.filter(Boolean).join('/')
  const draft = drafts.get(`${projectId}\0${rel}`)
  if (draft !== undefined) return htmlResponse(Buffer.from(draft))
  const root = await rootOf(projectId)
  let full = files.resolveIn(root, rel)
  if ((await rawFs.promises.stat(full)).isDirectory()) {
    rel = rel ? `${rel}/index.html` : 'index.html'
    full = files.resolveIn(root, rel)
  }
  const type = SITE_MIME[path.extname(full).slice(1).toLowerCase()] || files.mediaMime(full)
  if (!type) return new Response(null, { status: 404 })
  if (type === SITE_MIME.html) return htmlResponse(await rawFs.promises.readFile(full))
  return await serve(full, request, type, {})
}

/**
 * 預覽頁的 Ctrl+滾輪：事件在 iframe 自己的 document 裡、外層收不到（不擋還會把整個 App 視窗放大），
 * 所以每份 HTML 塞這一小段，把滾輪量轉給外層的預覽縮放。
 */
const ZOOM_BRIDGE = '<script>addEventListener("wheel",function(e){if(!e.ctrlKey)return;e.preventDefault();'
  + 'parent.postMessage({axondeckZoom:e.deltaY},"*")},{passive:false})</script>'

/**
 * 塞在 `<head>` 後面（沒有就 doctype 後面）：塞到 doctype 前面會掉進 quirks mode。照位元組切，不動原本的編碼。
 * @param {Buffer} body
 */
function htmlResponse(body) {
  const text = body.toString('latin1')
  const tag = /<head\b[^>]*>/i.exec(text) || /<!doctype[^>]*>/i.exec(text)
  const at = tag ? tag.index + tag[0].length : 0
  const html = Buffer.concat([body.subarray(0, at), Buffer.from(ZOOM_BRIDGE), body.subarray(at)])
  return new Response(html, { headers: { 'Content-Type': SITE_MIME.html, 'Cache-Control': 'no-store' } })
}

/**
 * @param {Electron.Protocol} protocol
 * @param {(projectId: string) => Promise<string>} rootOf
 * @param {((full: string) => string) | undefined} [resolveLocal] 檔案總管的大預覽：
 *   把使用者給的絕對路徑驗過再回正規化的那一條（沒給就不開放 `~local`）
 */
function register(protocol, rootOf, resolveLocal) {
  protocol.handle(SCHEME, async (request) => {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      const url = new URL(request.url)
      if (url.hostname.endsWith(`.${SITE_TOKEN}`)) return await serveSite(url, request, rootOf)
      if (url.hostname !== TOKEN) return new Response(null, { status: 404 })
      const [projectId, ...segments] = url.pathname.slice(1).split('/').map(decodeURIComponent)
      // 檔案總管那一條：後面就是一整條絕對路徑，驗證交給呼叫端給的 `resolveLocal`
      if (projectId === LOCAL_ID) {
        if (typeof resolveLocal !== 'function') return new Response(null, { status: 404 })
        const target = resolveLocal(segments.join('/'))
        if (!files.mediaMime(target)) return new Response(null, { status: 404 })
        return await serve(target, request)
      }
      if (projectId === OFFICE_ID) return await serve(require('./office-convert').cachedPath(segments.join('/')), request)
      const root = await rootOf(projectId)
      const full = files.resolveIn(root, segments.join('/'))
      if (!files.mediaMime(full)) return new Response(null, { status: 404 })
      return await serve(full, request)
    } catch (error) {
      // 找不到專案／路徑越界／檔案不見都一樣回 404，不透露是哪一種
      console.warn('[workspace] 媒體預覽讀取失敗', error?.code || 'ERROR')
      return new Response(null, { status: 404 })
    }
  })
}

module.exports = { SCHEME, PRIVILEGES, LOCAL_ID, urlFor, siteUrlFor, officeUrlFor, localUrlFor, localBaseFor, parseRange, register }
