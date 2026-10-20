'use strict'
const { contextBridge, ipcRenderer } = require('electron')
if (globalThis.location?.href.split(/[?#]/)[0] === 'axon-extensions://manager/pages/browser-extensions.html') contextBridge.exposeInMainWorld('browserExtensionsAPI', {
  list: () => ipcRenderer.invoke('browserExtensions:list'),
  change: (id, action, value) => ipcRenderer.invoke('browserExtensions:change', id, action, value),
  updates: () => ipcRenderer.invoke('browserExtensions:updates'),
  installLocal: () => ipcRenderer.invoke('browserExtensions:installLocal'),
  store: () => ipcRenderer.invoke('browserExtensions:store')
})
