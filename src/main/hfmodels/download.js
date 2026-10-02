'use strict'

/**
 * 下載一顆模型（多 GB、可能好幾片）。
 *
 * 三件事是這裡的重點，其餘一律從簡：
 *   1. **續傳**：寫進 `<檔名>.part`，中斷後帶 `Range` 從斷點接。多 GB 的東西斷一次就重來，
 *      使用者只會覺得這個功能不能用。上游不支援 Range（回 200 不是 206）就從頭來，不硬接。
 *   2. **大小要對得上**：截斷的 gguf 不會在下載時報錯，只會在**載入時**變成一句看不懂的錯誤。
 *      HF 的 tree 端點給得出每個檔案的真實大小，收完比一次。
 *   3. **取消要真的停**：`AbortController` 一路傳到 fetch，`.part` 留著給下次續傳。
 *
 * ponytail: 只比大小不驗雜湊。HF 的 `lfs.oid` 就是內容的 sha256，真的遇到「大小對但內容壞」
 * 再把它接上（成本是整顆檔案再讀一遍）。
 */

const fs = require('fs')
const path = require('path')
const { pipeline } = require('node:stream/promises')

const TIMEOUT_MS = 60_000
/** 進度回報節流：多 GB 的下載每個 chunk 都送一次等於在洗 IPC */
const PROGRESS_INTERVAL_MS = 250
const RANGE_BYTES = 8 * 1024 * 1024
const CONNECTIONS = 4

/** 先沿用單連線；首 MB 已達 8MB/s 就繼續，慢線路才切四連線。 */
async function* adaptiveChunks(response, options) {
  const started = Date.now()
  let sampled = 0
  const reader = response.body[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await reader.next()
      if (next.done) return
      sampled += next.value.length
      yield next.value
      if (sampled < 1024 * 1024 && Date.now() - started < 1000) continue
      if (sampled / Math.max(1, Date.now() - started) >= 8 * 1024) {
        while (true) { const rest = await reader.next(); if (rest.done) return; yield rest.value }
      }
      await reader.return()
      yield* parallelChunks(options.url, options.headers, options.total,
        options.offset + sampled, options.validator, options.fetchImpl, options.signal)
      return
    }
  } finally { await reader.return?.() }
}

/** 有界分段：最多四個 8MB 留在記憶體，依原順序寫進既有 .part。 */
async function* parallelChunks(url, headers, total, offset, validator, fetchImpl, signal) {
  const group = new AbortController()
  const abort = () => group.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) group.abort()
  try {
    while (offset < total) {
      const requests = []
      for (let i = 0; i < CONNECTIONS && offset < total; i++) {
        const start = offset, end = Math.min(total - 1, start + RANGE_BYTES - 1)
        offset = end + 1
        requests.push(readRange(url, headers, start, end, total, validator, fetchImpl, group.signal))
      }
      let buffers
      try { buffers = await Promise.all(requests) }
      catch (error) { group.abort(); await Promise.allSettled(requests); throw error }
      for (const buffer of buffers) yield buffer
    }
  } finally {
    group.abort()
    signal.removeEventListener('abort', abort)
  }
}

async function readRange(url, headers, start, end, total, validator, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const rangeSignal = AbortSignal.any([signal, timeout])
  let response
  try {
    response = await fetchImpl(url, { headers: {
      ...headers, range: `bytes=${start}-${end}`, 'if-range': validator
    }, signal: rangeSignal })
    if (response.status !== 206
      || response.headers.get('content-range') !== `bytes ${start}-${end}/${total}`
      || (response.headers.get('content-encoding') || 'identity') !== 'identity') {
      throw new Error('分段下載不可用')
    }
    const chunks = []
    let received = 0
    for await (const chunk of response.body) {
      received += chunk.length
      if (received > end - start + 1) throw new Error('分段大小不正確')
      chunks.push(Buffer.from(chunk))
    }
    if (received !== end - start + 1) throw new Error('分段沒有完成')
    return Buffer.concat(chunks, received)
  } catch (error) {
    // 分段失敗就沿用已寫好的前段，退回單連線；取消仍直接結束。
    if (!signal.aborted) error.code = 'DOWNLOAD_RANGE_RETRY'
    throw error
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}

/**
 * @param {string} filePath
 * @returns {number}
 */
function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

/**
 * 下載單一檔案（支援續傳）
 *
 * @param {{
 *   url: string, dest: string, expectedBytes?: number,
 *   headers?: Record<string, string>, signal?: AbortSignal,
 *   onProgress?: (info: { received: number, total: number }) => void,
 *   fetchImpl?: typeof fetch, maxBytes?: number, parallel?: boolean
 * }} options
 * @returns {Promise<{ bytes: number, resumed: boolean }>}
 */
async function downloadSingle(options) {
  const { url, dest } = options
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('下載網址不正確')
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (options.signal?.aborted) throw new Error('下載已取消')
  const part = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  let already = sizeOf(part)
  const expected = Number(options.expectedBytes) || 0
  if (expected && sizeOf(dest) === expected) return { bytes: expected, resumed: true }
  if (expected && already > expected) {
    // 上次寫壞了（或換了一版檔案），接下去只會拿到一個大小對不上的檔案
    fs.rmSync(part, { force: true })
    already = 0
  }
  if (expected && already === expected) {
    fs.renameSync(part, dest)
    return { bytes: already, resumed: true }
  }

  const headers = { ...(options.headers || {}), 'accept-encoding': 'identity' }
  if (already > 0) headers.range = `bytes=${already}-`

  // 逾時只管「連得上、開始吐資料」；下載本體有多久算多久，不能用一個 timeout 砍掉長連線
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) throw new Error('下載已取消')
    options.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal })
  } catch (error) {
    options.signal?.removeEventListener('abort', onAbort)
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (!response?.ok) {
    options.signal?.removeEventListener('abort', onAbort)
    await response?.body?.cancel?.().catch(() => {})
    throw new Error(`下載失敗（HTTP ${Number(response?.status) || 0}）`)
  }

  // 要了 Range 卻回 200 → 上游不支援續傳，這一份是從頭開始的整包
  let resumed = already > 0 && response.status === 206
  if (already > 0 && response.status !== 206) {
    fs.rmSync(part, { force: true })
    already = 0
    resumed = false
  }

  const total = expected
    || (Number(response.headers?.get?.('content-length')) || 0) + already
  const maxBytes = Number(options.maxBytes) || Infinity
  if (total > maxBytes) {
    options.signal?.removeEventListener('abort', onAbort)
    await response.body?.cancel?.().catch(() => {})
    throw new Error('下載檔案大小超過上限')
  }
  let received = already
  let lastReport = 0

  try {
    const etag = response.headers?.get?.('etag') || ''
    const validator = etag && !etag.startsWith('W/') ? etag : response.headers?.get?.('last-modified')
    const parallel = options.parallel !== false && total - already >= RANGE_BYTES * CONNECTIONS
      && response.headers?.get?.('accept-ranges') === 'bytes' && validator
      && (response.headers?.get?.('content-encoding') || 'identity') === 'identity'
    let source = response.body
    if (parallel) {
      if (options.parallel === true) {
        await response.body.cancel()
        source = parallelChunks(url, headers, total, already, validator, fetchImpl, controller.signal)
      } else {
        source = adaptiveChunks(response, { url, headers, total, offset: already,
          validator, fetchImpl, signal: controller.signal })
      }
    }
    await pipeline(source, async function* (chunks) {
      for await (const chunk of chunks) {
        received += chunk.length
        if (received > maxBytes) throw new Error('下載檔案大小超過上限')
        const now = Date.now()
        if (options.onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          options.onProgress({ received, total })
        }
        yield chunk
      }
    }, fs.createWriteStream(part, { flags: already > 0 ? 'a' : 'w' }), { signal: controller.signal })
  } catch (error) {
    options.signal?.removeEventListener('abort', onAbort)
    if (error.code === 'DOWNLOAD_RANGE_RETRY' && !options.signal?.aborted) {
      return downloadSingle({ ...options, parallel: false })
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }

  const finalBytes = sizeOf(part)
  if (total && finalBytes !== total) {
    // 留著 .part 讓下一次續傳；直接刪掉等於每次網路抖一下就從頭來
    throw new Error(`下載沒有完成（拿到 ${finalBytes} / 應為 ${total} 位元組）`)
  }
  fs.rmSync(dest, { force: true })
  fs.renameSync(part, dest)
  if (options.onProgress) options.onProgress({ received: finalBytes, total: finalBytes })
  return { bytes: finalBytes, resumed }
}

/** 只有官方 GitHub 提供 SHA-256 才使用公開鏡像；下載後仍驗完整檔案。 */
async function downloadFile(options) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/(?:download\/([^/]+)|latest\/download)\/([^/?]+)$/.exec(options.url)
  if (!match || options.fetchImpl || Object.keys(options.headers || {}).some(key => /^(authorization|cookie|x-api-key)$/i.test(key))) {
    return downloadSingle(options)
  }
  const { createHash } = require('node:crypto')
  const { MIRRORS, rankDownloadUrls } = require('../update-mirrors')
  let asset
  try {
    const release = match[3] ? `tags/${match[3]}` : 'latest'
    const response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/${release}`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
    })
    const json = response.ok ? await response.json() : null
    asset = json?.assets?.find(a => a.name === decodeURIComponent(match[4]))
  } catch { /* 官方 metadata 讀不到就直接用官方下載，不信任第三方 */ }
  if (!/^sha256:[a-f0-9]{64}$/.test(asset?.digest || '')) return downloadSingle(options)
  const canonical = asset.browser_download_url
  if (typeof canonical !== 'string' || !canonical.startsWith(`https://github.com/${match[1]}/${match[2]}/releases/download/`)) {
    return downloadSingle(options)
  }
  const urls = await rankDownloadUrls([...MIRRORS.map(prefix => prefix + canonical), canonical], { signal: options.signal })
  let lastError
  for (const url of urls) {
    if (options.signal?.aborted) throw new Error('下載已取消')
    let verifying = false
    try {
      const result = await downloadSingle({ ...options, url: String(url), expectedBytes: asset.size })
      verifying = true
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(options.dest)) {
        if (options.signal?.aborted) throw new Error('下載已取消')
        hash.update(chunk)
      }
      if (`sha256:${hash.digest('hex')}` !== asset.digest) {
        fs.rmSync(options.dest, { force: true })
        throw new Error('下載檔案驗證失敗')
      }
      return result
    } catch (error) {
      lastError = error
      if (options.signal?.aborted) {
        if (verifying && fs.existsSync(options.dest)) fs.renameSync(options.dest, `${options.dest}.part`)
        throw error
      }
    }
  }
  throw lastError
}

/**
 * 一個變體的所有檔案（分片 ＋ mmproj）逐一下載到同一個資料夾。
 *
 * **逐一、不併發**：多 GB 的檔案同時拉三份只會互相搶頻寬，而且進度條會變成一團看不懂的數字。
 *
 * @param {{
 *   files: Array<{ url: string, name: string, size?: number }>,
 *   dir: string, signal?: AbortSignal,
 *   headers?: Record<string, string>,
 *   onProgress?: (info: { received: number, total: number, fileIndex: number, fileCount: number, name: string }) => void,
 *   fetchImpl?: typeof fetch
 * }} options
 * @returns {Promise<{ bytes: number }>}
 */
async function downloadVariant(options) {
  const files = Array.isArray(options.files) ? options.files : []
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
  let doneBytes = 0
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    await downloadFile({
      url: file.url,
      dest: path.join(options.dir, file.name),
      expectedBytes: Number(file.size) || 0,
      headers: options.headers,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      onProgress: options.onProgress
        ? ({ received }) => options.onProgress({
          received: doneBytes + received,
          total: totalBytes,
          fileIndex: i,
          fileCount: files.length,
          name: file.name
        })
        : undefined
    })
    doneBytes += Number(file.size) || 0
  }
  return { bytes: doneBytes }
}

module.exports = { downloadFile, downloadVariant }
