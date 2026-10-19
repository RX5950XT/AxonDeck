'use strict'
const { ipcMain } = require('electron')
const { extensionIdOf } = require('./crx-identity')
const CHANNEL = 'crx-context-menu-update'
const CONTEXTS = new Set(['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'launcher', 'browser_action', 'page_action', 'action'])

function updateProperties(items, id, value) {
  if (!items?.has(id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid menu item.')
  const fields = new Set(['type', 'title', 'checked', 'enabled', 'visible', 'contexts', 'parentId', 'documentUrlPatterns', 'targetUrlPatterns'])
  for (const [key, field] of Object.entries(value)) {
    if (!fields.has(key)) throw new Error('Invalid menu properties.')
    if (['checked', 'enabled', 'visible'].includes(key) && typeof field !== 'boolean') throw new Error('Invalid menu properties.')
    if (key === 'title' && (typeof field !== 'string' || field.length > 2048)) throw new Error('Invalid menu properties.')
    if (key === 'type' && !['normal', 'checkbox', 'radio', 'separator'].includes(field)) throw new Error('Invalid menu properties.')
    if (['contexts', 'documentUrlPatterns', 'targetUrlPatterns'].includes(key)
      && (!Array.isArray(field) || field.length > 256 || field.some((s) => typeof s !== 'string' || s.length > 2048 || (key === 'contexts' && !CONTEXTS.has(s))))) throw new Error('Invalid menu properties.')
    if (key === 'parentId') {
      if (!['string', 'number'].includes(typeof field) || !items.has(field)) throw new Error('Invalid menu parent.')
      const visited = new Set([id]); let parent = field
      while (parent !== undefined) {
        if (visited.has(parent)) throw new Error('Invalid menu parent.')
        visited.add(parent); parent = items.get(parent)?.parentId
      }
    }
  }
  return { ...items.get(id), ...value }
}

function registerContextMenus(crx) {
  const api = crx.api.contextMenus, session = crx.ctx.session
  const update = (id, menuId, properties) => {
    try {
      const extension = session.extensions.getExtension(id)
      if (!extension?.manifest.permissions?.includes('contextMenus')) throw new Error('Invalid extension.')
      const items = api.menus.get(id)
      const next = updateProperties(items, menuId, properties)
      items.set(menuId, next)
      return { ok: true }
    } catch (error) { return { ok: false, error: { message: /^Invalid (menu|extension)/.test(error.message) ? error.message : 'Menu update failed.' } } }
  }
  ipcMain.handle(CHANNEL, (event, id, properties) => event.sender.session === session
    ? update(extensionIdOf(event.senderFrame?.url || ''), id, properties) : { ok: false, error: { message: 'Invalid extension.' } })
  const workers = new WeakSet()
  session.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
    if (runningStatus !== 'starting') return
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker?.scope?.startsWith('chrome-extension://') || workers.has(worker)) return
    workers.add(worker)
    worker.ipc.handle(CHANNEL, (_event, id, properties) => update(extensionIdOf(worker.scope), id, properties))
  })
  const build = api.buildMenuItem
  api.buildMenuItem = (opts) => {
    const result = build(opts), { props, extension, webContents, params } = opts
    return { ...result, visible: props.visible !== false, checked: !!props.checked,
      click: (item) => {
        if (!['checkbox', 'radio'].includes(props.type)) return result.click(item)
        if (webContents.isDestroyed()) return
        const items = api.menus.get(extension.id), saved = items?.get(props.id)
        if (!saved) return
        const wasChecked = !!saved.checked, checked = !!item.checked
        if (props.type === 'radio') {
          const siblings = [...items.values()].filter((p) => p.parentId === saved.parentId)
          const index = siblings.findIndex((p) => p.id === saved.id)
          for (const step of [-1, 1]) for (let i = index + step; siblings[i]?.type === 'radio'; i += step) {
            items.set(siblings[i].id, { ...siblings[i], checked: false })
          }
        }
        items.set(props.id, { ...saved, checked })
        const tab = crx.ctx.store.tabDetailsCache.get(webContents.id)
        if (!tab) return
        crx.ctx.router.sendEvent(extension.id, 'contextMenus.onClicked', {
          menuItemId: props.id, parentMenuItemId: saved.parentId, checked, wasChecked, frameId: -1,
          selectionText: params?.selectionText, frameUrl: params?.frameURL, pageUrl: params?.pageURL,
          linkUrl: params?.linkURL, srcUrl: params?.srcURL, editable: !!params?.isEditable, mediaType: params?.mediaType
        }, tab)
      } }
  }
}
module.exports = { registerContextMenus, updateProperties }
