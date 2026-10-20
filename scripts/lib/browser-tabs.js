'use strict'
const { BrowserWindow, WebContentsView } = require('electron')

// 模組驗收也用同一扇窗的真分頁，避免拿獨立視窗冒充分頁。
function browserTabs(session, attach) {
  const host = new BrowserWindow({ show: false, width: 1060, height: 760, webPreferences: { sandbox: true, contextIsolation: true } })
  const tabs = []
  const layout = () => {
    const [width, height] = host.getContentSize()
    for (const tab of tabs) tab.view.setBounds({ x: 0, y: 0, width, height })
  }
  host.on('resize', layout)
  const openUrl = async (url) => {
    for (const tab of tabs) if (!tab.isDestroyed()) tab.view.setVisible(false)
    const view = new WebContentsView({ webPreferences: { session, sandbox: true, contextIsolation: true } })
    host.contentView.addChildView(view)
    const contents = view.webContents
    const tab = { view, webContents: contents, isDestroyed: () => contents.isDestroyed(),
      destroy: () => { host.contentView.removeChildView(view); contents.close() },
      showInactive: () => { for (const row of tabs) if (!row.isDestroyed()) row.view.setVisible(row === tab); host.showInactive() },
      setSize: (width, height) => host.setSize(width, height) }
    tabs.push(tab); layout(); attach(view.webContents, host)
    await view.webContents.loadURL(url)
  }
  const find = (part) => tabs.find((tab) => !tab.isDestroyed() && tab.webContents.getURL().includes(part))
  host.on('closed', () => { for (const tab of tabs) if (!tab.isDestroyed()) tab.webContents.close() })
  return { host, tabs, openUrl, find }
}
module.exports = { browserTabs }
