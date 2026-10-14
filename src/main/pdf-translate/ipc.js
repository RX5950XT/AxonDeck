'use strict'

const { makeInvoke } = require('../ipc-invoke')

function registerPdfTranslateIpc({ ipcMain, service, isMainSender }) {
  const invoke = makeInvoke({ isMainSender, forbidden: '僅主視窗可操作 PDF 翻譯',
    code: 'PDF_ERROR', message: 'PDF 翻譯失敗，請檢查檔案與模型後再試' })
  ipcMain.handle('pdfTranslate:pick', (event) => invoke(event, () => service.pick()))
  ipcMain.handle('pdfTranslate:inspect', (event, filename) => invoke(event, () => service.inspect(filename)))
  ipcMain.handle('pdfTranslate:pasteImage', (event, payload) => invoke(event, () => service.pasteImage(payload)))
  ipcMain.handle('pdfTranslate:start', (event, options) => invoke(event, () => service.start(options)))
  ipcMain.handle('pdfTranslate:cancel', (event, jobId) => invoke(event, () => service.cancel(jobId)))
  ipcMain.handle('pdfTranslate:status', (event) => invoke(event, () => service.status()))
  ipcMain.handle('pdfTranslate:save', (event, jobId) => invoke(event, () => service.save(jobId)))
}

module.exports = { registerPdfTranslateIpc }
