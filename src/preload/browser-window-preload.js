'use strict'

/**
 * 彈出成獨立視窗的瀏覽器分頁：工具列頁的 preload。只開放操作「自己這扇窗的網頁」的幾個動作，
 * main 端一律用 sender 找回那扇窗（見 main/browser-window.js），送不出別的網頁的 id。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserWindowAPI', {
  navigate: (action, url) => ipcRenderer.invoke('browserWindow:navigate', action, url),
  onState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('browserWindow:state', handler)
    return () => ipcRenderer.removeListener('browserWindow:state', handler)
  },
  // 跟主視窗 electronAPI.workspace 同名同參數，browser-actions.js 可以直接拿來用（guestId 這邊用不到）
  extensionActions: () => ipcRenderer.invoke('browserWindow:extensionActions'),
  extensionActivate: (_guestId, extensionId, anchor) => ipcRenderer.invoke('browserWindow:extensionActivate', extensionId, anchor),
  extensionsMenu: (_guestId, anchor) => ipcRenderer.invoke('browserWindow:extensionsMenu', anchor),
  onExtensionsChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('browserWindow:extensionsChanged', handler)
    return () => ipcRenderer.removeListener('browserWindow:extensionsChanged', handler)
  }
})
