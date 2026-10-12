/**
 * 工作區瀏覽器（`persist:wsbrowser`）的 Chrome 擴充功能：從 Chrome 線上應用程式商店下載 CRX、
 * 解到 `userData/browser-extensions/<id>_<時間>` 載入；chrome.tabs／action／permissions 這些 Electron 沒有的 API
 * 由 electron-chrome-extensions（GPL-3.0）補上。
 *
 * - 擴充功能 ID 要跟商店一樣（有些擴充功能靠自己的 ID 跟網站溝通）：把 CRX 裡的公鑰寫進 manifest 的 `key`。
 * - 解壓用 Windows 內建的 `tar.exe`（bsdtar，會擋 `..` 與絕對路徑），不另外引入 zip 套件。
 * - 每顆瀏覽器 webview 都登記成擴充功能看得到的分頁（`attachTab`）；工具列圖示列＋徽章由畫面照 `actions()` 畫。
 * - 自動更新：跟 Chrome 打同一支更新檢查 API，有新版就重裝（啟動後一分鐘、之後每 6 小時）。
 * shortcut: 不驗 CRX 簽章（只從 Google 的 https 網址下載）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { BrowserWindow } = require('electron')
const { removeTreeSync } = require('./safe-rm')

const ID_RE = /^[a-p]{32}$/
const STORE_DETAIL_RE = /^https:\/\/chromewebstore\.google\.com\/detail\/(?:[^/?#]+\/)?([a-p]{32})(?:[/?#]|$)/
const STORE_HOME = 'https://chromewebstore.google.com/'

/** 商店的擴充功能頁 → ID；不是就回空字串 */
function storeIdFromUrl(url) {
  return STORE_DETAIL_RE.exec(String(url || ''))?.[1] || ''
}

/** 公鑰 → 擴充功能 ID（SHA-256 前 16 bytes，每 4 bits 對應 a–p） */
function idFromKey(key) {
  return [...crypto.createHash('sha256').update(key).digest().subarray(0, 16).toString('hex')]
    .map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('')
}

/** protobuf 的 length-delimited 欄位（CRX3 標頭只用到這種）：回傳 [欄位號, 內容] */
function protoFields(buf) {
  const out = []
  let pos = 0
  const varint = () => {
    let value = 0
    for (let shift = 0; pos < buf.length; shift += 7) {
      const byte = buf[pos++]
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
    throw new Error('CRX 標頭格式不對')
  }
  while (pos < buf.length) {
    const tag = varint()
    const type = tag % 8
    if (type === 0) varint()
    else if (type === 2) {
      const len = varint()
      out.push([Math.floor(tag / 8), buf.subarray(pos, pos + len)])
      pos += len
    } else throw new Error('CRX 標頭格式不對')
  }
  return out
}

/**
 * 拆 CRX3：回傳 zip 本體與符合 ID 的公鑰
 * @param {Buffer} crx
 * @param {string} id
 */
function parseCrx(crx, id) {
  if (crx.length < 12 || crx.toString('latin1', 0, 4) !== 'Cr24' || crx.readUInt32LE(4) !== 3) {
    throw new Error('下載到的不是 CRX3 擴充功能檔')
  }
  const headerEnd = 12 + crx.readUInt32LE(8)
  if (headerEnd > crx.length) throw new Error('CRX 檔不完整')
  // 欄位 2／3 是 RSA／ECDSA 簽章證明，裡面的欄位 1 是公鑰
  const keys = protoFields(crx.subarray(12, headerEnd))
    .filter(([field]) => field === 2 || field === 3)
    .flatMap(([, proof]) => protoFields(proof).filter(([field]) => field === 1).map(([, key]) => key))
  const key = keys.find((k) => idFromKey(k) === id)
  if (!key) throw new Error('CRX 的公鑰跟擴充功能 ID 對不上')
  return { zip: crx.subarray(headerEnd), key: key.toString('base64') }
}

function unzip(zipFile, dest) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zipFile, '-C', dest], { windowsHide: true }, (error, _out, stderr) => {
      if (error) reject(new Error(`解壓失敗：${String(stderr || error.message).trim()}`))
      else resolve()
    })
  })
}

/** 版本號 a 比 b 新（Chrome 的版本是 1～4 段數字） */
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff) return diff > 0
  }
  return false
}

/** 商店更新檢查的 XML → Map<ID, 可更新到的版本>（status="noupdate" 的不列） */
function parseUpdateXml(xml) {
  const out = new Map()
  for (const app of String(xml).matchAll(/<app\s[^>]*appid="([a-p]{32})"[^>]*>([\s\S]*?)<\/app>/g)) {
    const check = /<updatecheck\s[^>]*>/.exec(app[2])?.[0] || ''
    const version = /\sversion="([\d.]+)"/.exec(check)?.[1]
    if (/\sstatus="ok"/.test(check) && version) out.set(app[1], version)
  }
  return out
}

/**
 * @param {{ session: import('electron').Session, dir: string, fetch: typeof fetch, chromeVersion: string,
 *   aliasPreload: string, openUrl: (url: string) => void, onActionsChanged?: () => void }} opts
 */
function createBrowserExtensions({ session, dir, fetch, chromeVersion, aliasPreload, openUrl, onActionsChanged }) {
  const exts = session.extensions
  /** 擴充功能叫 chrome.tabs.create 時開成專案瀏覽器分頁，等那顆 webview 接上再交回去 */
  const waitingTabs = []
  // 用到才載：單元測試在純 Node 跑，套件一載入就要 Electron
  const { ElectronChromeExtensions } = require('electron-chrome-extensions')
  const crx = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session,
    createTab: (details) => new Promise((resolve, reject) => {
      const url = String(details?.url || '')
      if (!/^https?:\/\//.test(url)) return reject(new Error('只支援 http(s) 分頁'))
      const timer = setTimeout(() => {
        waitingTabs.splice(waitingTabs.indexOf(entry), 1)
        reject(new Error('開分頁逾時'))
      }, 15_000)
      const entry = (tab) => { clearTimeout(timer); resolve(tab) }
      waitingTabs.push(entry)
      openUrl(url)
    })
  })
  // 要排在套件自己的 preload 之後（套件在建構時登記）
  session.registerPreloadScript({ id: 'axondeck-crx-browser-alias', type: 'frame', filePath: aliasPreload })
  session.registerPreloadScript({ id: 'axondeck-crx-browser-alias-sw', type: 'service-worker', filePath: aliasPreload })
  // 圖示、徽章、標題變了（setBadgeText…）或裝／移除時，叫畫面重抓工具列圖示列
  if (onActionsChanged) crx.api.browserAction.observers.add({ isDestroyed: () => false, send: onActionsChanged })

  /**
   * 瀏覽器分頁的 webview 接上主視窗時叫：擴充功能的 chrome.tabs 才看得到它
   * @param {import('electron').WebContents} contents
   * @param {import('electron').BrowserWindow} window
   */
  function attachTab(contents, window) {
    crx.addTab(contents, window)
    contents.on('focus', () => crx.selectTab(contents))
    waitingTabs.shift()?.([contents, window])
  }

  async function loadDir(full) {
    try {
      return await exts.loadExtension(full, { allowFileAccess: false })
    } catch (error) {
      console.warn('[browser-ext] 載入失敗:', full, error?.message || error)
      return null
    }
  }

  // 每次安裝放新目錄 `<id>_<時間>`：載入中的擴充功能檔案被 Chromium 鎖著，原地覆蓋或刪除會刪一半。
  // 刪不掉的留到下次啟動（還沒載入、沒人鎖）再清；`.remove-<id>` 標記整個移除。
  const DIR_RE = /^([a-p]{32})_(\d+)$/
  const dirsOf = (id) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .map((name) => DIR_RE.exec(name)).filter((m) => m && (!id || m[1] === id))
    .sort((a, b) => Number(b[2]) - Number(a[2]))
  const marker = (id) => path.join(dir, `.remove-${id}`)
  /** 刪掉這些目錄，回傳有沒有全部刪掉 */
  const tryRemove = (names) => names.map((name) => {
    try { removeTreeSync(path.join(dir, name)); return true } catch { return false }
  }).every(Boolean)

  /** App 啟動時把裝過的全部載回來（每個 ID 只載最新那份，舊的順手清掉） */
  async function loadInstalled() {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const id = /^\.remove-([a-p]{32})$/.exec(name)?.[1]
      if (id && tryRemove(dirsOf(id).map((m) => m[0]))) fs.rmSync(marker(id), { force: true })
    }
    const latest = new Map()
    for (const m of dirsOf()) {
      if (fs.existsSync(marker(m[1]))) continue
      if (latest.has(m[1])) tryRemove([m[0]])
      else latest.set(m[1], m[0])
    }
    await Promise.all([...latest.values()].map((name) => loadDir(path.join(dir, name))))
  }

  /** @param {string} id */
  async function install(id) {
    if (!ID_RE.test(id)) throw new Error('擴充功能 ID 不對')
    const url = 'https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx3'
      + `&prodversion=${encodeURIComponent(chromeVersion)}&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）`)
    const { zip, key } = parseCrx(Buffer.from(await res.arrayBuffer()), id)
    fs.mkdirSync(dir, { recursive: true })
    const staging = path.join(dir, `.tmp-${id}`)
    const zipFile = `${staging}.zip`
    removeTreeSync(staging)
    try {
      fs.writeFileSync(zipFile, zip)
      fs.mkdirSync(staging)
      await unzip(zipFile, staging)
      const manifestFile = path.join(staging, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''))
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, key }, null, 2))
      const old = dirsOf(id).map((m) => m[0])
      const final = path.join(dir, `${id}_${Date.now()}`)
      fs.renameSync(staging, final)
      if (exts.getExtension(id)) exts.removeExtension(id)
      const ext = await exts.loadExtension(final, { allowFileAccess: false })
      fs.rmSync(marker(id), { force: true })
      tryRemove(old)
      return { id: ext.id, name: ext.name }
    } finally {
      fs.rmSync(zipFile, { force: true })
      removeTreeSync(staging)
    }
  }

  /** @param {string} id */
  function remove(id) {
    if (!ID_RE.test(id)) return
    if (exts.getExtension(id)) exts.removeExtension(id)
    if (!tryRemove(dirsOf(id).map((m) => m[0]))) fs.writeFileSync(marker(id), '')
  }

  /** 已載入的：名稱、按工具列圖示要開的 popup、設定頁 */
  function list() {
    return exts.getAllExtensions().map((ext) => {
      const m = ext.manifest || {}
      const popup = (m.action || m.browser_action || m.page_action)?.default_popup || ''
      const options = m.options_ui?.page || m.options_page || ''
      return { id: ext.id, name: ext.name, url: ext.url, popup, options }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 擴充功能的設定頁開在小視窗 */
  function openOptions(ext, parent) {
    const win = new BrowserWindow({
      width: 960, height: 720, parent: parent || undefined, autoHideMenuBar: true, title: ext.name,
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.loadURL(new URL(ext.options, ext.url).href).catch((error) => console.warn('[browser-ext] 開不了:', error?.message))
  }

  /** 按擴充功能圖示：有 popup 就開在 anchor 下面，沒有就送 action.onClicked 給它 */
  function activate(extensionId, tab, anchor) {
    try {
      crx.selectTab(tab)
      crx.api.browserAction.activateClick({ extensionId, tabId: tab.id, anchorRect: anchor, alignment: 'bottom left' })
    } catch (error) {
      console.warn('[browser-ext] 開不了 popup:', error?.message || error)
    }
  }

  /** 圖示（套件依這個分頁的 setIcon 結果算好）→ data URL；主視窗的 CSP 只收 data: 圖片 */
  async function iconOf(id, tabId) {
    try {
      const res = await crx.api.browserAction.handleCRXRequest(new Request(`crx://extension-icon/${id}/32/2?tabId=${tabId}`))
      return res.ok ? `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` : ''
    } catch { return '' }
  }

  /**
   * 工具列圖示列：每個擴充功能在這個分頁的圖示、標題、徽章（文字＋底色）
   * @param {number} tabId 瀏覽器 webview 的 webContents id（沒有就給 -1）
   */
  async function actions(tabId) {
    const { actions: list } = crx.api.browserAction.getState()
    const rows = list.filter((a) => exts.getExtension(a.id)).map(async (a) => {
      const own = a.tabs?.[tabId] || {}
      const pick = (key) => (own[key] !== undefined ? own[key] : a[key])
      const color = pick('color')
      return {
        id: a.id,
        title: String(pick('title') || exts.getExtension(a.id).name),
        badge: String(pick('text') || ''),
        color: Array.isArray(color) ? `rgba(${color.slice(0, 3).join(',')},${(color[3] ?? 255) / 255})` : String(color || ''),
        icon: await iconOf(a.id, tabId)
      }
    })
    return (await Promise.all(rows)).sort((x, y) => x.title.localeCompare(y.title))
  }

  /** 照商店的更新檢查（跟 Chrome 同一支 API）把有新版的重裝；回傳更新了哪些 */
  async function checkUpdates() {
    const installed = exts.getAllExtensions().filter((ext) => dirsOf(ext.id).length)
    if (!installed.length) return []
    const query = installed.map((ext) => `x=${encodeURIComponent(`id=${ext.id}&v=${ext.version}&uc`)}`).join('&')
    const res = await fetch('https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3'
      + `&prodversion=${encodeURIComponent(chromeVersion)}&${query}`)
    if (!res.ok) throw new Error(`更新檢查失敗（HTTP ${res.status}）`)
    const latest = parseUpdateXml(await res.text())
    const updated = []
    for (const ext of installed) {
      if (!isNewer(latest.get(ext.id) || '0', ext.version)) continue
      try {
        await install(ext.id)
        updated.push(ext.name)
      } catch (error) {
        console.warn('[browser-ext] 更新失敗:', ext.name, error?.message || error)
      }
    }
    return updated
  }

  /** 啟動後一分鐘查一次，之後每 6 小時（跟 Chrome 差不多） */
  function startAutoUpdate() {
    const run = () => checkUpdates()
      .then((names) => { if (names.length) console.log('[browser-ext] 已更新:', names.join('、')) })
      .catch((error) => console.warn('[browser-ext]', error?.message || error))
    setTimeout(run, 60_000)
    setInterval(run, 6 * 60 * 60 * 1000)
  }

  /**
   * 右鍵與工具列共用的「擴充功能」選單；`tab` 是目前那顆瀏覽器 webview（沒有就不能開 popup）
   * @param {{ tab: Electron.WebContents | null, anchor: Electron.Rectangle, parent: Electron.BrowserWindow | null, notify: (msg: string) => void }} ctx
   */
  function menuItems({ tab, anchor, parent, notify }) {
    const storeId = storeIdFromUrl(tab?.getURL())
    const installed = list()
    const items = []
    if (storeId) {
      items.push({
        label: exts.getExtension(storeId) ? '重新安裝這個擴充功能' : '安裝這個擴充功能',
        click: () => install(storeId).then((ext) => notify(`已安裝「${ext.name}」，重新整理網頁後生效`))
          .catch((error) => notify(`安裝失敗：${error.message}`))
      }, { type: 'separator' })
    }
    for (const ext of installed) {
      const sub = []
      if (tab) sub.push({ label: ext.popup ? '開啟' : '執行', click: () => activate(ext.id, tab, anchor) })
      if (ext.options) sub.push({ label: '選項', click: () => openOptions(ext, parent) })
      sub.push({ label: '移除', click: () => { remove(ext.id); notify(`已移除「${ext.name}」`) } })
      items.push({ label: ext.name, submenu: sub })
    }
    if (!installed.length) items.push({ label: '（還沒有安裝擴充功能）', enabled: false })
    items.push({ type: 'separator' }, { label: '前往 Chrome 線上應用程式商店', click: () => openUrl(STORE_HOME) })
    return items
  }

  /** 擴充功能自己加的右鍵項目（chrome.contextMenus） */
  function contextMenuItems(contents, params) {
    try { return crx.getContextMenuItems(contents, params) } catch { return [] }
  }

  return { loadInstalled, install, remove, list, attachTab, menuItems, contextMenuItems, activate, actions, checkUpdates, startAutoUpdate }
}

module.exports = { createBrowserExtensions, storeIdFromUrl, idFromKey, parseCrx, isNewer, parseUpdateXml, STORE_HOME }
