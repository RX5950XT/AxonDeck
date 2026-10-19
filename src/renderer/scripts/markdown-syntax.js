/** markdown.js 用的語法比對式（拆出來只是讓主檔短一點） */

/** 允許建成外連 <a> 的協定 */
export const SAFE_PROTO = /^(?:https?:|mailto:)/i
/** 有協定（`x:`）或 `//` 開頭；都沒有的是專案內相對路徑 */
export const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i

/** 區塊遞迴上限（引用、清單、details 互相包），防惡意深度 */
export const MAX_DEPTH = 8

export const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
export const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*)$/
export const RE_SETEXT = /^ {0,3}(=+|-+)\s*$/
export const RE_HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,}|(?:- ){2,}-|(?:\* ){2,}\*)\s*$/
export const RE_QUOTE = /^ {0,3}>\s?/
export const RE_BULLET = /^ {0,3}[-*+]\s+(.*)$/
export const RE_ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/
/** 清單項目：1 縮排 2 記號 3 記號後的空白 4 內容 */
export const RE_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/
export const RE_TASK = /^\[([ xX])\](?:\s+|$)/
export const RE_ALERT = /^\s*\[!(note|tip|important|warning|caution)\]\s*$/i
export const RE_TABLE_SEP = /^ {0,3}\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/
export const RE_LINK_DEF = /^ {0,3}\[([^\]^][^\]]*)\]:\s*(<[^>\n]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/
export const RE_NOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:\s?(.*)$/
export const RE_MATH_OPEN = /^ {0,3}\$\$(.*)$/
export const RE_MATH_CLOSE = /^(.*?)\$\$\s*$/
/** 區塊 HTML 的開頭：`<tag`、`</tag`、`<!--` */
export const RE_HTML_START = /^ {0,3}<(?:\/?[A-Za-z][\w-]*(?:[\s/>]|$)|!--)/

export const ALERTS = { note: '備註', tip: '提示', important: '重要', warning: '警告', caution: '注意' }

/**
 * 行內語法。群組編號是 renderInline／appendToken 分派的依據，改順序要一起改。
 * renderInline 會遞迴，**不可共用同一個 g-regex 實例**（子呼叫重置 lastIndex → 外層從頭再跑 → 無限迴圈）。
 * 連結文字允許一層方括號，`[![徽章](圖)](連結)` 才接得起來。
 */
export const INLINE_SRC = [
  /``(?!`)([^\n]+?)``(?!`)/, // 1 雙反引號行內碼（內容可含 `）
  /`([^`\n]+)`/, // 2 行內碼
  /!?\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]+>|[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\s*(?:"[^"\n]*"\s*)?\)/, // 3 文字 4 URL
  // 標記內側不得為空白，否則 `2 * 3 * 4`、`a ** b` 會被當成強調
  /\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/, // 5 粗體
  /(?<!\w)__(?!\s)([^\n]+?)(?<!\s)__(?!\w)/, // 6 粗體
  /~~(?!\s)([^\n]+?)(?<!\s)~~/, // 7 刪除線
  /(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/, // 8 斜體
  /(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/, // 9 斜體
  /<(br|hr|img)\b([^<>]*?)\/?>/, // 10 標籤 11 屬性（文件模式）
  /<(?<tag>kbd|sub|sup|b|i|strong|em|u|s|del|ins|mark|small|span|a|code)\b([^<>]*)>(.*?)<\/\k<tag>>/, // 12 13 14
  /\\([!-/:-@[-`{-~])/, // 15 跳脫的標點
  /<((?:https?:\/\/|mailto:)[^\s<>]+)>/, // 16 角括號自動連結
  // 17 直接貼的網址：只收 ASCII（後面直接接中文、全形標點很常見），句尾標點不算
  /(?<![\w/@.:-])((?:https?:\/\/|www\.)[!#-;=?-~]+(?<![.,:;'!?*_~)\]]))/,
  /!?\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\](?:\[([^\]\n]*)\])?/, // 18 文字 19 參考名（也接腳註 [^x]）
  /:([a-z0-9_+-]+):/, // 20 emoji
  /\$\$([^\n]+?)\$\$/, // 21 行內的獨立公式（文件模式）
  /(?<![\\\w$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/ // 22 行內公式（文件模式）
].map((re) => re.source).join('|')
