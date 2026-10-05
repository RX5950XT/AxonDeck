'use strict'

const path = require('path')
const fs = require('./raw-fs').promises
const { spawn } = require('child_process')
const formats = require('./media-formats.json')
const { shell } = require('electron')
const { resolveProbeExe } = require('./native-probe')
const types = new Map(Object.entries(formats).flatMap(([kind, list]) => list.map((ext) => [ext, kind])))
let theme = () => 'dark'
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
async function initializedMarker(file) {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead === 1 && buffer.toString('utf8', 0, bytesRead) === ASSOCIATION_MARKER
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  } finally { if (handle) await handle.close() }
}

/** 已安裝版才在背景補一次使用者關聯；開發／預覽版不碰登錄檔。 */
async function initializeAssociations(options = {}) {
  const { isPackaged, isPreview, resourcesPath, userDataPath } = options
  if (!isPackaged || isPreview || !resourcesPath || !userDataPath) return false
  if (associationInitPromise) return associationInitPromise
  associationInitPromise = (async () => {
    const updateManifest = path.join(resourcesPath, 'app-update.yml')
    if (!await fs.access(updateManifest).then(() => true, () => false)) return false

    const marker = path.join(userDataPath, 'media-associations-initialized')
    const alreadyInitialized = await initializedMarker(marker)
    if (alreadyInitialized) return true

    const exe = path.join(resourcesPath, 'media', 'axondeck-media.exe')
    await fs.access(exe)
    await fs.mkdir(userDataPath, { recursive: true })
    await new Promise((resolve, reject) => {
      const child = spawn(exe, ['--initialize'], { detached: true, windowsHide: true, stdio: 'ignore', shell: false })
      child.once('error', () => reject(Object.assign(new Error('MEDIA_ASSOCIATION_INIT_FAILED'), { code: 'MEDIA_ASSOCIATION_INIT_FAILED' })))
      child.once('spawn', () => child.unref())
      child.once('close', (code) => code === 0
        ? resolve()
        : reject(Object.assign(new Error('MEDIA_ASSOCIATION_INIT_FAILED'), { code: 'MEDIA_ASSOCIATION_INIT_FAILED' })))
    })
    await fs.writeFile(marker, ASSOCIATION_MARKER, 'utf8')
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
/** 與 shell.openPath 的回傳方式相同；所有媒體入口共用這條分流。 */
async function openPath(file) {
  return await openMedia(file) ? '' : shell.openPath(file)
}
module.exports = { mediaKind, openMedia, openPath, setThemeGetter, initializeAssociations }
