'use strict'

/**
 * 超過 Monaco 上限（256MB）的文字檔：唯讀、分段讀的檢視。
 *
 * 開檔時整份掃一遍，每 STEP 列記一個書籤（位元組位置＋第幾行），之後畫面要哪幾列
 * 就從最近的書籤往後讀那一小段——記憶體只跟「列數 / STEP」有關，10GB 的檔也只要幾 MB。
 *
 * 一「列」＝一行；太長的行每 MAX_ROW_BYTES 切成好幾列（壓成一行的 JSON 也看得到內容），
 * 切點往前退到字元邊界。吃 UTF-8（含不含 BOM 都行）與有 BOM 的 UTF-16 LE／BE。
 */

const fsp = require('./raw-fs').promises

const STEP = 1024
const MAX_ROW_BYTES = 4096
const CHUNK = 4 * 1024 * 1024
/** 一次最多要幾列：畫面再高也就一兩百列 */
const MAX_ROWS_PER_READ = 2000
const MAX_QUERY_CHARS = 1000
const EDGE_BYTES = 4096

function fail(code, message) {
  return Object.assign(new Error(code), { code, userMessage: message })
}

/**
 * unit＝一個碼元幾個位元組；UTF-16 的換行是 0A 00（LE）／00 0A（BE），而且只算落在偶數位置的。
 * @typedef {{ name: string, unit: 1 | 2, le: boolean, nl: Buffer, cr: Buffer, decoder: TextDecoder }} Enc
 */
const ENCODINGS = {
  utf8: { name: 'utf8', unit: 1, le: true, nl: Buffer.from([10]), cr: Buffer.from([13]), decoder: new TextDecoder('utf-8') },
  utf16le: { name: 'utf16le', unit: 2, le: true, nl: Buffer.from([10, 0]), cr: Buffer.from([13, 0]), decoder: new TextDecoder('utf-16le') },
  utf16be: { name: 'utf16be', unit: 2, le: false, nl: Buffer.from([0, 10]), cr: Buffer.from([0, 13]), decoder: new TextDecoder('utf-16be') }
}

/** 看 BOM 決定編碼與內容從哪個位元組開始 */
function sniff(head) {
  if (head[0] === 0xff && head[1] === 0xfe) return { enc: ENCODINGS.utf16le, start: 2 }
  if (head[0] === 0xfe && head[1] === 0xff) return { enc: ENCODINGS.utf16be, start: 2 }
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { enc: ENCODINGS.utf8, start: 3 }
  return { enc: ENCODINGS.utf8, start: 0 }
}

/** [s, end) 裡第一個換行（UTF-16 只認對齊的） */
function newlineIn(buf, s, end, enc) {
  const part = buf.subarray(s, end)
  if (enc.unit === 1) {
    const at = part.indexOf(10)
    return at < 0 ? -1 : s + at
  }
  for (let at = part.indexOf(enc.nl); at >= 0; at = part.indexOf(enc.nl, at + 1)) {
    if (at % 2 === 0) return s + at
  }
  return -1
}

/** 切點往前退到字元開頭：UTF-8 跳過延續位元組，UTF-16 不切開代理對 */
function backOff(buf, s, end, enc) {
  if (enc.unit === 1) {
    while (end > s + 1 && (buf[end] & 0xc0) === 0x80) end -= 1
    return end
  }
  const unit = enc.le ? buf[end] | (buf[end + 1] << 8) : (buf[end] << 8) | buf[end + 1]
  return unit >= 0xdc00 && unit <= 0xdfff && end > s + 2 ? end - 2 : end
}

/**
 * 從 `from`（一列的開頭）往後切列。規則開檔與讀列共用，兩邊才對得上。
 * @param {Buffer} buf
 * @param {number} from
 * @param {boolean} final 後面沒有資料了（最後不完整的一列也算一列）
 * @param {(start: number, end: number, endsLine: boolean, next: number) => boolean | void} onRow 回 true 就停
 * @param {Enc} enc
 * @returns {number} 還沒切完的那一列在 buf 裡的開頭（-1＝被 onRow 叫停）
 */
function scanRows(buf, from, final, onRow, enc) {
  let s = from
  while (s < buf.length) {
    const limit = s + MAX_ROW_BYTES
    // 只找到 limit 為止：整份沒換行（壓成一行的 JSON）時每列都搜到 buf 尾巴會變成平方級
    const nl = newlineIn(buf, s, Math.min(buf.length, limit + enc.unit), enc)
    let end, next, endsLine
    if (nl >= 0) {
      end = nl
      next = nl + enc.unit
      endsLine = true
    } else if (limit + enc.unit <= buf.length) {
      end = backOff(buf, s, limit, enc)
      next = end
      endsLine = false
    } else if (final) {
      end = buf.length
      next = buf.length
      endsLine = true
    } else {
      return s
    }
    if (onRow(s, end, endsLine, next)) return -1
    s = next
  }
  return s
}

/** 檔頭＋（前 size 位元組的）檔尾各一小段：下次重建時拿來判斷檔案是不是只往後長 */
async function edges(handle, size) {
  const n = Math.min(EDGE_BYTES, size)
  const buf = Buffer.alloc(n * 2)
  await handle.read(buf, 0, n, 0)
  await handle.read(buf, n, n, size - n)
  return buf
}

/**
 * 掃一遍建索引。給了上一份索引、而且檔案只是往後長（還在寫的 log），就從上一份最後一個書籤接著掃。
 * shortcut: 只比對檔頭檔尾各 4KB，中間被原地改、長度又變長的檔會被當成只往後長；真的遇到再改成比對雜湊。
 * @param {string} file 絕對路徑（呼叫端已驗過）
 * @param {Awaited<ReturnType<typeof index>> | null} [prev]
 */
async function index(file, prev = null) {
  const handle = await fsp.open(file, 'r')
  try {
    const { size, mtimeMs } = await handle.stat()
    const head = Buffer.alloc(3)
    await handle.read(head, 0, 3, 0)
    const { enc, start } = sniff(head)
    const grown = Boolean(prev && prev.file === file && prev.enc === enc && size >= prev.size &&
      (await edges(handle, prev.size)).equals(prev.edges))
    // 書籤剛好落在舊檔尾就退一個：舊檔最後那行可能還沒寫完，要跟新寫的接成同一行
    const last = grown ? prev.offsets.length - 1 : 0
    const k = last > 0 && prev.offsets[last] >= prev.size ? last - 1 : last
    const offsets = grown ? Array.from(prev.offsets.subarray(0, k + 1)) : [start]
    const lineNos = grown ? Array.from(prev.lineNos.subarray(0, k + 1)) : [1]
    const starts = grown ? Array.from(prev.starts.subarray(0, k + 1)) : [1]
    let rows = k * STEP
    let line = lineNos[k]
    let startsLine = starts[k] === 1
    let carry = Buffer.alloc(0)
    let pos = offsets[k]
    const chunk = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      // 只讀到 stat 當下的大小：掃到一半檔案又變長，多出來的留給下一次，索引才跟 size 對得上
      const { bytesRead } = await handle.read(chunk, 0, Math.max(0, Math.min(CHUNK, size - pos)), pos)
      const final = bytesRead === 0 || pos + bytesRead >= size
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const base = pos - carry.length
      const rest = scanRows(buf, 0, final, (_s, _e, endsLine, next) => {
        rows += 1
        if (endsLine) line += 1
        startsLine = endsLine
        if (rows % STEP === 0) {
          offsets.push(base + next)
          lineNos.push(line)
          starts.push(startsLine ? 1 : 0)
        }
      }, enc)
      pos += bytesRead
      if (final) break
      carry = Buffer.from(buf.subarray(rest))
    }
    return {
      file,
      size,
      mtimeMs,
      enc,
      edges: await edges(handle, size),
      rows,
      lines: startsLine ? line - 1 : line,
      offsets: Float64Array.from(offsets),
      lineNos: Float64Array.from(lineNos),
      starts: Uint8Array.from(starts)
    }
  } finally {
    await handle.close()
  }
}

/**
 * 從第 `k` 個書籤往後走，對每一列呼叫 `onRow`（回 true 停）。
 * @param {ReturnType<typeof index> extends Promise<infer T> ? T : never} idx
 * @param {number} k
 * @param {(row: number, line: number, text: Buffer, absStart: number, absEnd: number) => boolean | void} onRow
 *   line＝這列是某一行的開頭時的行號，接續列給 0
 */
async function walk(idx, k, onRow) {
  const handle = await fsp.open(idx.file, 'r')
  try {
    let row = k * STEP
    let line = idx.lineNos[k]
    let startsLine = idx.starts[k] === 1
    let pos = idx.offsets[k]
    let carry = Buffer.alloc(0)
    const chunkSize = 1024 * 1024
    const chunk = Buffer.allocUnsafe(chunkSize)
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, pos)
      const final = bytesRead === 0 || pos + bytesRead >= idx.size
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const base = pos - carry.length
      const rest = scanRows(buf, 0, final, (s, e, endsLine) => {
        const stop = onRow(row, startsLine ? line : 0, buf.subarray(s, e), base + s, base + e)
        row += 1
        if (endsLine) line += 1
        startsLine = endsLine
        return stop
      }, idx.enc)
      if (rest < 0 || final) return
      pos += bytesRead
      carry = Buffer.from(buf.subarray(rest))
    }
  } finally {
    await handle.close()
  }
}

/** 一列的位元組 → 顯示字串（去掉 CRLF 的 \r） */
function textOf(bytes, enc) {
  const n = enc.unit
  const crlf = bytes.length >= n && bytes.subarray(bytes.length - n).equals(enc.cr)
  return enc.decoder.decode(bytes.subarray(0, crlf ? bytes.length - n : bytes.length))
}

/**
 * 讀第 start 列起的 count 列。
 * @returns {Promise<Array<{ t: string, n: number }>>} n＝行號（接續列為 0）
 */
async function readRows(idx, start, count) {
  const from = Math.max(0, Math.min(idx.rows, Math.floor(Number(start) || 0)))
  const want = Math.max(0, Math.min(MAX_ROWS_PER_READ, Math.floor(Number(count) || 0), idx.rows - from))
  const out = []
  if (!want) return out
  await walk(idx, Math.floor(from / STEP), (row, line, bytes) => {
    if (row < from) return false
    out.push({ t: textOf(bytes, idx.enc), n: line })
    return out.length >= want
  })
  return out
}

/** 二分搜尋：最後一個 `arr[i] <= value` 的 i */
function floorIndex(arr, value) {
  let lo = 0
  let hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (arr[mid] <= value) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * 第 line 行是第幾列。
 * @returns {Promise<number>}
 */
async function rowOfLine(idx, line) {
  const target = Math.max(1, Math.min(idx.lines, Math.floor(Number(line) || 1)))
  let found = idx.rows - 1
  // 用 target - 1 找書籤：書籤那列可能是 target 那一行的接續列，行頭在它前面
  await walk(idx, floorIndex(idx.lineNos, target - 1), (row, n) => {
    if (n === 0 || n < target) return false
    found = row
    return true
  })
  return Math.max(0, found)
}

/** 位元組位置落在第幾列 */
async function rowOfOffset(idx, offset) {
  let found = idx.rows - 1
  await walk(idx, floorIndex(idx.offsets, offset), (row, _n, _b, _s, absEnd) => {
    if (absEnd <= offset) return false
    found = row
    return true
  })
  return Math.max(0, found)
}

/** 第 row 列開頭的位元組位置 */
async function offsetOfRow(idx, row) {
  let found = idx.size
  await walk(idx, Math.floor(row / STEP), (r, _n, _b, absStart) => {
    if (r < row) return false
    found = absStart
    return true
  })
  return found
}

/** 字串 → 檔案編碼的位元組 */
function encodeAs(text, enc) {
  if (enc.unit === 1) return Buffer.from(text, 'utf8')
  const bytes = Buffer.from(text, 'utf16le')
  return enc.le ? bytes : bytes.swap16()
}

/**
 * 英文字母折成小寫寫進 `out`（長度不變，位置對得回原檔）。
 * shortcut: 只折 A–Z；Ä、Σ 這類非英文字母仍然分大小寫，要全折得改成解碼後比對。
 * @param {Buffer} src 開頭必須是碼元邊界
 * @param {Buffer} out 至少跟 src 一樣長
 */
function foldAscii(src, out, enc) {
  src.copy(out)
  if (enc.unit === 1) {
    // UTF-8 的多位元組字每個位元組都 ≥ 0x80，不會被誤折
    for (let i = 0; i < src.length; i += 1) {
      const b = src[i]
      if (b >= 65 && b <= 90) out[i] = b | 32
    }
  } else {
    const lo = enc.le ? 0 : 1
    for (let i = 0; i + 1 < src.length; i += 2) {
      const b = src[i + lo]
      if (src[i + 1 - lo] === 0 && b >= 65 && b <= 90) out[i + lo] = b | 32
    }
  }
  return out.subarray(0, src.length)
}

/**
 * 從 `afterRow` 的下一列開始找 `query`，找到檔尾就從頭繞一圈。
 * 位元組層級的 `indexOf`，幾 GB 也只要幾秒；不分大小寫時先把英文字母折成小寫再比。
 * @param {boolean} [matchCase]
 * @returns {Promise<number | null>} 找到的那一列
 */
async function find(idx, query, afterRow, matchCase = false) {
  if (typeof query !== 'string' || !query || query.length > MAX_QUERY_CHARS || query.includes('\n')) {
    throw fail('BAD_QUERY', '搜尋字串不合法')
  }
  // 沒有英文字母就折不折都一樣，省掉每塊 4MB 的折字
  const fold = matchCase !== true && /[A-Za-z]/.test(query)
  const raw = encodeAs(query, idx.enc)
  const needle = fold ? foldAscii(raw, Buffer.alloc(raw.length), idx.enc) : raw
  const startRow = Math.max(-1, Math.min(idx.rows - 1, Math.floor(Number(afterRow))))
  const from = startRow < 0 ? idx.offsets[0] : await offsetOfRow(idx, startRow + 1)
  const hit = (await scan(idx, needle, from, idx.size, fold)) ?? (await scan(idx, needle, idx.offsets[0], Math.min(idx.size, from + needle.length), fold))
  return hit === null ? null : rowOfOffset(idx, hit)
}

/** [from, to) 裡第一個 needle 的位置；兩塊之間重疊 needle 長度，跨塊的也找得到。from 必須是碼元邊界 */
async function scan(idx, needle, from, to, fold) {
  const handle = await fsp.open(idx.file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK + needle.length)
    const folded = fold ? Buffer.allocUnsafe(chunk.length) : null
    for (let pos = from; pos < to; pos += CHUNK) {
      const len = Math.min(CHUNK + needle.length - 1, to - pos)
      const { bytesRead } = await handle.read(chunk, 0, len, pos)
      const hay = folded ? foldAscii(chunk.subarray(0, bytesRead), folded, idx.enc) : chunk.subarray(0, bytesRead)
      // UTF-16 只算對齊的命中（CHUNK 是偶數，pos 一直對齊）
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
        if (at % idx.enc.unit === 0) return pos + at
      }
      if (bytesRead < len) break
    }
    return null
  } finally {
    await handle.close()
  }
}

module.exports = { index, readRows, rowOfLine, find, STEP, MAX_ROW_BYTES }
