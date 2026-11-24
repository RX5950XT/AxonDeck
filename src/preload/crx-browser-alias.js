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
  // 套件的 webNavigation 事件不看 addListener 第二個參數（網址篩選），每次導覽都通知。ScriptCat 只想聽腳本安裝頁，
  // 卻被網頁裡帶 `#url=` 的 iframe（HF 的 Stripe）觸發，接著 chrome.tabs.goBack() 把使用者拉回上一頁。照 Chrome 的 UrlFilter 補上篩選
  if (chrome?.webNavigation) {
    const portOf = (u) => Number(u.port || ({ 'http:': 80, 'https:': 443 })[u.protocol] || 0)
    const matches = (filter, href) => {
      let u
      try { u = new URL(href) } catch { return false }
      const bare = href.split('#')[0]
      const host = u.hostname
      const path = u.pathname
      const query = u.search.slice(1)
      const checks = {
        hostContains: (v) => `.${host}`.includes(v), hostEquals: (v) => host === v, hostPrefix: (v) => host.startsWith(v), hostSuffix: (v) => host.endsWith(v),
        pathContains: (v) => path.includes(v), pathEquals: (v) => path === v, pathPrefix: (v) => path.startsWith(v), pathSuffix: (v) => path.endsWith(v),
        queryContains: (v) => query.includes(v), queryEquals: (v) => query === v, queryPrefix: (v) => query.startsWith(v), querySuffix: (v) => query.endsWith(v),
        urlContains: (v) => bare.includes(v), urlEquals: (v) => bare === v, urlPrefix: (v) => bare.startsWith(v), urlSuffix: (v) => bare.endsWith(v),
        urlMatches: (v) => new RegExp(v).test(bare), originAndPathMatches: (v) => new RegExp(v).test(u.origin + path),
        schemes: (v) => v.includes(u.protocol.slice(0, -1)),
        ports: (v) => v.some((p) => (Array.isArray(p) ? portOf(u) >= p[0] && portOf(u) <= p[1] : portOf(u) === p))
      }
      // 不認得的條件當成不符合：寧可少通知，也不要再把不相干的導覽丟給套件
      return Object.entries(filter || {}).every(([key, value]) => checks[key]?.(value) === true)
    }
    for (const event of Object.values(chrome.webNavigation)) {
      if (!event || typeof event.addListener !== 'function' || typeof event.removeListener !== 'function') continue
      const add = event.addListener.bind(event)
      const remove = event.removeListener.bind(event)
      const wrapped = new Map()
      event.addListener = (callback, filters) => {
        const urls = Array.isArray(filters?.url) ? filters.url : null
        if (!urls) return add(callback)
        const listener = (details, ...rest) => {
          if (urls.some((filter) => matches(filter, details?.url))) callback(details, ...rest)
        }
        wrapped.set(callback, listener)
        add(listener)
      }
      event.removeListener = (callback) => {
        remove(wrapped.get(callback) || callback)
        wrapped.delete(callback)
      }
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
