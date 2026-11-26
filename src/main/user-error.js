'use strict'

/**
 * 帶錯誤代碼與給使用者看的中文訊息的 Error。message 只放代碼（log 用），
 * 對外只送 userMessage，免得內部細節（路徑、上游原文）漏到畫面上。
 * @param {string} code
 * @param {string} [userMessage]
 * @returns {Error & { code: string, userMessage?: string }}
 */
function fail(code, userMessage) {
  return Object.assign(new Error(code), { code, userMessage })
}

module.exports = { fail }
