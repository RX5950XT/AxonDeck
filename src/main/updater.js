'use strict'

/**
 * 應用程式內自動更新（electron-updater + GitHub Releases）。
 * 安裝檔下載會經 `update-mirrors.js` 先走代理（GitHub CDN 在 APAC 會限速到幾十 KB/s）。
 *
 * 為什麼不是 Electron 內建的 autoUpdater：內建那顆在 Windows 上只吃 Squirrel.Windows，
 * 我們打的是 NSIS。electron-updater 讀的是 electron-builder 產出的清單：
 *   - Windows：`latest.yml`（與 Setup .exe 一同上傳）
 *   - Linux AppImage：`latest-linux.yml`（與 .AppImage 一同上傳）
 * sha512 在清單裡，下載完會自己驗，所以**發行時對應平台的 yml 一定要跟產物一起上傳**。
 *
 * 另一個坑：`autoInstallOnAppQuit` 在這個 App 上**沒有作用**——它掛的是 `app.once('quit')`，
 * 而我們的 `before-quit` 收完子程序是走 `app.exit(0)`（不發 quit 事件）。
 * 所以「結束時順便裝好」改由 main.js 在 exit 前呼叫 `installOnQuit()`。
 *
 * Linux：依安裝方式分流（見 updater-linux.js）——AppImage 替換重啟；deb／rpm 有 pkexec 時用
 * electron-updater 的 DebUpdater／RpmUpdater 經套件管理器安裝，否則（含 `linux-unpacked` 目錄版）
 * 改成手動：不自動下載，按鈕開 GitHub Release 頁。清單：x64 讀 `latest-linux.yml`、arm64 讀 `latest-linux-arm64.yml`。
 */

const { app } = require('electron')
const { downloadWithFallback } = require('./update-mirrors')

/** @typedef {'idle'|'checking'|'available'|'downloading'|'downloaded'|'none'|'error'|'unsupported'} UpdateState */

/** @type {import('electron-updater').AppUpdater | null} */
let updater = null
/** @type {(status: object) => void} */
let notify = () => {}
/** 自動下載開關（設定頁的「自動更新」） */
let autoEnabled = true

const state = {
  /** @type {UpdateState} */ state: app.isPackaged ? 'idle' : 'unsupported',
  version: '',
  percent: 0,
  message: app.isPackaged ? '' : '開發模式不檢查更新（只有安裝版才會自動更新）。'
}

function emit(patch) {
  Object.assign(state, patch)
  notify(status())
}

function isLinux() {
  return process.platform === 'linux'
}

/** @type {{ kind: string, auto: boolean, msg: ReturnType<typeof import('./updater-linux').messages> } | null} */
let linuxCache = null

/** Linux 的安裝方式與能不能在 App 內套用（只在 Linux 讀一次） */
function linuxInfo() {
  if (!linuxCache) {
    const linux = require('./updater-linux')
    const kind = linux.packageKind()
    const auto = linux.canAutoInstall(kind)
    linuxCache = { kind, auto, msg: linux.messages(kind, auto) }
  }
  return linuxCache
}

/** Linux 上不能在 App 內套用（目錄版、沒有 pkexec 的 deb／rpm）：只通知，按鈕開下載頁 */
function isManual() {
  return isLinux() && !linuxInfo().auto
}

/** 是否以 AppImage 執行（electron-updater 的 Linux 套用路徑）。 */
function isAppImageRuntime() {
  return Boolean(process.env.APPIMAGE)
}

function downloadedMessage(version) {
  const ver = version || state.version || ''
  if (isLinux()) return linuxInfo().msg.downloaded(ver)
  return `v${ver} 已下載完成，重新啟動即可完成安裝。`
}

function runtimeSupportNote() {
  if (!app.isPackaged) return '開發模式不檢查更新（只有安裝版才會自動更新）。'
  if (isLinux()) return linuxInfo().msg.note
  return ''
}

/** @returns {{state: UpdateState, version: string, percent: number, message: string, currentVersion: string, autoUpdate: boolean, packageKind: string, note: string}} */
function status() {
  return {
    ...state,
    currentVersion: app.getVersion(),
    autoUpdate: autoEnabled,
    packageKind: isLinux() ? linuxInfo().kind : 'nsis',
    manual: isManual(),
    note: runtimeSupportNote()
  }
}

function get() {
  if (updater) return updater
  // 改名前的下載快取（裡面躺著一份 400MB 的舊安裝檔），新名字的快取不會再用到它
  if (app.isPackaged && process.env.LOCALAPPDATA) {
    require('fs').rm(require('path').join(process.env.LOCALAPPDATA, 'voiceink-updater'), { recursive: true, force: true }, () => {})
  }
  let autoUpdater
  try {
    const mod = require('electron-updater')
    // Linux 明確依安裝方式挑類別（AppImage／deb／rpm），Windows 照舊用 autoUpdater（NsisUpdater）
    autoUpdater = isLinux() ? require('./updater-linux').createUpdater(mod, linuxInfo().kind) : mod.autoUpdater
  } catch (err) {
    console.error('[updater] electron-updater 載入失敗')
    emit({
      state: 'unsupported',
      percent: 0,
      message: '此版本未內建自動更新模組。'
    })
    throw err
  }
  autoUpdater.autoDownload = autoEnabled && !isManual()
  // 差分下載在這個 App 上是**反向優化**，一定要關（實測 v1.22.0 → v1.23.0）：
  // blockmap 把 406MB 的安裝檔切成 2 萬塊，比對後仍有 1963 段要下載（220MB），
  // 而 electron-updater 在 GitHub 上走的是「一段一個 HTTP request、完全序列」那條
  // （GitHub 不支援 multipart range，`providerFactory` 寫死 isUseMultipleRangeRequest: false），
  // 還每 100 段強制 sleep 1 秒。實測每段 115KB 的 range 請求 506ms ＝ 約 17 分鐘，
  // 而整包 406MB 單連線 14MB/s 只要 28 秒。省下的 185MB 流量換來 36 倍的時間，
  // 這就是「設定頁更新很慢」的根因。重新評估跑 scripts/probe-updater-diff.js。
  autoUpdater.disableDifferentialDownload = true
  // 交給 main.js 的 before-quit 處理（見檔頭）
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking', message: '正在檢查更新…', percent: 0 }))
  autoUpdater.on('update-available', (info) => emit({
    state: autoEnabled && !isManual() ? 'downloading' : 'available',
    version: info?.version || '',
    percent: 0,
    message: isManual()
      ? linuxInfo().msg.manualAvailable(info?.version || '')
      : autoEnabled
        ? `發現新版本 v${info?.version}，開始下載…`
        : `發現新版本 v${info?.version}，按「下載更新」開始下載。`
  }))
  autoUpdater.on('update-not-available', () => emit({ state: 'none', percent: 0, message: '已經是最新版本。' }))
  autoUpdater.on('download-progress', (p) => emit({
    state: 'downloading',
    percent: Math.round(p?.percent || 0),
    message: `下載中 ${Math.round(p?.percent || 0)}%`
  }))
  autoUpdater.on('update-downloaded', (info) => emit({
    state: 'downloaded',
    version: info?.version || state.version,
    percent: 100,
    message: downloadedMessage(info?.version || state.version)
  }))
  autoUpdater.on('error', (err) => {
    console.error('[updater] update failed')
    const wasDownloading = state.state === 'downloading'
    const msg = String(err?.message || err || '')
    const missingArtifact = /latest(-linux)?\.yml|404|ENOENT|Cannot find channel|no published versions/i.test(msg)
    emit({
      state: missingArtifact && !wasDownloading ? 'unsupported' : 'error',
      percent: 0,
      message: wasDownloading
        ? '下載更新失敗，請稍後再按「檢查更新」重試。'
        : missingArtifact
          ? (isLinux()
            ? '此版本沒有 Linux 更新資訊（需要 GitHub 上的 latest-linux.yml／latest-linux-arm64.yml 與對應的安裝檔）。'
            : '此版本沒有附帶更新資訊（需要 latest.yml）。')
          : '檢查更新失敗（無法連線到 GitHub，或這個版本沒有附帶更新資訊）。'
    })
  })
  try {
    downloadWithFallback(autoUpdater.httpExecutor)
  } catch (err) {
    console.error('[updater] mirror wrap failed')
  }
  updater = autoUpdater
  return updater
}

/**
 * @param {{autoUpdate: boolean, onStatus: (s: object) => void}} opts
 */
function configure({ autoUpdate, onStatus }) {
  autoEnabled = autoUpdate !== false
  if (typeof onStatus === 'function') notify = onStatus
  if (updater) updater.autoDownload = autoEnabled && !isManual()
}

/** 手動模式按「前往下載頁」：開 GitHub Release 頁（網址由 main 組，renderer 不指定） */
function openDownloadPage() {
  const linux = require('./updater-linux')
  const url = linux.releaseUrl(state.version)
  try {
    const { shell } = require('electron')
    if (shell && typeof shell.openExternal === 'function') void shell.openExternal(url).catch(() => {})
  } catch {
    // 沒有 shell（測試）就只改文案
  }
  emit({ message: `已開啟下載頁：${url}` })
  return url
}

/** 預覽可能不附更新設定；明確回報不支援，避免按鈕毫無反應。 */
function hasUpdateConfig() {
  try {
    const fs = require('fs')
    const path = require('path')
    return fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))
  } catch {
    return false
  }
}

/** 手動按「檢查更新」；autoDownload 開著的話會直接接著下載；手動模式已發現新版時這顆鈕就是「下載更新」 */
async function check() {
  if (!app.isPackaged) return status()
  // 連點：第二下進來時已在下載／檢查，再檢查一次失敗會把進行中的下載蓋成 error
  if (state.state === 'downloading' || state.state === 'checking') return status()
  if (state.state === 'available' && updater && isManual()) {
    openDownloadPage()
    return status()
  }
  if (state.state === 'available' && updater) {
    emit({ state: 'downloading', percent: 0, message: `開始下載 v${state.version}…` })
    try {
      updater.downloadUpdate().catch(() => {}) // 失敗由 'error' 事件回報
    } catch {
      emit({ state: 'error', percent: 0, message: '下載更新失敗，請稍後再試。' })
    }
    return status()
  }
  if (!hasUpdateConfig()) {
    emit({ state: 'unsupported', percent: 0, message: '此預覽版未附更新資訊。' })
    return status()
  }
  try {
    await get().checkForUpdates()
  } catch (err) {
    console.error('[updater] check failed')
    const msg = String(err?.message || err || '')
    const missingArtifact = /latest(-linux)?\.yml|404|ENOENT|Cannot find channel|no published versions/i.test(msg)
    emit({
      state: missingArtifact ? 'unsupported' : 'error',
      percent: 0,
      message: missingArtifact
        ? (isLinux()
          ? '此版本沒有 Linux 更新資訊（需要 GitHub 上的 latest-linux.yml／latest-linux-arm64.yml 與對應的安裝檔）。'
          : '此版本沒有附帶更新資訊（需要 latest.yml）。')
        : '檢查更新失敗（無法連線到 GitHub，或這個版本沒有附帶更新資訊）。'
    })
  }
  return status()
}

/** 開機後靜靜看一次（失敗不吵使用者） */
function checkQuietly() {
  if (!app.isPackaged || !autoEnabled || !hasUpdateConfig()) return
  check().catch(() => {})
}

/**
 * 「重新啟動並安裝」：**顯示安裝進度**，裝完自己開起來（`build/installer.nsh` 的 customFinishPage）。
 *
 * 不可以改回靜默（`/S`）：App 一關就兩三分鐘什麼都看不到，實測使用者以為壞了去重開機，
 * 安裝被打斷在「舊版已刪、新版只解一半」，App 整個消失。
 *
 * Linux AppImage：electron-updater 會替換 AppImage 後重啟；非 AppImage 執行時回 false。
 */
function quitAndInstall() {
  if (!app.isPackaged || state.state !== 'downloaded') return false
  if (isManual()) {
    emit({ state: 'error', message: '這個安裝方式不能在 App 內套用更新，請到 GitHub Releases 下載新的套件安裝。' })
    return false
  }
  try {
    get().quitAndInstall(false, true)
    return true
  } catch (err) {
    console.error('[updater] quitAndInstall failed')
    emit({ state: 'error', percent: 0, message: '無法啟動安裝程序，請稍後再試。' })
    return false
  }
}

/**
 * 結束前順手把已下載的更新裝起來（同步，只能在 before-quit 的最後一步呼叫）。
 * 已經走過 quitAndInstall 的話 electron-updater 自己會擋掉重複安裝。
 *
 * `sessionEnding`＝Windows 正在關機／重新開機／登出：這時開安裝程式一定會被砍在半路
 * （舊版刪光、新版沒裝完），留到下次正常結束或按「重新啟動並安裝」再裝。
 * @param {boolean} [sessionEnding]
 */
function installOnQuit(sessionEnding = false) {
  if (sessionEnding) return false
  if (!app.isPackaged || !autoEnabled || state.state !== 'downloaded' || !updater) return false
  // deb／rpm 要跳系統密碼框，不在使用者按「結束」時突然冒出來；只走「重新啟動並安裝」
  if (isLinux() && linuxInfo().kind !== 'appimage') return false
  try {
    return updater.install(true, false)
  } catch (err) {
    console.error('[updater] install on quit failed')
    return false
  }
}

module.exports = {
  configure,
  check,
  checkQuietly,
  quitAndInstall,
  installOnQuit,
  status,
  hasUpdateConfig,
  isAppImageRuntime,
  downloadedMessage
}
