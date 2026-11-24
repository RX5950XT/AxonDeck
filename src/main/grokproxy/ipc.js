'use strict'

/**
 * grokProxy:* IPC。比照 agy/ipc.js：只有主視窗能呼叫，回傳一律 { ok, data } / { ok, error }。
 */
const { makeInvoke } = require('../ipc-invoke')

function registerGrokProxyIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作反向代理',
    code: 'GROK_PROXY_ERROR',
    message: '反向代理操作失敗'
  })

  ipcMain.handle('grokProxy:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('grokProxy:start', (event) => invoke(event, async () => {
    const result = await service.start()
    return { ...result, ...(await service.status()) }
  }))
  ipcMain.handle('grokProxy:stop', (event) => invoke(event, async () => {
    await service.stop()
    return service.status()
  }))
  ipcMain.handle('grokProxy:saveSettings', (event, settings) => invoke(event, () => service.saveSettings(settings)))
  ipcMain.handle('grokProxy:regenerateKey', (event) => invoke(event, () => service.regenerateApiKey()))
  ipcMain.handle('grokProxy:logs', (event, query) => invoke(event, () => service.getLogs(query)))
  ipcMain.handle('grokProxy:stats', (event, query) => invoke(event, () => service.getStats(query)))
  ipcMain.handle('grokProxy:models', (event, force) => invoke(event, () => service.listModels({ force: force === true })))
  ipcMain.handle('grokProxy:clearLogs', (event) => invoke(event, () => service.clearLogs()))
  ipcMain.handle('grokProxy:test', (event) => invoke(event, () => service.selfTest()))
}

module.exports = { registerGrokProxyIpc }
