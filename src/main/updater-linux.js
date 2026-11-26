'use strict'

/**
 * Linux 的更新策略：依「怎麼裝的」決定用哪個 electron-updater 類別、能不能自動套用。
 *
 * - `appimage`（有 `APPIMAGE` 環境變數）：AppImageUpdater，下載後替換 AppImage 重啟（原本的行為）。
 * - `deb`／`rpm`／`pacman`（electron-builder 在套件裡放的 `resources/package-type`）：
 *   有圖形化提權工具（pkexec／kdesudo／gksudo／beesu）＋套件管理器時，用 DebUpdater／RpmUpdater／PacmanUpdater，
 *   按「重新啟動並安裝」會跳系統密碼框，用 dpkg／apt、dnf／zypper／rpm 安裝；
 *   沒有的話改成「手動」：不自動下載，按鈕開 GitHub Release 頁讓使用者下載新的套件。
 * - `linux`（`linux-unpacked` 目錄版、tar 解開的）：一律手動。
 *
 * 明確依 `APPIMAGE` 選 AppImageUpdater，不交給 electron-updater 的 `autoUpdater` 自己猜：
 * 同一次打包 AppImage／deb／rpm 共用 `linux-unpacked`，deb 先打的話 `package-type` 可能混進 AppImage，
 * 它就會被當成 deb 更新。
 */

const fs = require('fs')
const path = require('path')

const PACKAGE_KINDS = new Set(['deb', 'rpm', 'pacman'])
const CLASS_BY_KIND = { appimage: 'AppImageUpdater', deb: 'DebUpdater', rpm: 'RpmUpdater', pacman: 'PacmanUpdater' }
const GRAPHICAL_SUDO = ['pkexec', 'kdesudo', 'gksudo', 'beesu']
const PACKAGE_MANAGERS = { deb: ['dpkg', 'apt'], rpm: ['zypper', 'dnf', 'yum', 'rpm'], pacman: ['pacman'] }
const EXT_BY_KIND = { appimage: 'AppImage', deb: 'deb', rpm: 'rpm', pacman: 'pacman' }

/**
 * @param {{ env?: NodeJS.ProcessEnv, resourcesPath?: string }} [opts]
 * @returns {'appimage'|'deb'|'rpm'|'pacman'|'linux'}
 */
function packageKind(opts = {}) {
  const env = opts.env || process.env
  if (env.APPIMAGE) return 'appimage'
  try {
    const kind = fs.readFileSync(path.join(opts.resourcesPath || process.resourcesPath || '', 'package-type'), 'utf8').trim()
    if (PACKAGE_KINDS.has(kind)) return /** @type {'deb'|'rpm'|'pacman'} */ (kind)
  } catch {
    // 沒有＝目錄版／tar
  }
  return 'linux'
}

/** @param {string} name @param {NodeJS.ProcessEnv} [env] */
function hasCommand(name, env = process.env) {
  return String(env.PATH || '').split(':').filter(Boolean).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/**
 * 這種安裝方式能不能在 App 裡直接套用更新。
 * @param {string} kind
 * @param {{ env?: NodeJS.ProcessEnv, isRoot?: boolean }} [opts]
 */
function canAutoInstall(kind, opts = {}) {
  const env = opts.env || process.env
  if (kind === 'appimage') return true
  if (!PACKAGE_KINDS.has(kind)) return false
  if (!PACKAGE_MANAGERS[kind].some((pm) => hasCommand(pm, env))) return false
  const isRoot = opts.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0)
  // 沒有圖形化提權工具時 electron-updater 會退回沒有終端機可以輸入密碼的 sudo，裝不起來
  return isRoot || GRAPHICAL_SUDO.some((tool) => hasCommand(tool, env))
}

/**
 * 建 electron-updater 實例。測試／舊版模組沒有對應類別時退回 `autoUpdater`。
 * @param {any} mod require('electron-updater')
 * @param {string} kind
 */
function createUpdater(mod, kind) {
  const Klass = mod && mod[CLASS_BY_KIND[kind] || 'AppImageUpdater']
  if (typeof Klass === 'function') return new Klass()
  return mod.autoUpdater
}

/** 手動模式要開的頁面（renderer 不指定網址，一律由 main 組） */
function releaseUrl(version, publish = { owner: 'RX5950XT', repo: 'AxonDeck' }) {
  const tag = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(String(version || '')) ? `tag/v${version}` : 'latest'
  return `https://github.com/${publish.owner}/${publish.repo}/releases/${tag}`
}

/** 這台該下載哪個檔（給文案用）：x64 → amd64.deb／x86_64.rpm，arm64 → arm64.deb／aarch64.rpm */
function assetName(kind, version, arch = process.arch) {
  const ext = EXT_BY_KIND[kind] || 'AppImage'
  const archName = ext === 'deb'
    ? (arch === 'x64' ? 'amd64' : arch)
    : ext === 'rpm' || ext === 'AppImage'
      ? (arch === 'x64' ? 'x86_64' : ext === 'rpm' && arch === 'arm64' ? 'aarch64' : arch)
      : arch
  return `AxonDeck-${version}-linux-${archName}.${ext}`
}

/** 手動安裝的指令提示 */
function installHint(kind, file) {
  if (kind === 'deb') return `sudo apt install ./${file}`
  if (kind === 'rpm') return `sudo dnf install ./${file}（openSUSE：sudo zypper install ./${file}）`
  if (kind === 'pacman') return `sudo pacman -U ./${file}`
  return ''
}

/**
 * 給 updater.js 的文案。
 * @param {string} kind
 * @param {boolean} auto 能不能在 App 內套用
 */
function messages(kind, auto) {
  const label = kind === 'appimage' ? 'AppImage' : kind === 'linux' ? '目錄版' : `.${EXT_BY_KIND[kind]} 套件`
  return {
    label,
    downloaded: (ver) => (kind === 'appimage'
      ? `v${ver} 已下載，重新啟動即可套用更新（AppImage）。`
      : `v${ver} 已下載，按「重新啟動並安裝」會跳出系統密碼視窗，用套件管理器安裝 ${label}。`),
    manualAvailable: (ver) => {
      const file = assetName(kind === 'linux' ? 'appimage' : kind, ver)
      const hint = installHint(kind, file)
      return `發現新版本 v${ver}：${label}請到 GitHub Releases 下載 ${file}${hint ? `，再執行 ${hint}` : ''}。按「前往下載頁」開啟。`
    },
    note: auto
      ? (kind === 'appimage' ? '' : `${label}：更新會用套件管理器安裝，需要系統管理員密碼。`)
      : kind === 'linux'
        ? '目前是目錄版（沒有安裝），不能在 App 內套用更新；有新版時會帶你到下載頁。'
        : `${label}：這台沒有圖形化的提權工具（pkexec），有新版時會帶你到下載頁手動安裝。`
  }
}

module.exports = { packageKind, canAutoInstall, createUpdater, releaseUrl, assetName, installHint, messages, hasCommand }
