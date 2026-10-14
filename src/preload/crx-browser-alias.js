// 擴充功能頁與背景 service worker：Chromium 新版原生有 `browser` 命名空間，但 electron-chrome-extensions
// 只把 chrome.tabs／permissions… 補在 `chrome` 上；`self.browser || self.chrome` 的擴充功能（uBlock Origin Lite）
// 會拿到沒補過的那份而當掉。在套件的 preload 之後跑，把 `browser` 指回補好的 `chrome`。
const { contextBridge, webFrame } = require('electron')

const alias = () => {
  if (globalThis.chrome && globalThis.browser !== globalThis.chrome) {
    Object.defineProperty(globalThis, 'browser', { value: globalThis.chrome, configurable: true, writable: true })
  }
}

if (process.type === 'service-worker' || globalThis.location?.href.startsWith('chrome-extension://')) {
  if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: alias })
  else webFrame.executeJavaScript(`(${alias})()`)
}
