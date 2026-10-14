// chrome.identity（Electron 沒有）：launchWebAuthFlow／getRedirectURL，擴充功能的 Google 等第三方登入靠它（Read Frog…）。
// 要排在 electron-chrome-extensions 的 preload 之前：它最後會 Object.freeze(chrome)，晚一步就加不上去。
// 登入視窗由 main 開（main/crx-identity.js）。
const { contextBridge, ipcRenderer, webFrame } = require('electron')

function install() {
  const chrome = globalThis.chrome
  const bridge = globalThis.__axonIdentity
  if (!chrome || !bridge || chrome.identity?.launchWebAuthFlow) return
  const id = chrome.runtime?.id || ''
  const getRedirectURL = (path = '') => `https://${id}.chromiumapp.org/${String(path).replace(/^\/+/, '')}`
  const launchWebAuthFlow = (details, callback) => {
    const pending = bridge.launch({ url: String(details?.url || ''), interactive: !!details?.interactive })
    if (typeof callback !== 'function') return pending
    pending.then((url) => callback(url), (error) => {
      // callback 版跟 Chrome 一樣：失敗時 callback(undefined)，原因放 chrome.runtime.lastError
      const message = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      try { Object.defineProperty(chrome.runtime, 'lastError', { value: { message }, configurable: true }) } catch { /* 原生欄位改不動就算了 */ }
      try { callback(undefined) } finally { try { delete chrome.runtime.lastError } catch { /* 同上 */ } }
    })
  }
  Object.defineProperty(chrome, 'identity', { value: { ...(chrome.identity || {}), launchWebAuthFlow, getRedirectURL }, enumerable: true, configurable: true })
}

if (process.type === 'service-worker' || globalThis.location?.href.startsWith('chrome-extension://')) {
  contextBridge.exposeInMainWorld('__axonIdentity', { launch: (details) => ipcRenderer.invoke('crx-identity-launch', details) })
  if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: install })
  else webFrame.executeJavaScript(`(${install})()`)
}
