/**
 * chrome.identity.launchWebAuthFlow 的 main 端（preload/crx-identity.js 呼叫）：在擴充功能同一個分區開登入小視窗，
 * 一導到 `https://<擴充功能 ID>.chromiumapp.org/…` 就攔下那個網址交回（跟 Chrome 一樣，不真的去連那個網域）。
 * 擴充功能 ID 一律從呼叫端的網址／service worker scope 取，不信任頁面自己報的。
 */
const { BrowserWindow, ipcMain } = require('electron')

const ID_RE = /^[a-p]{32}$/
const CHANNEL = 'crx-identity-launch'
const QUIET_MS = 15_000

/** @param {string} url */
function extensionIdOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'chrome-extension:' && ID_RE.test(u.hostname) ? u.hostname : ''
  } catch { return '' }
}

/** 是不是這個擴充功能的回傳網址 */
function isRedirect(url, extensionId) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === `${extensionId}.chromiumapp.org`
  } catch { return false }
}

/**
 * @param {import('electron').Session} session
 * @param {string} extensionId
 * @param {{ url?: string, interactive?: boolean }} details
 * @returns {Promise<string>}
 */
function launchWebAuthFlow(session, extensionId, details) {
  const url = String(details?.url || '')
  if (!ID_RE.test(extensionId)) return Promise.reject(new Error('Invalid extension.'))
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Authorization page could not be loaded.'))
  const interactive = !!details?.interactive
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ width: 520, height: 720, show: false, autoHideMenuBar: true, title: '登入',
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    let settled = false
    // 不互動模式：沒辦法不靠使用者就拿到結果，比照 Chrome 回失敗
    const timer = interactive ? null : setTimeout(() => finish(new Error('User interaction required.')), QUIET_MS)
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const catchRedirect = (event, legacyUrl) => {
      const next = event?.url || legacyUrl || ''
      if (!isRedirect(next, extensionId)) return
      event.preventDefault()
      finish(null, next)
    }
    win.webContents.on('will-redirect', catchRedirect)
    win.webContents.on('will-navigate', catchRedirect)
    win.webContents.on('did-fail-load', (_event, _code, _desc, failedUrl, isMainFrame) => {
      if (isMainFrame && isRedirect(failedUrl, extensionId)) finish(null, failedUrl)
    })
    win.once('ready-to-show', () => { if (interactive && !settled) win.show() })
    win.on('closed', () => finish(new Error('The user did not approve access.')))
    win.loadURL(url).catch(() => { /* 導去回傳網址時 loadURL 會以中斷收場，結果已由上面攔到 */ })
  })
}

/** @param {import('electron').Session} session */
function registerIdentity(session) {
  ipcMain.handle(CHANNEL, (event, details) => {
    if (event.sender.session !== session) throw new Error('Invalid extension.')
    return launchWebAuthFlow(session, extensionIdOf(event.senderFrame?.url || ''), details)
  })
  const workers = new WeakSet()
  session.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
    if (runningStatus !== 'starting') return
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker?.scope?.startsWith('chrome-extension://') || workers.has(worker)) return
    workers.add(worker)
    worker.ipc.handle(CHANNEL, (_event, details) => launchWebAuthFlow(session, extensionIdOf(worker.scope), details))
  })
}

module.exports = { registerIdentity, launchWebAuthFlow, extensionIdOf, isRedirect }
