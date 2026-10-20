'use strict'

const { makeInvoke } = require('../ipc-invoke')

function registerMiroxenIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({ isMainSender, forbidden: '僅主視窗可操作圖片影像生成',
    code: 'MIROXEN_ERROR', message: '圖片影像引擎操作失敗，請稍後再試' })
  ipcMain.handle('miroxen:status', (event, options) => invoke(event, () => service.status({ checkUpdate: options?.checkUpdate === true })))
  ipcMain.handle('miroxen:start', (event) => invoke(event, () => service.start()))
  ipcMain.handle('miroxen:stop', (event) => invoke(event, () => service.stop()))
  ipcMain.handle('miroxen:openOutput', (event) => invoke(event, () => service.openOutput()))
  ipcMain.handle('miroxen:api', (event) => invoke(event, () => service.api()))
  ipcMain.handle('miroxen:setLan', (event, enabled) => invoke(event, () => service.setLan(enabled === true)))
}

module.exports = { registerMiroxenIpc }
