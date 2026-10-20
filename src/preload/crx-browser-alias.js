// 擴充功能頁與背景 service worker：Chromium 新版原生有 `browser` 命名空間，但 electron-chrome-extensions
// 只把 chrome.tabs／permissions… 補在 `chrome` 上；`self.browser || self.chrome` 的擴充功能（uBlock Origin Lite）
// 會拿到沒補過的那份而當掉。在套件的 preload 之後跑，把 `browser` 指回補好的 `chrome`。
const { contextBridge, webFrame, ipcRenderer } = require('electron')

const alias = () => {
  const chrome = globalThis.chrome
  if (chrome?.tabs && chrome.tabs.TAB_ID_NONE === undefined) chrome.tabs.TAB_ID_NONE = -1
  if (chrome?.windows) {
    if (chrome.windows.WINDOW_ID_NONE === undefined) chrome.windows.WINDOW_ID_NONE = -1
    if (chrome.windows.WINDOW_ID_CURRENT === undefined) chrome.windows.WINDOW_ID_CURRENT = -2
  }
  if (chrome?.contextMenus && globalThis.__axonContextMenuUpdate) {
    const update = globalThis.__axonContextMenuUpdate
    chrome.contextMenus.update = (id, properties, callback) => {
      const result = update(id, properties).then((response) => {
        if (!response.ok) throw new Error(response.error?.message || 'Menu update failed.')
      })
      if (callback) {
        result.then(() => callback(), (error) => {
          const descriptor = Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError')
          Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, value: { message: error.message } })
          try { callback() }
          finally {
            if (descriptor) Object.defineProperty(chrome.runtime, 'lastError', descriptor)
            else delete chrome.runtime.lastError
          }
        })
        return
      }
      return result
    }
    delete globalThis.__axonContextMenuUpdate
  }
  for (const action of new Set([chrome?.action, chrome?.browserAction].filter(Boolean))) {
    if (typeof action.setIcon !== 'function') continue
    const setIcon = action.setIcon.bind(action)
    action.setIcon = (details, callback) => {
      const localPath = (value) => {
        if (typeof value !== 'string') return value
        try {
          const url = new URL(value)
          if (url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id) {
            const relative = decodeURIComponent(url.pathname.slice(1))
            return relative.startsWith('/') || relative.startsWith('\\') || /^[a-z]:/i.test(relative) || relative.split(/[\\/]/).includes('..')
              ? value : relative
          }
        } catch {}
        return value
      }
      const iconPath = details?.path
      const path = typeof iconPath === 'string' ? localPath(iconPath)
        : iconPath && typeof iconPath === 'object'
          ? Object.fromEntries(Object.entries(iconPath).map(([size, value]) => [size, localPath(value)]))
          : iconPath
      return setIcon(path === iconPath ? details : { ...details, path }, callback)
    }
  }
  if (globalThis.chrome && globalThis.browser !== globalThis.chrome) {
    Object.defineProperty(globalThis, 'browser', { value: globalThis.chrome, configurable: true, writable: true })
  }
}

if (process.type === 'service-worker' || globalThis.location?.href.startsWith('chrome-extension://')) {
  contextBridge.exposeInMainWorld('__axonContextMenuUpdate', (id, properties) => ipcRenderer.invoke('crx-context-menu-update', id, properties))
  if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: alias })
  else webFrame.executeJavaScript(`(${alias})()`)
}
