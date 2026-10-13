'use strict'
const { makeInvoke } = require('../ipc-invoke')
function registerAppInstallerIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({ isMainSender, forbidden: '僅主視窗可管理應用程式', code: 'APP_INSTALLER', message: '應用程式管理操作失敗' })
  ipcMain.handle('appInstaller:status', (event) => invoke(event, () => service.snapshot()))
  ipcMain.handle('appInstaller:refresh', (event) => invoke(event, () => service.refresh()))
  ipcMain.handle('appInstaller:start', (event, request) => invoke(event, () => service.start(request)))
  ipcMain.handle('appInstaller:upgradeAll', (event) => invoke(event, () => service.upgradeAll()))
}
module.exports = { registerAppInstallerIpc }
