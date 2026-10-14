/**
 * 網頁版 AI（ChatGPT／Gemini／Claude／Grok）與工作區瀏覽器的 webview：右鍵選單、F5／Ctrl+R 重新整理。
 * webview 預設沒有右鍵選單，焦點在網頁裡時按鍵也到不了主視窗，所以都在 main 對 guest 本身掛。
 */
const { Menu, BrowserWindow, clipboard } = require('electron')

/** F5／Ctrl+R 重新整理，加 Shift 或 Ctrl+F5 略過快取 */
function attachReloadKeys(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    if (input.key !== 'F5' && !(ctrl && input.key.toLowerCase() === 'r' && !input.alt)) return
    event.preventDefault()
    if (input.shift || (ctrl && input.key === 'F5')) contents.reloadIgnoringCache()
    else contents.reload()
  })
}

function editItems(contents, params) {
  const flags = params.editFlags || {}
  const items = []
  if (params.misspelledWord) {
    for (const word of (params.dictionarySuggestions || []).slice(0, 5)) {
      items.push({ label: word, click: () => contents.replaceMisspelling(word) })
    }
    items.push({ label: '加入字典', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' })
  }
  if (params.isEditable) {
    items.push(
      { label: '復原', role: 'undo', enabled: flags.canUndo },
      { label: '重做', role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { label: '剪下', role: 'cut', enabled: flags.canCut },
      { label: '複製', role: 'copy', enabled: flags.canCopy },
      { label: '貼上', role: 'paste', enabled: flags.canPaste },
      { label: '貼上純文字', role: 'pasteAndMatchStyle', enabled: flags.canPaste },
      { label: '全選', role: 'selectAll', enabled: flags.canSelectAll }
    )
  } else if (params.selectionText.trim()) {
    items.push({ label: '複製', role: 'copy' })
  }
  return items
}

/**
 * @param {import('electron').WebContents} contents
 * @param {import('electron').ContextMenuParams} params
 * @param {{ openUrl: (url: string) => void, isWebUrl: (url: string) => boolean, extraItems?: (params: Electron.ContextMenuParams) => any[] }} opts
 */
function buildTemplate(contents, params, { openUrl, isWebUrl, extraItems }) {
  const nav = contents.navigationHistory
  const groups = []
  if (params.linkURL) {
    groups.push([
      ...(isWebUrl(params.linkURL) ? [{ label: '在瀏覽器分頁開啟連結', click: () => openUrl(params.linkURL) }] : []),
      { label: '複製連結網址', click: () => clipboard.writeText(params.linkURL) }
    ])
  }
  if (params.mediaType === 'image' && params.srcURL) {
    groups.push([
      { label: '複製圖片', click: () => contents.copyImageAt(params.x, params.y) },
      { label: '複製圖片網址', click: () => clipboard.writeText(params.srcURL) }
    ])
  }
  groups.push(editItems(contents, params))
  groups.push([
    { label: '上一頁', enabled: nav.canGoBack(), click: () => nav.goBack() },
    { label: '下一頁', enabled: nav.canGoForward(), click: () => nav.goForward() },
    { label: '重新整理', accelerator: 'F5', click: () => contents.reload() }
  ])
  groups.push(extraItems ? extraItems(params) : [])
  groups.push([{ label: '檢查元素', click: () => contents.inspectElement(params.x, params.y) }])
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ type: 'separator' }, ...g] : g))
}

/**
 * @param {import('electron').WebContents} contents webview guest
 * @param {{ openUrl: (url: string) => void, isWebUrl: (url: string) => boolean, extraItems?: (params: Electron.ContextMenuParams) => any[] }} opts
 */
function attachWebContextMenu(contents, opts) {
  attachReloadKeys(contents)
  contents.on('context-menu', (_event, params) => {
    const host = contents.hostWebContents
    const window = host && !host.isDestroyed() ? BrowserWindow.fromWebContents(host) : null
    Menu.buildFromTemplate(buildTemplate(contents, params, opts)).popup(window ? { window } : {})
  })
}

module.exports = { attachWebContextMenu }
