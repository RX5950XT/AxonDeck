'use strict'

/**
 * 文字／Markdown／程式碼的獨立編輯視窗（取代 VS Code 的「點兩下就開」）。
 *
 * 一個檔案一扇窗；同一個檔案再開一次只把那扇窗叫到前面。
 * 路徑只由 main 決定（Windows 關聯、檔案頁、工作區），renderer 只能讀寫「自己這扇窗的那個檔案」，
 * 送不出任意路徑。
 */

const path = require('path')
const { BrowserWindow, ipcMain } = require('electron')
const fsp = require('./raw-fs').promises
const formats = require('./editor-formats.json')
const { makeInvoke } = require('./ipc-invoke')
const { renameRetry } = require('./workspace/files')
const bigText = require('./big-text')

const EXTENSIONS = new Set(Object.values(formats).flat())
/** 跟工作區同一個上限（`workspace/files.js` 的 MAX_TEXT_BYTES）：再大 Monaco 存不回去 */
const MAX_BYTES = 256 * 1024 * 1024
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_BOM = Buffer.from([0xff, 0xfe])

/** @type {Map<number, { win: Electron.BrowserWindow, file: string, dirty: boolean, closing: boolean, encoding: string, big?: any }>} */
const entries = new Map()
let options = { isDev: false, preload: '', icon: '', secure: (_win) => {}, theme: () => 'dark', imageBase: (_file) => '', forceClose: () => false }
let tmpSeq = 0

function fail(code, message) {
  return Object.assign(new Error(code), { code, userMessage: message })
}

/** @param {unknown} file */
function isEditable(file) {
  return typeof file === 'string' && EXTENSIONS.has(path.extname(file).slice(1).toLowerCase())
}

function configure(next) { options = { ...options, ...next } }

function overlay(theme) {
  return theme === 'light'
    ? { color: '#e9eeec', symbolColor: '#1e2528', height: 38 }
    : { color: '#111417', symbolColor: '#f4f1e8', height: 38 }
}

/**
 * 開一個檔案。不是編輯器接手的格式回 false（呼叫端照舊交給系統）。
 * @param {unknown} file 外部輸入（命令列、檔案頁），這裡再驗一次
 * @returns {Promise<boolean>}
 */
async function open(file) {
  if (!isEditable(file)) return false
  if (!path.isAbsolute(file) || file.includes('\0')) throw fail('BAD_PATH', '路徑不合法')
  const full = path.resolve(file)
  const stat = await fsp.stat(full).catch(() => null)
  if (!stat?.isFile()) throw fail('NOT_FOUND', '找不到這個檔案')
  const same = [...entries.values()].find((entry) => entry.file.toLowerCase() === full.toLowerCase())
  if (same && !same.win.isDestroyed()) {
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
  const entry = { win, file, dirty: false, closing: false, encoding: 'utf8' }
  entries.set(id, entry)
  win.on('close', (event) => {
    if (!entry.dirty || entry.closing || options.forceClose()) return
    // 有沒存的修改：交給頁面問（App 內彈窗，不用原生 confirm）
    event.preventDefault()
    win.webContents.send('editorFile:closeRequest')
  })
  win.on('closed', () => entries.delete(id))
  win.once('ready-to-show', () => win.show())
  if (options.isDev) win.loadURL('http://localhost:5173/pages/editor.html')
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

async function load(entry) {
  const stat = await fsp.stat(entry.file).catch(() => null)
  if (!stat?.isFile()) throw fail('NOT_FOUND', '找不到這個檔案')
  const theme = options.theme() === 'light' ? 'light' : 'dark'
  // 超過 Monaco 的上限：不整份讀進來，頁面改用唯讀分段檢視（`big-text.js`）
  if (stat.size > MAX_BYTES) {
    entry.encoding = 'big'
    return { path: entry.file, name: path.basename(entry.file), big: true, size: stat.size, content: '', encoding: 'utf8', readonly: true, mtimeMs: stat.mtimeMs, theme, markdown: false, imageBase: '' }
  }
  const { content, encoding } = decode(await fsp.readFile(entry.file))
  entry.encoding = encoding
  const markdown = formats.markdown.includes(path.extname(entry.file).slice(1).toLowerCase())
  return {
    path: entry.file,
    name: path.basename(entry.file),
    content,
    encoding,
    readonly: encoding === 'big5',
    mtimeMs: stat.mtimeMs,
    theme,
    markdown,
    imageBase: markdown ? options.imageBase(entry.file) : ''
  }
}

/**
 * 存檔：先寫暫存再 rename（中途失敗不留下寫一半的原檔）；外面改過就回 STALE 讓頁面問要不要覆寫。
 * @param {{ file: string, encoding: string }} entry
 * @param {unknown} content
 * @param {unknown} expectedMtimeMs 0＝使用者明確選了覆寫
 */
async function save(entry, content, expectedMtimeMs) {
  if (typeof content !== 'string') throw fail('BAD_CONTENT', '內容不合法')
  if (entry.encoding === 'big5') throw fail('READONLY', 'Big5 編碼的檔案只能檢視')
  if (entry.encoding === 'big') throw fail('READONLY', '超大檔只能檢視')
  const bytes = encode(content, entry.encoding)
  if (bytes.length > MAX_BYTES) throw fail('TOO_LARGE', '檔案太大，存不下')
  const stat = await fsp.stat(entry.file).catch(() => null)
  const expected = Number(expectedMtimeMs)
  if (expected > 0 && (!stat || Math.abs(stat.mtimeMs - expected) > 1)) throw fail('STALE', '這個檔案在外部被改過了')
  const tmp = `${entry.file}.${process.pid}-${(tmpSeq += 1)}.axondeck-tmp`
  try {
    await fsp.writeFile(tmp, bytes)
    await renameRetry(tmp, entry.file)
  } catch {
    await fsp.unlink(tmp).catch(() => {})
    throw fail('WRITE_FAILED', '存檔失敗（檔案可能是唯讀或被別的程式鎖住）')
  }
  return { mtimeMs: (await fsp.stat(entry.file)).mtimeMs }
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
  if (!isEditable(full)) throw fail('UNSUPPORTED', '這種檔案請到檔案頁開')
  await open(full)
}

function registerIpc() {
  const invoke = makeInvoke({ isMainSender: (event) => entries.has(event.sender.id), forbidden: '只有編輯視窗可以使用', message: '操作失敗' })
  ipcMain.handle('editorFile:load', (event) => invoke(event, () => load(entryOf(event))))
  ipcMain.handle('editorFile:save', (event, content, mtimeMs) => invoke(event, () => save(entryOf(event), content, mtimeMs)))
  ipcMain.handle('editorFile:stat', (event) => invoke(event, async () => {
    const stat = await fsp.stat(entryOf(event).file).catch(() => null)
    return { exists: Boolean(stat?.isFile()), mtimeMs: stat?.mtimeMs || 0 }
  }))
  ipcMain.handle('editorFile:bigOpen', (event) => invoke(event, async () => {
    const entry = entryOf(event)
    if (entry.encoding !== 'big') throw fail('NOT_BIG', '這個檔案不是用分段檢視開的')
    // 外面改過檔案時頁面會再叫一次：重建索引、換上新的
    entry.big = await bigText.index(entry.file, entry.big)
    const { rows, lines, size, mtimeMs, enc } = entry.big
    return { rows, lines, size, mtimeMs, encoding: enc.name }
  }))
  ipcMain.handle('editorFile:bigRows', (event, start, count) => invoke(event, () => bigText.readRows(bigOf(event), start, count)))
  ipcMain.handle('editorFile:bigLine', (event, line) => invoke(event, () => bigText.rowOfLine(bigOf(event), line)))
  ipcMain.handle('editorFile:bigFind', (event, query, afterRow, matchCase) => invoke(event, () => bigText.find(bigOf(event), query, afterRow, matchCase === true)))
  ipcMain.handle('editorFile:openLink', (event, link) => invoke(event, () => openLink(entryOf(event), link)))
  ipcMain.handle('editorFile:setDirty', (event, dirty) => invoke(event, () => { entryOf(event).dirty = dirty === true }))
  ipcMain.handle('editorFile:close', (event) => invoke(event, () => {
    const entry = entryOf(event)
    entry.closing = true
    entry.win.close()
  }))
}

module.exports = { isEditable, configure, open, registerIpc, decode, encode }
