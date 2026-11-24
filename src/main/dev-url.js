'use strict'

/**
 * 開發模式載入的 vite 網址。預設 5173；e2e 會用 AXONDECK_DEV_URL 指到自己開的埠，
 * 免得 5173 被別的專案佔走時載到別人的頁面。只收本機 http，不讓環境變數把 preload 交給外部網站。
 */
function devUrl(value = process.env.AXONDECK_DEV_URL) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/') return url.origin
  } catch { /* 沒設或格式不對就用預設 */ }
  return 'http://localhost:5173'
}

module.exports = { DEV_URL: devUrl(), devUrl }
