// Chrome 線上應用程式商店（chromewebstore.google.com）的「加到 Chrome」按鈕靠 chrome.webstorePrivate／chrome.management，
// Electron 沒有。這裡補上那幾支，實際安裝交給 main（main/crx-webstore.js → browser-extensions.js 的 install／remove）。
// 只在商店網域的主 frame 掛；main 端同樣只收商店主 frame 的請求，安裝／移除前一律跳原生確認視窗。
const { contextBridge, ipcRenderer } = require('electron')

const STORE_ORIGIN = 'https://chromewebstore.google.com'

function install() {
  const bridge = globalThis.__axonWebstore
  if (!bridge) return
  delete globalThis.__axonWebstore
  const chrome = globalThis.chrome || (globalThis.chrome = {})
  // 擴充功能一裝好，Chromium 會在商店頁重掛它自己的 chrome.management（Electron 裡呼叫了沒反應），把這份蓋掉：
  // 定義成不可改，重掛會失敗、維持這份
  const pin = (name, value) => Object.defineProperty(chrome, name, { value, enumerable: true, writable: false, configurable: false })
  // Chrome 的擴充 API：有 callback 就 callback(結果)，失敗原因放 chrome.runtime.lastError；沒 callback 回 Promise
  const setLastError = (message) => {
    chrome.runtime ||= {}
    try { Object.defineProperty(chrome.runtime, 'lastError', { value: message ? { message } : undefined, configurable: true, writable: true }) } catch { /* 原生欄位改不動就算了 */ }
  }
  const api = (fn) => (...args) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null
    const pending = Promise.resolve().then(() => fn(...args))
    if (!callback) return pending
    pending.then((value) => { setLastError(''); callback(value) }, (error) => {
      setLastError(String(error?.message || error))
      try { callback() } finally { setLastError('') }
    })
  }
  const Result = { SUCCESS: 'success', USER_CANCELLED: 'user_cancelled', INSTALL_ERROR: 'install_error', INSTALL_IN_PROGRESS: 'install_in_progress',
    INVALID_ID: 'invalid_id', MANIFEST_ERROR: 'manifest_error', UNKNOWN_ERROR: 'unknown_error', ALREADY_INSTALLED: 'already_installed' }
  const begin = async (details) => {
    const { result, message } = await bridge.install({ id: String(details?.id || ''), manifest: String(details?.manifest || ''),
      localizedName: String(details?.localizedName || '') })
    // 商店在 callback 裡看 lastError 決定要不要跳「下載錯誤」
    setLastError(result === Result.SUCCESS ? '' : (message || result))
    return result
  }
  pin('webstorePrivate', {
    Result,
    ExtensionInstallStatus: { INSTALLABLE: 'installable', ENABLED: 'enabled', DISABLED: 'disabled', TERMINATED: 'terminated',
      BLOCKED_BY_POLICY: 'blocked_by_policy', CAN_REQUEST: 'can_request', REQUEST_PENDING: 'request_pending',
      FORCE_INSTALLED: 'force_installed', DEPRECATED_MANIFEST_VERSION: 'deprecated_manifest_version', CORRUPTED: 'corrupted' },
    WebGlStatus: { WEBGL_ALLOWED: 'webgl_allowed', WEBGL_BLOCKED: 'webgl_blocked' },
    MV2DeprecationStatus: { INACTIVE: 'inactive', WARNING: 'warning', SOFT_DISABLE: 'soft_disable' },
    beginInstallWithManifest3: (details, callback) => {
      const pending = begin(details)
      if (typeof callback === 'function') pending.then(callback, () => callback(Result.UNKNOWN_ERROR))
      else return pending
    },
    // 下載與載入在 begin 那一步已經做完（確認視窗按下去就裝），這裡只回成功
    completeInstall: api(() => Result.SUCCESS),
    install: api(() => Result.SUCCESS),
    getExtensionStatus: api((id) => bridge.status(String(id || ''))),
    getFullChromeVersion: api(() => ({ version_number: bridge.chromeVersion })),
    getBrowserLogin: api(() => ({ login: '' })),
    getStoreLogin: api(() => ''),
    setStoreLogin: api(() => true),
    getWebGLStatus: api(() => 'webgl_allowed'),
    getMV2DeprecationStatus: api(() => 'inactive'),
    getReferrerChain: api(() => 'EgIIAA=='),
    getIsLauncherEnabled: api(() => false),
    enableAppLauncher: api(() => undefined),
    isInIncognitoMode: api(() => false),
    isPendingCustodianApproval: api(() => false)
  })
  // 事件的 listener 留在頁面這邊（跨 contextBridge 的函式每次都是新代理，remove 會對不上）
  const listeners = { installed: new Set(), uninstalled: new Set(), enabled: new Set(), disabled: new Set() }
  bridge.onEvent((kind, payload) => {
    for (const fn of listeners[kind] || []) { try { fn(payload) } catch (error) { console.error(error) } }
  })
  const event = (kind) => ({
    addListener: (fn) => { if (typeof fn === 'function') listeners[kind].add(fn) },
    removeListener: (fn) => { listeners[kind].delete(fn) },
    hasListener: (fn) => listeners[kind].has(fn)
  })
  pin('management', {
    getAll: api(() => bridge.list()),
    get: api(async (id) => {
      const found = (await bridge.list()).find((ext) => ext.id === id)
      if (!found) throw new Error(`Failed to find extension with id ${id}.`)
      return found
    }),
    setEnabled: api((id, enabled) => bridge.setEnabled(String(id || ''), !!enabled)),
    uninstall: api((id) => bridge.uninstall(String(id || ''))),
    onInstalled: event('installed'),
    onUninstalled: event('uninstalled'),
    onEnabled: event('enabled'),
    onDisabled: event('disabled')
  })
}

if (process.type !== 'service-worker' && globalThis.location?.origin === STORE_ORIGIN && globalThis.top === globalThis) {
  contextBridge.exposeInMainWorld('__axonWebstore', {
    chromeVersion: process.versions.chrome,
    status: (id) => ipcRenderer.invoke('crxWebstore:status', id),
    list: () => ipcRenderer.invoke('crxWebstore:list'),
    install: (details) => ipcRenderer.invoke('crxWebstore:install', details),
    uninstall: (id) => ipcRenderer.invoke('crxWebstore:uninstall', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('crxWebstore:setEnabled', id, enabled),
    // 只接一次（install() 一開始就把 __axonWebstore 刪掉，頁面拿不到）
    onEvent: (fn) => { ipcRenderer.on('crxWebstore:event', (_event, kind, payload) => fn(String(kind), payload)) }
  })
  contextBridge.executeInMainWorld({ func: install })
}
