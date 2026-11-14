'use strict'

const path = require('path')
const fs = require('./raw-fs').promises
const { spawn } = require('child_process')
const formats = require('./media-formats.json')
const { shell } = require('electron')
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

/** 已安裝版才在背景補一次使用者關聯；開發／預覽版不碰登錄檔。 */
async function initializeAssociations(options = {}) {
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

/** caller 必須先過自己的路徑守衛；這層再確認只讀本機媒體檔。 */
async function openMedia(file, options = {}) {
  if (!mediaKind(file)) return false
  if (!path.isAbsolute(file) || file.includes('\0')) throw fail('媒體路徑不合法')
  const stats = await fs.stat(file).catch(() => null)
  if (!stats?.isFile()) throw fail('找不到這個媒體檔案')
  const exe = options.exe || resolveProbeExe({ resourcesPath: options.resourcesPath, folder: 'media', name: 'axondeck-media.exe' })
  if (!exe || !await fs.access(exe).then(() => true, () => false)) throw fail('原生播放器尚未安裝，請重新安裝 AxonDeck')
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
/** Windows 沒有預設程式、但內容是文字（`.foo`、沒有副檔名的 LICENSE…）。 */
async function isUnknownText(file) {
  const state = await associationOf(file)
  return (state === 'none' || state === 'choices') && await looksLikeText(file)
}
/**
 * 交給 Windows 開；沒有預設程式時它只會跳「要用什麼開啟」，所以先攔下來：文字開自家編輯器。
 * 二進位檔有候選程式才讓 Windows 問（那個清單有用），完全沒人接手就回 App 內的訊息。
 * @param {string} target 實際要開的路徑（捷徑就是捷徑本身，啟動參數才不會被跳過）
 * @param {string} [real] 判斷關聯與內容用的真實檔案
 */
async function openSystem(target, real = target) {
  const state = await associationOf(real)
  if (state !== 'none' && state !== 'choices') return shell.openPath(target)
  if (await looksLikeText(real) && await editorOpener(real, { force: true })) return ''
  if (state === 'choices') return shell.openPath(target)
  throw Object.assign(fail('沒有程式能開這種檔案，它也不是文字檔。要指定程式請用右鍵選單的「開啟檔案」。'), { code: 'NO_APP' })
}
/** 與 shell.openPath 的回傳方式相同；所有開檔入口共用這條分流（媒體→播放器、文字→編輯器）。 */
async function openPath(file) {
  return await openMedia(file) || await openEditor(file) ? '' : openSystem(file)
}
module.exports = { mediaKind, openMedia, openEditor, openSystem, isUnknownText, looksLikeText, openPath, setThemeGetter, setEditorOpener, initializeAssociations }
