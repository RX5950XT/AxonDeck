'use strict'
const { BrowserWindow, ipcMain, nativeTheme } = require('electron')
const { makeInvoke } = require('./ipc-invoke')
const fs = require('fs').promises
const path = require('path')
const { EXTENSIONS_PAGE_URL, isExtensionManagerUrl } = require('../shared/browser-url.mjs')
const PRIVILEGES = { scheme: 'axon-extensions', privileges: { standard: true, secure: true, supportFetchAPI: true } }

function createManager({ session, list, change, checkUpdates, installLocal, openStore, openUrl, page, preload }) {
  const assets = new Map([
    ['/pages/browser-extensions.html', [page, 'text/html']],
    ['/scripts/browser-extensions-page.js', [path.join(__dirname, '../renderer/scripts/browser-extensions-page.js'), 'text/javascript']],
    ['/styles/themes.css', [path.join(__dirname, '../renderer/styles/themes.css'), 'text/css']],
    ['/styles/browser-extensions.css', [path.join(__dirname, '../renderer/styles/browser-extensions.css'), 'text/css']]
  ])
  session.protocol.handle('axon-extensions', async (request) => {
    const url = new URL(request.url), asset = assets.get(url.pathname)
    if (url.host !== 'manager' || url.username || url.password || !asset) return new Response('', { status: 404 })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('', { status: 405 })
    try { return new Response(request.method === 'HEAD' ? null : await fs.readFile(asset[0]), { headers: { 'Content-Type': asset[1] + '; charset=utf-8' } }) }
    catch { return new Response('', { status: 500 }) }
  })
  session.registerPreloadScript({ id: 'axondeck-extension-manager', type: 'frame', filePath: preload })
  const invoke = makeInvoke({ isMainSender: (event) => event.sender.session === session
    && event.senderFrame === event.sender.mainFrame && isExtensionManagerUrl(event.senderFrame.url),
    forbidden: '僅擴充功能管理分頁可操作', code: 'EXTENSION_ERROR', message: '擴充功能操作失敗，請稍後再試' })
  ipcMain.handle('browserExtensions:list', (event) => invoke(event, list))
  ipcMain.handle('browserExtensions:change', (event, id, action, value) => invoke(event, () => change(id, action, value, event.sender)))
  ipcMain.handle('browserExtensions:updates', (event) => invoke(event, checkUpdates))
  ipcMain.handle('browserExtensions:installLocal', (event) => invoke(event, () => installLocal(BrowserWindow.fromWebContents(event.sender.hostWebContents || event.sender))))
  ipcMain.handle('browserExtensions:store', (event) => invoke(event, () => openStore(event.sender)))
  function open(id = '', source) {
    const url = new URL(EXTENSIONS_PAGE_URL)
    url.searchParams.set('extension', /^[a-p]{32}$/.test(id) ? id : '')
    url.searchParams.set('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    return openUrl(url.href, source).then(() => undefined)
  }
  return { open }
}
module.exports = { createManager, PRIVILEGES }
