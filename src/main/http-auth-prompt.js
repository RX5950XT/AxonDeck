'use strict'

/**
 * 網站要 HTTP 帳密（Basic／Digest，或代理伺服器驗證）時跳的登入小窗，跟 Chrome 的「登入以存取此網站」一樣。
 * Electron 沒有內建這個視窗：`app` 的 `login` 事件沒人接就直接取消，網頁只會看到 401。
 *
 * 小窗是 data: 頁、沙箱、沒有 preload；按鈕把結果寫進 document.title，main 在 page-title-updated 讀（並擋掉不顯示），
 * 不必另開 IPC。（自訂協定會被當外部連結丟給系統；data: 頁也不准改 #hash，兩條都攔不到。）
 * 同一個網站同時來好幾個請求只開一個窗、結果一起回。
 */

const { BrowserWindow } = require('electron')

const TITLE_PREFIX = 'axon-auth:'

/** @type {Map<string, Array<(username?: string, password?: string) => void>>} */
const pending = new Map()

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function siteLabel(details, authInfo) {
  if (authInfo.isProxy) return `代理伺服器 ${authInfo.host}:${authInfo.port}`
  try { return new URL(details.url).origin } catch { return `${authInfo.host}:${authInfo.port}` }
}

function pageHtml({ site, realm, light }) {
  const realmLine = realm ? `<p class="realm">這個網站表示：「${escapeHtml(realm)}」</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>登入</title><style>
:root { color-scheme: ${light ? 'light' : 'dark'}; --bg: ${light ? '#f6f7f8' : '#202124'}; --fg: ${light ? '#1f2328' : '#e8eaed'};
  --muted: ${light ? '#57606a' : '#9aa0a6'}; --field: ${light ? '#fff' : '#2a2b2e'}; --line: ${light ? '#c8ccd0' : '#5f6368'}; --accent: #2f6fe4; }
* { box-sizing: border-box; } body { margin: 0; padding: 20px 22px; background: var(--bg); color: var(--fg);
  font: 14px "Segoe UI", "Microsoft JhengHei UI", sans-serif; user-select: none; }
h1 { font-size: 17px; font-weight: 600; margin: 0 0 12px; } p { margin: 0 0 14px; word-break: break-all; }
.realm { color: var(--muted); margin-top: -8px; }
label { display: grid; grid-template-columns: 84px 1fr; align-items: center; margin-bottom: 12px; }
input { height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--field); color: var(--fg); font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
.row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
button { min-width: 82px; height: 34px; border-radius: 6px; font: inherit; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style></head><body><form id="f">
<h1>登入以存取此網站</h1><p>${escapeHtml(site)} 要求授權</p>${realmLine}
<label>使用者名稱<input id="u" autocomplete="off" autofocus></label>
<label>密碼<input id="p" type="password" autocomplete="off"></label>
<div class="row"><button type="submit" class="primary">登入</button><button type="button" id="c">取消</button></div>
</form><script>
const go = (msg) => { document.title = ${JSON.stringify(TITLE_PREFIX)} + JSON.stringify(msg) }
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault()
  go({ u: document.getElementById('u').value, p: document.getElementById('p').value })
})
document.getElementById('c').addEventListener('click', () => go(null))
addEventListener('keydown', (e) => { if (e.key === 'Escape') go(null) })
</script></body></html>`
}

function parentWindow(contents) {
  const host = contents && !contents.isDestroyed() ? (contents.hostWebContents || contents) : null
  const win = host && !host.isDestroyed() ? BrowserWindow.fromWebContents(host) : null
  return win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow()
}

/**
 * 開登入小窗；使用者送出或取消後回 `{ username, password }` 或 null
 * @returns {Promise<{ username: string, password: string } | null>}
 */
function ask(contents, details, authInfo, { icon, theme }) {
  return new Promise((resolve) => {
    const parent = parentWindow(contents)
    const win = new BrowserWindow({
      width: 440, height: authInfo.realm ? 262 : 236, useContentSize: true, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true, show: false,
      title: '登入', icon, parent: parent || undefined, modal: Boolean(parent),
      backgroundColor: theme === 'light' ? '#f6f7f8' : '#202124',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false }
    })
    let result = null
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.on('page-title-updated', (event, title) => {
      event.preventDefault() // 帳密不可以跑到視窗標題上
      if (!title.startsWith(TITLE_PREFIX)) return
      try {
        const msg = JSON.parse(title.slice(TITLE_PREFIX.length))
        if (msg && typeof msg.u === 'string' && typeof msg.p === 'string') result = { username: msg.u, password: msg.p }
      } catch { /* 格式不對當取消 */ }
      win.close()
    })
    win.once('ready-to-show', () => win.show())
    win.once('closed', () => resolve(result))
    const html = pageHtml({ site: siteLabel(details, authInfo), realm: authInfo.realm, light: theme === 'light' })
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((error) => {
      console.warn('[http-auth] 登入窗載入失敗:', error?.message)
      if (!win.isDestroyed()) win.close()
    })
  })
}

/**
 * 接 `app` 的 `login` 事件（所有 webview、視窗、WebContentsView 都會走到這裡）
 * @param {Electron.App} app
 * @param {{ icon?: string, theme?: () => string }} [opts]
 */
function install(app, opts = {}) {
  app.on('login', (event, contents, details, authInfo, callback) => {
    event.preventDefault()
    const key = `${authInfo.isProxy ? 'proxy' : 'site'}|${authInfo.scheme}|${authInfo.host}:${authInfo.port}|${authInfo.realm}`
    const waiting = pending.get(key)
    if (waiting) { waiting.push(callback); return }
    pending.set(key, [callback])
    ask(contents, details, authInfo, { icon: opts.icon, theme: opts.theme?.() || 'dark' })
      .catch((error) => { console.warn('[http-auth] 登入窗失敗:', error?.message); return null })
      .then((cred) => {
        const callbacks = pending.get(key) || []
        pending.delete(key)
        for (const cb of callbacks) {
          try {
            if (cred) cb(cred.username, cred.password)
            else cb()
          } catch (error) { console.warn('[http-auth] 回傳帳密失敗:', error?.message) }
        }
      })
  })
}

module.exports = { install, pageHtml, siteLabel }
