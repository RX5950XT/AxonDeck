'use strict'

const path = require('path')

/**
 * Windows PowerShell 5.1 的絕對路徑。不靠 PATH 找 `powershell`：PATH 可能被改、
 * 也可能先找到同名的別的程式。SystemRoot 每次呼叫才讀（測試會換）。
 * @returns {string}
 */
function powershellExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 包成 PowerShell 單引號字串。PowerShell 把 U+2018–U+201B 也當單引號，一起重複跳脫。
 * @param {unknown} value
 * @returns {string}
 */
function psQuote(value) {
  return `'${String(value).replace(/['\u2018-\u201b]/g, '$&$&')}'`
}

module.exports = { powershellExe, psQuote }
