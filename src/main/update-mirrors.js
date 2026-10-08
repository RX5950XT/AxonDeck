'use strict'

/**
 * GitHub Releases 的安裝檔在 APAC 常被 CDN 限速到幾十 KB/s（實測 ~50KB/s → 406MB 要一小時），
 * 同一支檔經公開反向代理可到 ~25MB/s。版本清單 latest.yml／latest-linux.yml 仍只從 GitHub 讀
 * （sha512 是信任根）；這裡只改寫 httpExecutor.download 拿到的安裝檔網址
 * （Windows .exe／Linux .AppImage），下完仍由 electron-updater 對雜湊。
 */

const fs = require('fs')

const OWNER = 'RX5950XT'
const REPO = 'AxonDeck'
/** 先代理、官方放最後。官方慢但會成功，排前面就永遠輪不到代理。 */
const MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/'
]
const ASSET_INSTALLER = new RegExp(
  `^https://github\\.com/${OWNER}/${REPO}/releases/download/[^/]+/[^/]+\\.(exe|AppImage)$`,
  'i'
)

function hrefOf(url) {
  if (url == null) return ''
  if (typeof url === 'string') return url
  if (typeof url.href === 'string') return url.href
  return String(url)
}

function toUrl(url) {
  return url instanceof URL ? url : new URL(hrefOf(url))
}

/**
 * @param {string | URL} url
 * @returns {URL[]}
 */
function downloadUrls(url) {
  const href = hrefOf(url)
  if (!ASSET_INSTALLER.test(href.split('?')[0])) return [toUrl(href || url)]
  return [...MIRRORS.map((prefix) => new URL(prefix + href)), new URL(href)]
}

/** 每次下載前取最多 256KB 實測兩條鏡像；最多等 3 秒，官方仍保留最後退路。 */
async function rankDownloadUrls(urls, options = {}) {
  if (urls.length < 2) return urls
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const mirrors = urls.slice(0, -1)
  const scores = await Promise.all(mirrors.map(async (url) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) controller.abort()
    const timer = setTimeout(abort, 3000)
    const started = Date.now()
    let bytes = 0
    let response
    try {
      response = await fetchImpl(String(url), {
        headers: { range: 'bytes=0-262143' }, signal: controller.signal
      })
      if (response.ok && response.body) {
        for await (const chunk of response.body) {
          bytes += Math.min(chunk.length, 262144 - bytes)
          if (bytes >= 262144) break
        }
      }
    } catch { /* 測速失敗仍留作後續退路 */ }
    finally {
      clearTimeout(timer)
      controller.abort()
      options.signal?.removeEventListener('abort', abort)
    }
    return { url, speed: bytes / Math.max(1, Date.now() - started) }
  }))
  scores.sort((a, b) => b.speed - a.speed)
  return [...scores.map(row => row.url), urls[urls.length - 1]]
}

/** 包住 electron-updater 的 download：前一跳失敗就刪半截檔再試下一個。 */
function downloadWithFallback(executor, deps = {}) {
  if (!executor || typeof executor.download !== 'function') return executor
  const orig = executor.download.bind(executor)
  executor.download = async (url, destination, options) => {
    const urls = await rankDownloadUrls(downloadUrls(url), deps)
    let lastErr
    for (const next of urls) {
      try {
        return await orig(next, destination, options)
      } catch (err) {
        lastErr = err
        try { fs.unlinkSync(destination) } catch { /* 還沒寫出檔 */ }
      }
    }
    throw lastErr
  }
  return executor
}

module.exports = {
  OWNER,
  REPO,
  MIRRORS,
  ASSET_INSTALLER,
  downloadUrls,
  rankDownloadUrls,
  downloadWithFallback
}
