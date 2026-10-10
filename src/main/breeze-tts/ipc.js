'use strict'

const { makeInvoke } = require('../ipc-invoke')

function registerBreezeIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({ isMainSender, forbidden: '僅主視窗可操作語音生成',
    code: 'BREEZE_ERROR', message: '語音操作失敗，請稍後再試' })
  ipcMain.handle('breeze:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('breeze:generate', (event, options) => invoke(event, () => service.generate(options)))
  ipcMain.handle('breeze:cancel', (event, options) => invoke(event, () => service.cancel(options)))
  ipcMain.handle('breeze:pickAudio', (event, options) => invoke(event, () => service.pickAudio(options)))
  ipcMain.handle('breeze:voices', (event) => invoke(event, () => service.voices()))
  ipcMain.handle('breeze:saveVoice', (event, options) => invoke(event, () => service.saveVoice(options)))
  ipcMain.handle('breeze:removeVoice', (event, options) => invoke(event, () => service.removeVoice(options)))
  ipcMain.handle('breeze:saveAudio', (event, options) => invoke(event, () => service.saveAudio(options)))
}

module.exports = { registerBreezeIpc }
