'use strict'

/**
 * 大資料夾的原生列目錄：`axondeck-probe list-dir`（native/axondeck-probe/src/listdir.rs）。
 *
 * JS 版是 readdir＋逐檔 lstat＋殼層 sidecar 問隱藏屬性（sidecar 一次最多 2000 筆），
 * 3 萬項的資料夾要 1.6～3.5 秒；原生版一趟拿齊約 0.2 秒。叫一次 exe 要 13～20ms，
 * 所以只有項目夠多才值得（`fs.js` 判斷），小資料夾照舊。
 */

const { execFile } = require('../proc-broker')
const { resolveProbeExe } = require('../native-probe')

/** 超過這麼多項才走原生版 */
const NATIVE_MIN_ENTRIES = 300
const TIMEOUT_MS = 12000

/**
 * @param {string} full 已 resolve 的資料夾
 * @returns {Promise<Array<{ name: string, dir: boolean, link: boolean, size: number, mtimeMs: number, hidden: boolean }> | null>}
 *   沒有 exe、起不來或輸出壞掉回 null（交回 JS 版）
 */
function listNative(full) {
  const exe = resolveProbeExe()
  if (!exe) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(exe, ['list-dir', full], {
      windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        const rows = JSON.parse(stdout)
        resolve(Array.isArray(rows) ? rows.filter((row) => row && typeof row.name === 'string' && row.name) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

module.exports = { NATIVE_MIN_ENTRIES, listNative }
