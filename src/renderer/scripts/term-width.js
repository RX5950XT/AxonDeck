/**
 * 讓 xterm 算字寬的方式跟 ConPTY（系統 conhost）一模一樣。
 *
 * 畫面是 ConPTY 照「它自己的格子」送過來的：它以為某個字佔 2 格、xterm 卻算 1 格，
 * 那一行後面的字就全部左移一格，接近行尾的那行在 ConPTY 那邊折行、xterm 這邊沒折，
 * 底下整片差一列——之後 CLI 的局部重畫全部落在錯的列上，畫面就疊出好幾份重複的行。
 *
 * 實測（Windows 11 26200 內建 conhost，逐字送 DSR 問游標位置，共 1.8 萬個碼位）跟
 * Unicode 11 表只差三類：
 * - Unicode 11 算 0 格的（組合附加符號、ZWJ、零寬空白、VS15／VS16 變體符號、BOM、
 *   雙向控制字元…）ConPTY 一律佔 1 格——所以 `⚠️`、`✔️`、`❤️` 在它那邊是 2 格；
 * - 國旗用的區域指示符號與 Unicode 12 之後的新 emoji ConPTY 算 2 格；
 * - 兩個 emoji（🤻、🥆）反過來算 1 格。
 * 下面兩張表就是實測差異，其餘沿用 Unicode 11。
 */
import { Unicode11Addon } from '../../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs'

const WIDE = [
  [0x302a, 0x302d], [0x3099, 0x309a], [0x31bb, 0x31bf], [0x1f1e6, 0x1f1ff],
  [0x1f6d6, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6fb, 0x1f6fc], [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f90c], [0x1f972, 0x1f972], [0x1f977, 0x1f979], [0x1f9a3, 0x1f9a4],
  [0x1f9ab, 0x1f9ad], [0x1f9cb, 0x1f9cc], [0x1fa74, 0x1fa77], [0x1fa7b, 0x1fa7c],
  [0x1fa83, 0x1fa88], [0x1fa96, 0x1fabd], [0x1fabf, 0x1fac5], [0x1face, 0x1fadb],
  [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8]
]
const NARROW = new Set([0x1f93b, 0x1f946])

// 只是借 addon 的 Unicode 11 表來查；activate 只會呼叫 `unicode.register` 一次
let unicode11 = null
new Unicode11Addon().activate(/** @type {any} */ ({ unicode: { register: provider => { unicode11 = provider } } }))

/** @param {number} cp */
function isWide(cp) {
  if (cp < 0x302a) return false
  return WIDE.some(([from, to]) => cp >= from && cp <= to)
}

/**
 * @param {number} cp
 * @returns {0 | 1 | 2}
 */
export function conptyWidth(cp) {
  if (cp < 32) return 0
  if (isWide(cp)) return 2
  if (NARROW.has(cp)) return 1
  return unicode11.wcwidth(cp) || 1
}

/** xterm 的 `IUnicodeVersionProvider`；ConPTY 沒有零寬字，所以永遠不跟前一格黏在一起 */
export const CONPTY_UNICODE = {
  version: 'conpty',
  wcwidth: conptyWidth,
  /** @param {number} cp */
  charProperties: cp => (conptyWidth(cp) & 3) << 1
}
