/**
 * Office／ODF 預覽共用的小工具：讀 zip、讀 XML、解關聯、包裡的圖片。
 * 這幾種文件都是「zip 包 XML」：zip 自己讀中央目錄，解壓用 Chromium 內建的
 * `DecompressionStream('deflate-raw')`，XML 用 `DOMParser`——不加套件。
 */

/** 超過這個大小不在分頁裡解（整份要讀進記憶體） */
const MAX_BYTES = 50 * 1024 * 1024

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' }

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** 上一份預覽的圖片 blob 網址；畫下一份時收掉 */
let liveUrls = []

export function revokeImages() {
  for (const old of liveUrls) URL.revokeObjectURL(old)
  liveUrls = []
}

/**
 * 讀 zip 的中央目錄。只支援 stored(0) 與 deflate(8)，不支援 zip64（文件檔不會用到）。
 * @param {ArrayBuffer} buf
 * @returns {Map<string, { method: number, size: number, offset: number }>}
 */
export function readZipDirectory(buf) {
  const view = new DataView(buf)
  let end = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('不是 zip 檔')
  const count = view.getUint16(end + 10, true)
  let p = view.getUint32(end + 16, true)
  const names = new TextDecoder()
  const entries = new Map()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== 0x02014b50) throw new Error('zip 目錄壞了')
    const nameLen = view.getUint16(p + 28, true)
    const name = names.decode(new Uint8Array(buf, p + 46, nameLen))
    entries.set(name, { method: view.getUint16(p + 10, true), size: view.getUint32(p + 20, true), offset: view.getUint32(p + 42, true) })
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
  }
  return entries
}

/**
 * @param {ArrayBuffer} buf
 * @param {{ method: number, size: number, offset: number }} entry
 * @returns {Promise<Uint8Array>}
 */
export async function readZipEntry(buf, entry) {
  const view = new DataView(buf)
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  if (start + entry.size > buf.byteLength) throw new Error('zip 內容不完整')
  const raw = new Uint8Array(buf, start, entry.size)
  if (entry.method === 0) return raw
  if (entry.method !== 8) throw new Error('不支援的壓縮方式')
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** @typedef {{ bytes: (name: string) => Promise<Uint8Array | null>, xml: (name: string) => Promise<Document | null>, has: (name: string) => boolean }} Pkg */

/**
 * 開一份文件包：回「依路徑取檔」的小工具（XML 解過就記住，同一份不重解）。
 * @param {ArrayBuffer} buf
 * @returns {Pkg}
 */
export function openPackage(buf) {
  const entries = readZipDirectory(buf)
  /** @type {Map<string, Promise<Document | null>>} */
  const parsed = new Map()
  const bytes = async (name) => {
    const entry = entries.get(name)
    return entry ? readZipEntry(buf, entry) : null
  }
  const xml = (name) => {
    if (!parsed.has(name)) {
      parsed.set(name, bytes(name).then((data) => (
        data ? new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml') : null
      )))
    }
    return /** @type {Promise<Document | null>} */ (parsed.get(name))
  }
  return { bytes, xml, has: (name) => entries.has(name) }
}

/** 讀網址成文件包（`vi-media://` 或 blob） */
export async function fetchPackage(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`讀檔失敗（${res.status}）`)
  if (Number(res.headers.get('Content-Length')) > MAX_BYTES) throw new Error('檔案太大，不在分頁裡預覽')
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new Error('檔案太大，不在分頁裡預覽')
  return openPackage(buf)
}

/** 依 localName 找子孫（XML 有命名空間前綴，`w:p`、`a:t`…，用 localName 比最省事） */
export function all(node, name) {
  return node ? Array.from(node.getElementsByTagName('*')).filter((one) => one.localName === name) : []
}
export function first(node, name) {
  return all(node, name)[0] || null
}
export function kids(node, name) {
  return node ? Array.from(node.children).filter((one) => !name || one.localName === name) : []
}
export function kid(node, name) {
  return kids(node, name)[0] || null
}
/** 取屬性值，不管前綴（`w:val`、`table:style-name`…） */
export function attr(node, name) {
  if (!node) return ''
  for (const one of Array.from(node.attributes)) if (one.localName === name) return one.value
  return ''
}
/** `r:id`／`r:embed`：pptx 的 `sldId` 同時有不帶前綴的 `id`，不能只比 localName */
export function relAttr(node, name = 'id') {
  return node?.getAttributeNS(REL_NS, name) || ''
}

/**
 * 解 `_rels`：id → { 檔案路徑, 類型 }（相對路徑照 base 資料夾解開；外部連結略過）
 * @returns {Promise<Map<string, { path: string, type: string }>>}
 */
export async function relations(pkg, relsPath, baseDir) {
  const map = new Map()
  for (const rel of all(await pkg.xml(relsPath), 'Relationship')) {
    if (attr(rel, 'TargetMode') === 'External') continue
    map.set(attr(rel, 'Id'), { path: joinPath(baseDir, attr(rel, 'Target')), type: attr(rel, 'Type') })
  }
  return map
}
/** 某份零件的 `_rels` 位置：`ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels` */
export function relsOf(part) {
  const dir = part.split('/').slice(0, -1).join('/')
  return { rels: `${dir}/_rels/${part.split('/').pop()}.rels`, dir }
}
export function joinPath(baseDir, target) {
  const parts = (target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`).split('/')
  const out = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out.join('/')
}

/** 包裡的圖片變成 `<img>`；不認得的格式（emf/wmf）回 null */
export async function imageFrom(pkg, path) {
  const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() || '']
  const data = type && await pkg.bytes(path)
  if (!data) return null
  const url = URL.createObjectURL(new Blob([data], { type }))
  liveUrls.push(url)
  const img = document.createElement('img')
  img.className = 'ws-office-img'
  img.src = url
  return img
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
export function make(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/** 六位十六進位色碼才收（`auto`、主題色之類的一律不套） */
export function hexColor(value) {
  return /^[0-9a-f]{6}$/i.test(value || '') ? `#${value}` : ''
}

/** 字型名稱放進 CSS：去掉引號與反斜線再包起來 */
export function fontFamily(name) {
  return name ? `"${name.replace(/["\\]/g, '')}", sans-serif` : ''
}

/** 試算表格子 → 表格（xlsx 與 ods 共用） */
const MAX_ROWS = 2000
const MAX_COLS = 200
export const SHEET_LIMITS = { rows: MAX_ROWS, cols: MAX_COLS }

export function columnName(index) {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/**
 * @param {Array<Array<{ text: string, num?: boolean } | undefined> | undefined>} grid
 * @param {number} width
 * @param {boolean} clipped
 */
export function gridTable(grid, width, clipped) {
  const table = make('table', 'ws-office-table ws-office-sheet')
  const head = make('tr')
  head.append(make('th'))
  for (let c = 0; c < width; c++) head.append(make('th', '', columnName(c)))
  table.append(head)
  for (let r = 0; r < grid.length; r++) {
    const tr = make('tr')
    tr.append(make('th', '', String(r + 1)))
    for (let c = 0; c < width; c++) {
      const cell = grid[r]?.[c]
      tr.append(make('td', cell?.num ? 'is-num' : '', cell?.text || ''))
    }
    table.append(tr)
  }
  const box = make('div', 'ws-office-sheet-wrap')
  box.append(table)
  if (clipped) box.append(make('p', 'ws-unsupported-meta', `只顯示前 ${MAX_ROWS} 列、${MAX_COLS} 欄。`))
  return box
}

/**
 * 多張工作表：上面一排頁籤，點了才畫那一張。
 * @param {Array<{ name: string, paint: () => Promise<HTMLElement> }>} sheets
 */
export async function sheetBook(sheets) {
  const box = make('div', 'ws-office-book')
  const bar = make('div', 'ws-office-tabs')
  const body = make('div', 'ws-office-sheet-host')
  box.append(bar, body)
  /** @type {Map<number, HTMLElement>} */
  const painted = new Map()
  const show = async (index) => {
    bar.querySelectorAll('button').forEach((btn, i) => btn.classList.toggle('is-active', i === index))
    if (!painted.has(index)) painted.set(index, await sheets[index].paint())
    body.replaceChildren(/** @type {HTMLElement} */ (painted.get(index)))
  }
  sheets.forEach((sheet, index) => {
    const btn = make('button', 'ws-office-tab', sheet.name || `工作表${index + 1}`)
    btn.type = 'button'
    btn.addEventListener('click', () => { void show(index) })
    bar.append(btn)
  })
  if (sheets.length) await show(0)
  else body.append(make('p', 'ws-unsupported-meta', '這份試算表沒有工作表。'))
  return box
}
