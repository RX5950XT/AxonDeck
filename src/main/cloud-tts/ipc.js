'use strict'

const { makeInvoke } = require('../ipc-invoke')

function registerCloudTtsIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({ isMainSender, forbidden: '僅主視窗可操作語音生成', code: 'CLOUD_TTS', message: '雲端語音操作失敗' })
  ipcMain.handle('cloudTts:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('cloudTts:generate', (event, options) => invoke(event, () => service.generate(options)))
  ipcMain.handle('cloudTts:cancel', (event, options) => invoke(event, () => service.cancel(options)))
  ipcMain.handle('cloudTts:saveAudio', (event, options) => invoke(event, () => service.saveAudio(options)))
}

module.exports = { registerCloudTtsIpc }
