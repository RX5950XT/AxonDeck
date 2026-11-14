'use strict'

/**
 * 文字／Markdown／程式碼的獨立編輯視窗（取代 VS Code 的「點兩下就開」）。
 *
 * 一個檔案一扇窗；同一個檔案再開一次只把那扇窗叫到前面。
 * 路徑只由 main 決定（Windows 關聯、檔案頁、工作區、這裡的開啟／另存對話框），
 * renderer 只能讀寫「自己這扇窗的那個檔案」，送不出任意路徑。
 */

const path = require('path')
const crypto = require('crypto')
const { DEV_URL } = require('./dev-url')
const { BrowserWindow, ipcMain, dialog, clipboard } = require('electron')
const fsp = require('./raw-fs').promises
const formats = require('./editor-formats.json')
const openWithFormats = require('./editor-open-with.json')
const { makeInvoke } = require('./ipc-invoke')
const { renameRetry } = require('./workspace/files')
const workspaceMedia = require('./workspace/media')
const bigText = require('./big-text')

const EXTENSIONS = new Set(Object.values(formats).flat())
/** 只登記在 Windows「開啟方式」、不搶預設的格式（HTML 留給瀏覽器、CSV 留給 Excel） */
const OPEN_WITH = new Set(Object.values(openWithFormats).flat())
/** 有預覽的格式（其他只有編輯） */
const PREVIEWS = new Map([
  ...formats.markdown.map((ext) => [ext, 'markdown']),
  ...openWithFormats.web.map((ext) => [ext, 'html']),
  ...openWithFormats.table.map((ext) => [ext, 'csv']),
  ['mmd', 'mermaid'], ['mermaid', 'mermaid']
])
/** 跟工作區同一個上限（`workspace/files.js` 的 MAX_TEXT_BYTES）：再大 Monaco 存不回去 */
const MAX_BYTES = 256 * 1024 * 1024
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])
/** 寫得回去的編碼；其他（Big5、GBK…）只能看，要改先「以 UTF-8 儲存」 */
const WRITABLE = new Set(['utf8', 'utf8bom', 'utf16le'])
/** 「以其他編碼重新開啟」收的編碼 → TextDecoder 的名字 */
const DECODERS = {
  utf8: 'utf-8', utf8bom: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', big5: 'big5',
  gbk: 'gbk', gb18030: 'gb18030', shift_jis: 'shift_jis', 'euc-kr': 'euc-kr', 'windows-1252': 'windows-1252'
}
/** 開頭的 BOM 照編碼剝掉（使用者指定編碼重開時也一樣） */
const BOMS = { utf8: UTF8_BOM, utf8bom: UTF8_BOM, utf16le: UTF16_BOM, utf16be: UTF16BE_BOM }
/** HTML 預覽站台的假專案 id 開頭（`workspace/media.js` 的 siteUrlFor；根目錄＝這扇窗的檔案所在資料夾） */
const SITE_PREFIX = '~editor-'

/** @type {Map<number, { win: Electron.BrowserWindow, file: string, dirty: boolean, closing: boolean, encoding: string, siteId: string, big?: any }>} */
const entries = new Map()
let options = { isDev: false, preload: '', icon: '', secure: (_win) => {}, theme: () => 'dark', imageBase: (_file) => '', forceClose: () => false, reveal: (_file) => {} }
let tmpSeq = 0

function fail(code, message) {
  return Object.assign(new Error(code), { code, userMessage: message })
}

/**
 * 照 Windows 的規則取副檔名：`.gitignore` 的副檔名是 `gitignore`
 * （Node 的 `path.extname` 對點開頭的檔名回空字串，關聯點兩下就會打不開）。
 * @param {string} file
 */
function extOf(file) {
  const name = path.basename(file)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** @param {unknown} file */
function isEditable(file) {
  return typeof file === 'string' && EXTENSIONS.has(extOf(file))
}

/** @param {unknown} file 只出現在「開啟方式」的格式 */
function isOpenWith(file) {
  return typeof file === 'string' && OPEN_WITH.has(extOf(file))
}

function configure(next) { options = { ...options, ...next } }

function overlay(theme) {
  return theme === 'light'
    ? { color: '#e9eeec', symbolColor: '#1e2528', height: 38 }
    : { color: '#111417', symbolColor: '#f4f1e8', height: 38 }
}

const findOpen = (full) => [...entries.values()].find((entry) => entry.file.toLowerCase() === full.toLowerCase() && !entry.win.isDestroyed())

/**
 * 開一個檔案。不是編輯器接手的格式回 false（呼叫端照舊交給系統）。
 * @param {unknown} file 外部輸入（命令列、檔案頁），這裡再驗一次
 * @param {{ force?: boolean, openWith?: boolean }} [opts]
 *   force＝呼叫端已確認是沒有程式接手的文字檔；openWith＝使用者從「開啟方式」指名要編輯器（HTML／CSV 也收）
 * @returns {Promise<boolean>}
 */
async function open(file, opts = {}) {
  if (typeof file !== 'string') return false
  if (opts.force !== true && !isEditable(file) && !(opts.openWith === true && isOpenWith(file))) return false
  if (!path.isAbsolute(file) || file.includes('\0')) throw fail('BAD_PATH', '路徑不合法')
  const full = path.resolve(file)
  const stat = await fsp.stat(full).catch(() => null)
  if (!stat?.isFile()) throw fail('NOT_FOUND', '找不到這個檔案')
  const same = findOpen(full)
  if (same) {
    if (same.win.isMinimized()) same.win.restore()
    same.win.show()
    same.win.focus()
    return true
  }
  createWindow(full)
  return true
}

function createWindow(file) {
  const theme = options.theme() === 'light' ? 'light' : 'dark'
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 520,
    minHeight: 360,
    title: `${path.basename(file)} — AxonDeck`,
    icon: options.icon || undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(theme),
    backgroundColor: overlay(theme).color,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, preload: options.preload }
  })
  win.setMenu(null)
  options.secure(win)
  const id = win.webContents.id
  const entry = { win, file, dirty: false, closing: false, encoding: 'utf8', siteId: `${SITE_PREFIX}${crypto.randomBytes(8).toString('hex')}` }
  entries.set(id, entry)
  win.on('close', (event) => {
    if (!entry.dirty || entry.closing || options.forceClose()) return
    // 有沒存的修改：交給頁面問（App 內彈窗，不用原生 confirm）
    event.preventDefault()
    win.webContents.send('editorFile:closeRequest')
  })
  win.on('closed', () => entries.delete(id))
  win.once('ready-to-show', () => win.show())
  if (options.isDev) win.loadURL(`${DEV_URL}/pages/editor.html`)
  else win.loadFile(path.join(__dirname, '../renderer/pages/editor.html'))
}

/**
 * 解碼：UTF-8（含 BOM）、UTF-16 LE（記事本的「Unicode」）照原編碼存回；
 * 其他當成 Big5 唯讀（臺灣舊文字檔最常見，TextEncoder 寫不回 Big5）。
 * @param {Buffer} bytes
 */
function decode(bytes) {
  if (bytes.subarray(0, 3).equals(UTF8_BOM)) return { content: bytes.subarray(3).toString('utf8'), encoding: 'utf8bom' }
  if (bytes.subarray(0, 2).equals(UTF16_BOM)) return { content: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  if (bytes.subarray(0, 8000).includes(0)) throw fail('BINARY', '這是二進位檔，不能用文字編輯器開')
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' }
  } catch {
    return { content: new TextDecoder('big5').decode(bytes), encoding: 'big5' }
  }
}

/**
 * 使用者指定編碼重開（狀態列的「以其他編碼重新開啟」）：照指定的解，認不得的字變成 �，不再自動猜。
 * @param {Buffer} bytes
 * @param {string} encoding DECODERS 的鍵
 */
function decodeAs(bytes, encoding) {
  const bom = BOMS[encoding]
  const body = bom && bytes.subarray(0, bom.length).equals(bom) ? bytes.subarray(bom.length) : bytes
  return { content: new TextDecoder(DECODERS[encoding]).decode(body), encoding }
}

/** @param {string} content @param {string} encoding */
function encode(content, encoding) {
  if (encoding === 'utf8bom') return Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf8')])
  if (encoding === 'utf16le') return Buffer.concat([UTF16_BOM, Buffer.from(content, 'utf16le')])
  return Buffer.from(content, 'utf8')
}

function entryOf(event) {
  const entry = entries.get(event.sender.id)
  if (!entry) throw fail('FORBIDDEN', '只有編輯視窗可以使用')
  return entry
}

/** 這扇窗已經建好的分段索引 */
function bigOf(event) {
  const big = entryOf(event).big
  if (!big) throw fail('NOT_BIG', '還沒開始分段檢視')
  return big
}

/** 檔名相關、換了路徑（另存新檔）要重給頁面的那幾欄 */
function fileInfo(entry) {
  const preview = PREVIEWS.get(extOf(entry.file)) || ''
  return {
    path: entry.file,
    name: path.basename(entry.file),
    preview,
    imageBase: preview === 'markdown' ? options.imageBase(entry.file) : ''
  }
}

/**
 * @param {{ file: string, encoding: string, big?: any }} entry
 * @param {unknown} [encoding] 指定編碼重開；沒給就自動判斷
 */
async function load(entry, encoding) {
  if (encoding !== undefined && !Object.hasOwn(DECODERS, String(encoding))) throw fail('BAD_ENCODING', '不支援這個編碼')
  const stat = await fsp.stat(entry.file).catch(() => null)
  if (!stat?.isFile()) throw fail('NOT_FOUND', '找不到這個檔案')
  const theme = options.theme() === 'light' ? 'light' : 'dark'
  // 超過 Monaco 的上限：不整份讀進來，頁面改用唯讀分段檢視（`big-text.js`）
  if (stat.size > MAX_BYTES) {
    entry.encoding = 'big'
    return { ...fileInfo(entry), preview: '', imageBase: '', big: true, size: stat.size, content: '', encoding: 'utf8', readonly: true, mtimeMs: stat.mtimeMs, theme }
  }
  const bytes = await fsp.readFile(entry.file)
  const decoded = encoding === undefined ? decode(bytes) : decodeAs(bytes, String(encoding))
  entry.encoding = decoded.encoding
  return { ...fileInfo(entry), content: decoded.content, encoding: decoded.encoding, readonly: !WRITABLE.has(decoded.encoding), mtimeMs: stat.mtimeMs, theme }
}

/** 先寫暫存再 rename（中途失敗不留下寫一半的原檔） */
async function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}-${(tmpSeq += 1)}.axondeck-tmp`
  try {
    await fsp.writeFile(tmp, bytes)
    await renameRetry(tmp, file)
  } catch {
    await fsp.unlink(tmp).catch(() => {})
    throw fail('WRITE_FAILED', '存檔失敗（檔案可能是唯讀或被別的程式鎖住）')
  }
}

/** @param {unknown} content @param {string} encoding */
function bytesFor(content, encoding) {
  if (typeof content !== 'string') throw fail('BAD_CONTENT', '內容不合法')
  const bytes = encode(content, encoding)
  if (bytes.length > MAX_BYTES) throw fail('TOO_LARGE', '檔案太大，存不下')
  return bytes
}

/**
 * 存檔：外面改過就回 STALE 讓頁面問要不要覆寫。
 * @param {{ file: string, encoding: string }} entry
 * @param {unknown} content
 * @param {unknown} expectedMtimeMs 0＝使用者明確選了覆寫
 * @param {unknown} [encoding] 換成這個編碼存（「以 UTF-8 儲存」：Big5 等唯讀編碼也靠它轉成可編輯）
 */
async function save(entry, content, expectedMtimeMs, encoding) {
  if (entry.encoding === 'big') throw fail('READONLY', '超大檔只能檢視')
  if (encoding !== undefined && !WRITABLE.has(String(encoding))) throw fail('BAD_ENCODING', '不能用這個編碼儲存')
  const target = encoding === undefined ? entry.encoding : String(encoding)
  if (!WRITABLE.has(target)) throw fail('READONLY', '這個編碼的檔案只能檢視；要修改請先「以 UTF-8 儲存」')
  const bytes = bytesFor(content, target)
  const stat = await fsp.stat(entry.file).catch(() => null)
  const expected = Number(expectedMtimeMs)
  if (expected > 0 && (!stat || Math.abs(stat.mtimeMs - expected) > 1)) throw fail('STALE', '這個檔案在外部被改過了')
  await writeAtomic(entry.file, bytes)
  entry.encoding = target
  return { mtimeMs: (await fsp.stat(entry.file)).mtimeMs, encoding: target }
}

/**
 * 另存新檔：路徑由 main 的對話框決定；之後這扇窗就改成編輯新檔案。
 * @param {{ win: Electron.BrowserWindow, file: string, encoding: string }} entry
 * @param {unknown} content
 */
async function saveAs(entry, content) {
  if (entry.encoding === 'big') throw fail('READONLY', '超大檔只能檢視')
  const picked = await dialog.showSaveDialog(entry.win, { title: '另存新檔', defaultPath: entry.file })
  if (picked.canceled || !picked.filePath) return { canceled: true }
  const full = path.resolve(picked.filePath)
  const other = findOpen(full)
  if (other && other !== entry) throw fail('OPEN_ELSEWHERE', '那個檔案已經在另一扇編輯視窗開著，請先關掉它')
  const encoding = WRITABLE.has(entry.encoding) ? entry.encoding : 'utf8'
  await writeAtomic(full, bytesFor(content, encoding))
  entry.file = full
  entry.encoding = encoding
  entry.win.setTitle(`${path.basename(full)} — AxonDeck`)
  return { ...fileInfo(entry), encoding, readonly: false, mtimeMs: (await fsp.stat(full)).mtimeMs }
}

/**
 * 「開啟檔案」對話框：使用者自己挑的，HTML／CSV 也收；副檔名不認得但內容是文字也開，其他交給系統。
 * @param {{ win: Electron.BrowserWindow, file: string }} entry
 */
async function openPicked(entry) {
  const picked = await dialog.showOpenDialog(entry.win, { title: '開啟檔案', defaultPath: path.dirname(entry.file), properties: ['openFile', 'multiSelections'] })
  if (picked.canceled) return { opened: 0 }
  const mediaPlayer = require('./media-player')
  for (const file of picked.filePaths.slice(0, 20)) {
    if (await open(file, { openWith: true })) continue
    if (await mediaPlayer.looksLikeText(file)) await open(file, { force: true })
    else await mediaPlayer.openPath(file)
  }
  return { opened: picked.filePaths.length }
}

/** 比較變更用：磁碟上現在那一份，照這扇窗的編碼解 */
async function readDisk(entry) {
  if (!DECODERS[entry.encoding]) throw fail('READONLY', '超大檔不能比較')
  const stat = await fsp.stat(entry.file).catch(() => null)
  if (!stat?.isFile()) return { content: '', exists: false }
  if (stat.size > MAX_BYTES) throw fail('TOO_LARGE', '磁碟上的檔案太大，不能比較')
  return { content: decodeAs(await fsp.readFile(entry.file), entry.encoding).content, exists: true }
}

/**
 * 預覽裡點到相對路徑連結：以這扇窗的檔案所在資料夾解路徑，編輯器收得了的格式另開一扇窗。
 * renderer 只送得出連結原字串，路徑在這裡決定。
 * @param {{ file: string }} entry
 * @param {unknown} link
 */
async function openLink(entry, link) {
  if (typeof link !== 'string' || !link || link.length > 2048 || link.includes('\0')) throw fail('BAD_LINK', '連結不合法')
  let target = link.split('#')[0].split('?')[0]
  try { target = decodeURIComponent(target) } catch { throw fail('BAD_LINK', '連結不合法') }
  if (!target || /^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(target)) throw fail('BAD_LINK', '這種連結只能從工作區或檔案頁開')
  const full = path.resolve(path.dirname(entry.file), target)
  const known = isEditable(full) || isOpenWith(full)
  const unknownText = !known && await require('./media-player').isUnknownText(full)
  if (!known && !unknownText) throw fail('UNSUPPORTED', '這種檔案請到檔案頁開')
  await open(full, { force: unknownText, openWith: true })
}

/**
 * HTML 預覽站台的根目錄（`workspace/media.js` 用假專案 id 來問）：這扇窗的檔案所在資料夾。
 * @param {string} siteId
 */
function siteRoot(siteId) {
  const entry = [...entries.values()].find((one) => one.siteId === siteId)
  if (!entry) throw fail('NOT_FOUND', '找不到這個預覽')
  return path.dirname(entry.file)
}

/** HTML 預覽網址：送的是編輯器手上這一版（沒存也算） */
function previewHtml(entry, content) {
  if (typeof content !== 'string' || content.length > MAX_BYTES) throw fail('BAD_CONTENT', '內容不合法')
  if (PREVIEWS.get(extOf(entry.file)) !== 'html') throw fail('UNSUPPORTED', '這個檔案不是 HTML')
  return workspaceMedia.siteUrlFor(entry.siteId, path.basename(entry.file), content, workspaceMedia.PREVIEW_SCHEME)
}

function registerIpc() {
  const invoke = makeInvoke({ isMainSender: (event) => entries.has(event.sender.id), forbidden: '只有編輯視窗可以使用', message: '操作失敗' })
  /** 每支都先認出是哪一扇窗；channel 寫完整字面（`lint-ipc.js` 照字面比對） */
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => invoke(event, () => fn(entryOf(event), ...args)))
  handle('editorFile:load', (entry, encoding) => load(entry, encoding))
  handle('editorFile:save', (entry, content, mtimeMs, encoding) => save(entry, content, mtimeMs, encoding))
  handle('editorFile:saveAs', (entry, content) => saveAs(entry, content))
  handle('editorFile:openPicked', (entry) => openPicked(entry))
  handle('editorFile:readDisk', (entry) => readDisk(entry))
  handle('editorFile:previewHtml', (entry, content) => previewHtml(entry, content))
  handle('editorFile:reveal', (entry) => { options.reveal(entry.file) })
  handle('editorFile:copyPath', (entry) => { clipboard.writeText(entry.file) })
  handle('editorFile:stat', async (entry) => {
    const stat = await fsp.stat(entry.file).catch(() => null)
    return { exists: Boolean(stat?.isFile()), mtimeMs: stat?.mtimeMs || 0 }
  })
  handle('editorFile:bigOpen', async (entry) => {
    if (entry.encoding !== 'big') throw fail('NOT_BIG', '這個檔案不是用分段檢視開的')
    // 外面改過檔案時頁面會再叫一次：重建索引、換上新的
    entry.big = await bigText.index(entry.file, entry.big)
    const { rows, lines, size, mtimeMs, enc } = entry.big
    return { rows, lines, size, mtimeMs, encoding: enc.name }
  })
  ipcMain.handle('editorFile:bigRows', (event, start, count) => invoke(event, () => bigText.readRows(bigOf(event), start, count)))
  ipcMain.handle('editorFile:bigLine', (event, line) => invoke(event, () => bigText.rowOfLine(bigOf(event), line)))
  ipcMain.handle('editorFile:bigFind', (event, query, afterRow, matchCase) => invoke(event, () => bigText.find(bigOf(event), query, afterRow, matchCase === true)))
  handle('editorFile:openLink', (entry, link) => openLink(entry, link))
  handle('editorFile:setDirty', (entry, dirty) => { entry.dirty = dirty === true })
  handle('editorFile:close', (entry) => {
    entry.closing = true
    entry.win.close()
  })
}

module.exports = { SITE_PREFIX, isEditable, isOpenWith, configure, open, registerIpc, siteRoot, decode, decodeAs, encode, extOf }
