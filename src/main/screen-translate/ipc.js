'use strict'

const { makeInvoke } = require('../ipc-invoke')

function registerScreenTranslateIpc({ ipcMain, service, isMainSender, isOverlaySender }) {
  const main = makeInvoke({ isMainSender, forbidden: '僅主視窗可開啟螢幕翻譯', message: '無法開啟螢幕翻譯' })
  const invoke = makeInvoke({ isMainSender: (event) => isMainSender(event) || isOverlaySender(event),
    forbidden: '僅翻譯視窗可操作螢幕翻譯', message: '螢幕翻譯操作失敗' })
  ipcMain.handle('screenTranslate:open', (event, options) => main(event, () => service.open(options)))
  ipcMain.handle('screenTranslate:pause', (event, paused) => invoke(event, () => service.pause(paused)))
  ipcMain.handle('screenTranslate:resize', (event, bounds) => invoke(event, () => service.resize(bounds)))
  ipcMain.handle('screenTranslate:close', (event) => invoke(event, () => service.close()))
  ipcMain.handle('screenTranslate:status', (event) => invoke(event, () => service.status()))
}

module.exports = { registerScreenTranslateIpc }
