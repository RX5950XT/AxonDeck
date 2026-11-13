/**
 * Chrome 線上應用程式商店「加到 Chrome」的 main 端（preload/crx-webstore.js 呼叫）。
 * 只收工作區瀏覽器分區、商店網域主 frame 的請求；安裝／移除前跳原生確認視窗（網頁自己按不了），
 * 真正的下載與載入走 browser-extensions.js 的 install／remove，跟右鍵選單、管理頁同一條路。
 */
const { BrowserWindow, dialog, ipcMain } = require('electron')

const STORE_ORIGIN = 'https://chromewebstore.google.com'
const ID_RE = /^[a-p]{32}$/

/** 商店顯示用的權限說明（只拿來給使用者看，真正的 manifest 以下載到的為準） */
function permissionLines(manifest) {
  const hosts = [...(manifest?.host_permissions || []), ...(manifest?.permissions || []).filter((p) => /[:*]/.test(p) || p === '<all_urls>'),
    ...(manifest?.content_scripts || []).flatMap((s) => s?.matches || [])].filter((p) => typeof p === 'string')
  const lines = []
  if (hosts.some((h) => h === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(h))) lines.push('讀取及變更你造訪的所有網站資料')
  else if (hosts.length) lines.push(`讀取及變更這些網站的資料：${[...new Set(hosts)].slice(0, 5).join('、')}`)
  const perms = (manifest?.permissions || []).filter((p) => typeof p === 'string' && !/[:*]/.test(p) && p !== '<all_urls>')
  if (perms.length) lines.push(`權限：${perms.join('、')}`)
  return lines
}

/** 給商店的 chrome.management.ExtensionInfo（商店只看 id／enabled／version 決定按鈕狀態） */
function extensionInfo(ext) {
  return { id: ext.id, name: ext.name, shortName: ext.name, description: ext.description || '', version: ext.version,
    enabled: !!ext.enabled, mayDisable: true, isApp: false, type: 'extension', installType: ext.source === 'local' ? 'development' : 'normal',
    homepageUrl: ext.homepage || '', optionsUrl: '', permissions: ext.permissions || [], hostPermissions: ext.hostPermissions || [],
    offlineEnabled: false, updateUrl: '', icons: [] }
}

/**
 * @param {{ session: import('electron').Session, install: (id: string) => Promise<{ id: string, name: string }>,
 *   remove: (id: string) => Promise<void>, list: () => any[], change: (id: string, action: string, value?: any) => Promise<any>,
 *   confirm?: (parent: import('electron').BrowserWindow | null, opts: { message: string, detail: string, ok: string }) => Promise<boolean> }} opts
 */
function registerWebStore({ session, install, remove, list, change, confirm = askNative }) {
  const installing = new Set()
  const fromStore = (event) => event.sender.session === session && event.senderFrame === event.sender.mainFrame
    && event.senderFrame?.origin === STORE_ORIGIN
  const parentOf = (contents) => BrowserWindow.fromWebContents(contents.hostWebContents || contents) || BrowserWindow.getFocusedWindow()
  const find = (id) => list().find((ext) => ext.id === id)
  const notify = (contents, kind, payload) => { if (!contents.isDestroyed()) contents.send('crxWebstore:event', kind, payload) }
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!fromStore(event)) throw new Error('Not allowed.')
    return fn(event, ...args)
  })

  handle('crxWebstore:status', (_event, id) => {
    if (!ID_RE.test(id)) return 'installable'
    const ext = find(id)
    return !ext ? 'installable' : ext.enabled ? 'enabled' : 'disabled'
  })
  handle('crxWebstore:list', () => list().map(extensionInfo))
  handle('crxWebstore:install', async (event, details) => {
    const id = String(details?.id || '')
    if (!ID_RE.test(id)) return { result: 'invalid_id' }
    if (installing.has(id)) return { result: 'install_in_progress' }
    if (find(id)?.enabled) return { result: 'already_installed' }
    let manifest
    try { manifest = JSON.parse(String(details?.manifest || '{}')) } catch { return { result: 'manifest_error' } }
    const name = String(details?.localizedName || manifest?.name || id).slice(0, 120)
    installing.add(id)
    try {
      const ok = await confirm(parentOf(event.sender), { message: `要新增「${name}」嗎？`,
        detail: ['這個擴充功能會安裝到 AxonDeck 的瀏覽器。', ...permissionLines(manifest)].join('\n'), ok: '新增擴充功能' })
      if (!ok) return { result: 'user_cancelled', message: 'User cancelled install' }
      // 之前在管理頁停用過：直接裝會照舊停用，商店按鈕會一直顯示「加到 Chrome」；從商店按就是要用，順便啟用
      if (find(id) && !find(id).enabled) await change(id, 'enabled', true)
      else await install(id)
      const ext = find(id)
      if (ext) notify(event.sender, 'installed', extensionInfo(ext))
      return { result: 'success' }
    } catch (error) {
      console.warn('[crx-webstore] 安裝失敗:', id, error?.message || error)
      return { result: 'install_error', message: '安裝失敗，請稍後再試' }
    } finally {
      installing.delete(id)
    }
  })
  handle('crxWebstore:uninstall', async (event, id) => {
    const ext = ID_RE.test(id) && find(id)
    if (!ext) throw new Error(`Failed to find extension with id ${id}.`)
    const ok = await confirm(parentOf(event.sender), { message: `要移除「${ext.name}」嗎？`, detail: '移除後擴充功能的資料也會一起刪除。', ok: '移除' })
    if (!ok) throw new Error('User cancelled uninstall.')
    await remove(id)
    notify(event.sender, 'uninstalled', id)
  })
  handle('crxWebstore:setEnabled', async (event, id, enabled) => {
    if (!ID_RE.test(id) || !find(id)) throw new Error(`Failed to find extension with id ${id}.`)
    await change(id, 'enabled', !!enabled)
    const ext = find(id)
    if (ext) notify(event.sender, enabled ? 'enabled' : 'disabled', extensionInfo(ext))
  })
}

async function askNative(parent, { message, detail, ok }) {
  const opts = { type: 'question', buttons: [ok, '取消'], defaultId: 0, cancelId: 1, noLink: true, title: 'AxonDeck', message, detail }
  const { response } = await (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))
  return response === 0
}

module.exports = { registerWebStore, permissionLines, STORE_ORIGIN }
