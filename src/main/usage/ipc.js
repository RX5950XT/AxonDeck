'use strict'

const { makeInvoke } = require('../ipc-invoke')

function registerUsageIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可查詢額度',
    publicError: (error) => service.publicError(error)
  })

  ipcMain.handle('usage:load', (event) => invoke(event, () => service.load()))
  ipcMain.handle('usage:sync', (event) => invoke(event, () => service.sync()))
  ipcMain.handle('usage:saveSettings', (event, settings) => (
    invoke(event, () => service.saveSettings(settings))
  ))
  ipcMain.handle('usage:redeemCodexReset', (event, creditId) => (
    invoke(event, () => service.redeemCodexReset(creditId))
  ))
  ipcMain.handle('usage:claudeAccounts', (event) => invoke(event, () => service.listClaudeAccounts()))
  ipcMain.handle('usage:claudeSwitch', (event, id) => invoke(event, () => service.switchClaudeAccount(id)))
  ipcMain.handle('usage:claudeRemove', (event, id) => invoke(event, () => service.removeClaudeAccount(id)))
  ipcMain.handle('usage:claudeLogin', (event) => invoke(event, () => service.loginClaudeAccount()))
  ipcMain.handle('usage:claudeLoginCancel', (event) => invoke(event, () => service.cancelClaudeLogin()))
}

module.exports = { registerUsageIpc }
