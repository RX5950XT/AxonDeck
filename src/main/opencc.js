/**
 * AxonDeck - 簡體→台灣繁體轉換（opencc-js，lazy 單例）
 * ASR 來源與翻譯輸出共用，避免 0.8B 譯文夾簡體字。
 */

/** twp = 字形＋台灣詞彙；tw = 僅字形 */
let toTwp = null
let toTw = null

function ensure() {
  if (toTwp) return
  const OpenCC = require('opencc-js')
  toTwp = OpenCC.Converter({ from: 'cn', to: 'twp' })
  toTw = OpenCC.Converter({ from: 'cn', to: 'tw' })
}

/**
 * 簡體轉繁體（台灣用語）。
 * **已是繁體的文字不套詞彙表**：twp 會把正確的「參數」竄改成「引數」、
 * 「記憶體參數設定」→「記憶體引數設定」，等於竄改譯文內容。
 * 先用純字形轉換探測：無變化＝沒有簡體字 → 原樣回傳。
 * @param {string} text
 * @returns {string}
 */
function s2twp(text) {
  if (!text) return text
  ensure()
  const shaped = toTw(text)
  // 詞彙表把「证明了」斷成「證／明了」，「明了」又換成「明瞭」；動詞「X明」後面的「了」改回來
  return shaped === text ? text : toTwp(text).replace(/([證說表聲查闡指標發])明瞭/g, '$1明了')
}

/** 日文新字體表裡、臺灣繁中本來就在用的字（jp→t 會把它們改成異體或別的字） */
const TW_VALID_KANJI = new Set('並予併即凜晃概欠研真翻缶芸萌郎緒鎮衛褒餅瓶桝槙弁台余岳沪祢為偽痴秘')
let fromJp = null

/**
 * 繁中譯文裡混進的日文新字體（補関數→補關數）逐字換回繁體。
 * 逐字轉、不走詞組，避免 jp 詞彙表改到中文詞。
 * @param {string} text
 * @returns {string}
 */
function jpKanjiToTw(text) {
  if (!text) return text
  if (!fromJp) fromJp = require('opencc-js').Converter({ from: 'jp', to: 't' })
  return Array.from(text, (char) => (/\p{Script=Han}/u.test(char) && !TW_VALID_KANJI.has(char) ? fromJp(char) : char)).join('')
}

/**
 * 目標語為繁中時，僅對「像中文、非日韓」的來源做 s2twp。
 * 不可只看 lang==='zh-TW'：日文漢字會被 opencc 弄髒（国→國 等）。
 * 兩支本地 ASR（sherpa／llama-server）都要用同一份判斷，所以放在這裡共用。
 * @param {string} text
 * @param {string} lang
 * @returns {boolean}
 */
function shouldS2twpSource(text, lang) {
  if (lang !== 'zh-TW' || !text) return false
  if (/[ぁ-ヿ가-힯]/.test(text)) return false
  const cjkCount = (text.match(/[一-鿿]/g) || []).length
  return cjkCount / Math.max(1, text.length) >= 0.3
}

module.exports = { s2twp, jpKanjiToTw, shouldS2twpSource }
