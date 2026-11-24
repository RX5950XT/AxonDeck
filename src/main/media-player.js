'use strict'

const path = require('path')
const fs = require('./raw-fs').promises
const { spawn } = require('child_process')
const formats = require('./media-formats.json')

function electronShell() {
  try { return require('electron').shell } catch { return null }
}

const { resolveProbeExe } = require('./native-probe')
const types = new Map(Object.entries(formats).flatMap(([kind, list]) => list.map((ext) => [ext, kind])))
let theme = () => 'dark'
/** 文字／程式碼交給 AxonDeck 編輯器視窗（main 注入；回 true＝已接手） */
let editorOpener = async () => false
let associationInitPromise = null
// 改名後要再跑一次 Rust 的狀態搬移與重新登記；舊版的 1 不能跳過它。
const ASSOCIATION_MARKER = '2'

function mediaKind(file) {
  return typeof file === 'string' ? types.get(path.extname(file).slice(1).toLowerCase()) || '' : ''
}
function fail(message) {
  const error = new Error('MEDIA_OPEN_FAILED')
  error.code = 'MEDIA_OPEN_FAILED'
  error.userMessage = message
  return error
}
function setThemeGetter(getter) { theme = getter }
function setEditorOpener(opener) { editorOpener = opener }
const openEditor = (file, opts) => editorOpener(file, opts)
async function initializedMarker(file, expected = ASSOCIATION_MARKER) {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead === 1 && buffer.toString('utf8', 0, bytesRead) === expected
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  } finally { if (handle) await handle.close() }
}

function runAssociation(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, windowsHide: true, stdio: 'ignore', shell: false })
    child.once('error', () => reject(Object.assign(new Error('MEDIA_ASSOCIATION_INIT_FAILED'), { code: 'MEDIA_ASSOCIATION_INIT_FAILED' })))
    child.once('spawn', () => child.unref())
    child.once('close', (code) => code === 0
      ? resolve()
      : reject(Object.assign(new Error('MEDIA_ASSOCIATION_INIT_FAILED'), { code: 'MEDIA_ASSOCIATION_INIT_FAILED' })))
  })
}

/** 已安裝版才在背景補一次使用者關聯；開發／預覽版不碰登錄檔。Linux 無原生媒體 sidecar。 */
async function initializeAssociations(options = {}) {
  if (process.platform !== 'win32') return false
  const { isPackaged, isPreview, resourcesPath, userDataPath } = options
  if (!isPackaged || isPreview || !resourcesPath || !userDataPath) return false
  if (associationInitPromise) return associationInitPromise
  associationInitPromise = (async () => {
    const updateManifest = path.join(resourcesPath, 'app-update.yml')
    if (!await fs.access(updateManifest).then(() => true, () => false)) return false

    const exe = path.join(resourcesPath, 'media', 'axondeck-media.exe')
    // 媒體與文字／程式碼編輯器各記各的：舊版已初始化媒體的使用者，更新後仍要補一次編輯器
    // 編輯器 '3'：.ts 從媒體移交給編輯器，1.46.0 已初始化過的要再跑一次（Rust 只改還指著媒體的那幾個）
    // 編輯器 '4'：多了一批格式與只進「開啟方式」的 HTML／CSV，要重新登記（已初始化過的不改預設）
    for (const [name, args, version] of [['media-associations-initialized', ['--initialize'], ASSOCIATION_MARKER], ['editor-associations-initialized', ['--editor', '--initialize'], '4']]) {
      const marker = path.join(userDataPath, name)
      if (await initializedMarker(marker, version)) continue
      await fs.access(exe)
      await fs.mkdir(userDataPath, { recursive: true })
      await runAssociation(exe, args)
      await fs.writeFile(marker, version, 'utf8')
    }
    return true
  })()
  try {
    const initialized = await associationInitPromise
    if (!initialized) associationInitPromise = null
    return initialized
  } catch (error) {
    associationInitPromise = null
    throw error
  }
}

/**
 * 解析原生播放器路徑；可注入 options.exe。沒有可執行檔時回空字串（呼叫端改走系統開啟）。
 * @param {{ exe?: string, resourcesPath?: string }} options
 */
function resolveMediaExe(options = {}) {
  if (options.exe) return options.exe
  const winName = 'axondeck-media.exe'
  const unixName = 'axondeck-media'
  const preferred = process.platform === 'win32' ? winName : unixName
  const found = resolveProbeExe({
    resourcesPath: options.resourcesPath,
    folder: 'media',
    name: preferred
  })
  if (found) return found
  // Linux／macOS：不要回退去找 .exe（誤跑 Windows 二進位會立刻失敗）
  return ''
}

/** caller 必須先過自己的路徑守衛；這層再確認只讀本機媒體檔。 */
async function openMedia(file, options = {}) {
  if (!mediaKind(file)) return false
  if (!path.isAbsolute(file) || file.includes('\0')) throw fail('媒體路徑不合法')
  const stats = await fs.stat(file).catch(() => null)
  if (!stats?.isFile()) throw fail('找不到這個媒體檔案')
  const exe = resolveMediaExe(options)
  if (!exe || !await fs.access(exe).then(() => true, () => false)) {
    // 無原生播放器：回 false，讓 openPath／檔案頁改走系統關聯（xdg-open／Explorer）
    return false
  }
  const hidden = options.hidden || process.env.AXONDECK_MEDIA_HIDDEN === '1'
  const args = [`--theme=${theme() === 'light' ? 'light' : 'dark'}`, ...(hidden ? ['--hidden'] : []), '--', file]
  await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, windowsHide: Boolean(hidden), stdio: 'ignore', shell: false })
    child.once('error', () => reject(fail('無法啟動原生播放器')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
  return true
}

/** 開頭 64KB 看起來是文字嗎：跟編輯器的 `decode` 同一個判斷（NUL＝二進位），再擋控制字元很多的。 */
async function looksLikeText(file) {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head[0] === 0xff && head[1] === 0xfe) return true
    if (head.includes(0)) return false
    const control = head.reduce((count, byte) => count + (byte < 9 || (byte > 13 && byte < 32 && byte !== 27) ? 1 : 0), 0)
    return control <= bytesRead * 0.02
  } catch {
    return false
  } finally { if (handle) await handle.close() }
}
const associationOf = (file) => require('./explorer/shell').associationOf(path.extname(file))
/** 沒有預設程式、但內容是文字（`.foo`、沒有副檔名的 LICENSE…）。 */
async function isUnknownText(file) {
  const state = await associationOf(file)
  return (state === 'none' || state === 'choices') && await looksLikeText(file)
}

/**
 * 系統預設程式開啟（Electron shell.openPath；無 Electron 時 Linux 用 xdg-open）。
 * @param {string} file
 * @returns {Promise<string>} 空字串＝成功；其餘＝失敗原因（同 shell.openPath）
 */
async function openWithSystem(file) {
  const sh = electronShell()
  if (sh && typeof sh.openPath === 'function') return sh.openPath(file)
  if (process.platform === 'linux') {
    await new Promise((resolve, reject) => {
      const child = spawn('xdg-open', [file], { detached: true, stdio: 'ignore', shell: false })
      child.once('error', () => reject(fail('無法用系統開啟此檔案')))
      child.once('spawn', () => { child.unref(); resolve() })
    })
    return ''
  }
  return 'UNSUPPORTED'
}

/**
 * 交給系統開；沒有預設程式時 Windows 只會跳「要用什麼開啟」，所以先攔下來：文字開自家編輯器。
 * 二進位檔有候選程式才讓系統問（那個清單有用），完全沒人接手就回 App 內的訊息。
 * associationOf 問不到時（Linux 尚未查 MIME、或 sidecar 不在）照舊交給系統開啟。
 * @param {string} target 實際要開的路徑（捷徑就是捷徑本身，啟動參數才不會被跳過）
 * @param {string} [real] 判斷關聯與內容用的真實檔案
 */
async function openSystem(target, real = target) {
  const state = await associationOf(real)
  if (state !== 'none' && state !== 'choices') return openWithSystem(target)
  if (await looksLikeText(real) && await editorOpener(real, { force: true })) return ''
  if (state === 'choices') return openWithSystem(target)
  throw Object.assign(fail('沒有程式能開這種檔案，它也不是文字檔。要指定程式請用右鍵選單的「開啟檔案」。'), { code: 'NO_APP' })
}
/** 與 shell.openPath 的回傳方式相同；所有開檔入口共用這條分流（媒體→播放器、文字→編輯器）。 */
async function openPath(file) {
  return await openMedia(file) || await openEditor(file) ? '' : openSystem(file)
}
module.exports = {
  mediaKind, openMedia, openEditor, openSystem, openWithSystem, isUnknownText, looksLikeText,
  openPath, resolveMediaExe, setThemeGetter, setEditorOpener, initializeAssociations
}
