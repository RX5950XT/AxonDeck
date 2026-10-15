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
const { dialog } = require('electron')
const { EXTENSIONS_PAGE_URL, isInternalBrowserUrl, isExtensionManagerUrl } = require('../shared/browser-url.mjs')
const rawFs = require('./raw-fs').promises
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
 *   aliasPreload: string, identityPreload: string, openUrl: (url: string) => void, onActionsChanged?: () => void }} opts
 */
function createBrowserExtensions({ session, dir, fetch, chromeVersion, aliasPreload, identityPreload, openUrl, openCompatible, onActionsChanged }) {
  const exts = session.extensions
  const stateFile = path.join(dir, 'extension-state.json')
  let state = {}
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (!state || Array.isArray(state) || typeof state !== 'object') throw new Error('擴充功能設定格式不對')
    } catch (error) {
      // 這裡跑在 whenReady 裡、建主視窗之前：壞檔不能讓整個 App 開不起來。留備份，從空的開始
      console.error('[browser-extensions] 擴充功能設定讀不懂，已改名備份:', error?.message || error)
      try { fs.renameSync(stateFile, `${stateFile}.bad`) } catch { /* 改名失敗下次存檔會蓋掉 */ }
      state = {}
    }
  }
  const saved = (id) => state[id] || {}
  const allowed = (id) => saved(id).userScripts ?? (id === 'ndcooeababalnlpkfedmmbbbgkljhpjf')
  let stateChain = Promise.resolve()
  function saveState(id, patch) {
    const job = stateChain.then(async () => {
      const next = { ...state }
      if (patch === null) delete next[id]
      else next[id] = { ...saved(id), ...patch }
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(`${stateFile}.tmp`, JSON.stringify(next))
      await fs.promises.rename(`${stateFile}.tmp`, stateFile)
      state = next
      onActionsChanged?.()
    })
    stateChain = job.catch(() => {})
    return job
  }
  const userScripts = require('./crx-user-scripts').createUserScripts({ session, dir, allowed })
  const userScriptsPreload = path.join(__dirname, '../preload/crx-user-scripts.js')
  session.registerPreloadScript({ id: 'axondeck-crx-user-scripts', type: 'frame', filePath: userScriptsPreload })
  session.registerPreloadScript({ id: 'axondeck-crx-user-scripts-sw', type: 'service-worker', filePath: userScriptsPreload })
  /** 擴充功能叫 chrome.tabs.create 時開成專案瀏覽器分頁，等那顆 webview 接上再交回去 */
  const waitingTabs = []
  // 用到才載：單元測試在純 Node 跑，套件一載入就要 Electron
  const { ElectronChromeExtensions } = require('electron-chrome-extensions')
  // chrome.identity 要排在套件的 preload 之前（套件最後會凍結 chrome），所以在建構套件前登記
  require('./crx-identity').registerIdentity(session)
  session.registerPreloadScript({ id: 'axondeck-crx-identity', type: 'frame', filePath: identityPreload })
  session.registerPreloadScript({ id: 'axondeck-crx-identity-sw', type: 'service-worker', filePath: identityPreload })
  const crx = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session,
    createTab: (details) => requestTab(internalUrl(details.url) || String(details.url || ''), crx.ctx.store.getActiveTabOfCurrentWindow())
  })
  require('./crx-context-menus').registerContextMenus(crx)
  const popupSources = new WeakMap()
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
  function attachTab(contents, window, resolveWaiting = true) {
    if (contents.session !== session) return
    crx.addTab(contents, window)
    const select = () => {
      const source = popupSources.get(contents)
      crx.selectTab(source && !source.isDestroyed() ? source : contents)
    }
    contents.on('focus', select)
    if (resolveWaiting && waitingTabs.length) {
      let pending
      const started = ({ url, isMainFrame }) => {
        if (isMainFrame && !pending) pending = waitingTabs.find(entry => entry.url === url)
      }
      const finish = (_event, url) => {
        const index = pending ? waitingTabs.indexOf(pending) : waitingTabs.findIndex((entry) => entry.url === (url || contents.getURL()))
        if (_event || index >= 0) contents.off('did-start-navigation', started)
        if (index < 0) return
        const [entry] = waitingTabs.splice(index, 1)
        if (entry.popup && entry.source && !entry.source.isDestroyed()) popupSources.set(contents, entry.source)
        select(); contents.emit('tab-updated'); entry.resolve([contents, window]); contents.off('did-navigate', finish)
      }
      contents.on('did-start-navigation', started)
      contents.once('did-navigate', finish)
      finish()
    }
  }

  function requestTab(url, source, popup = false) {
    if (!/^https?:\/\//.test(url) && !internalUrl(url)) return Promise.reject(new Error('這個網址無法開啟'))
    return new Promise((resolve, reject) => {
      const entry = { url, source, popup, resolve: (tab) => { clearTimeout(timer); resolve(tab) } }
      const fail = () => {
        const index = waitingTabs.indexOf(entry)
        if (index >= 0) waitingTabs.splice(index, 1)
        clearTimeout(timer); reject(new Error('開分頁失敗，請稍後再試'))
      }
      const timer = setTimeout(fail, 15_000)
      waitingTabs.push(entry)
      Promise.resolve().then(() => openUrl(url, source)).catch(fail)
    })
  }

  async function loadDir(full) {
    try {
      const ext = await exts.loadExtension(full, { allowFileAccess: false })
      await saveState(ext.id, { record: extensionRecord(ext) })
      if (saved(ext.id).enabled === false) exts.removeExtension(ext.id)
      return ext
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
  const localFile = path.join(dir, 'local-extensions.json')
  async function localExtensions() {
    let rows
    try { rows = JSON.parse(await fs.promises.readFile(localFile, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error('本機擴充功能清單讀取失敗')
    }
    if (!Array.isArray(rows) || rows.some((row) => !ID_RE.test(row?.id) || typeof row.path !== 'string' || !path.isAbsolute(row.path)
      || (row.runtimePath && (typeof row.runtimePath !== 'string' || path.dirname(row.runtimePath) !== dir || !path.basename(row.runtimePath).startsWith(`.local-${row.id}_`)))
      || (row.key && (typeof row.key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.key))))) {
      throw new Error('本機擴充功能清單格式不對')
    }
    return rows
  }
  async function saveLocalExtensions(rows) {
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(`${localFile}.tmp`, JSON.stringify(rows))
    await fs.promises.rename(`${localFile}.tmp`, localFile)
  }

  /** 系統選檔視窗給的資料夾；直接載入原始碼，移除時只忘記它，不刪使用者檔案。 */
  async function installLocal(folder) {
    const full = await rawFs.realpath(folder)
    let manifest
    try { manifest = JSON.parse((await rawFs.readFile(path.join(full, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, '')) } catch {
      throw new Error('請選擇含有效 manifest.json 的擴充功能資料夾')
    }
    if (![2, 3].includes(manifest?.manifest_version) || typeof manifest.name !== 'string' || !manifest.name.trim()
      || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)
      || (manifest.key !== undefined && (typeof manifest.key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key)))) {
      throw new Error('manifest.json 缺少有效的名稱、版本或 manifest_version')
    }
    if (manifest.key && dirsOf(idFromKey(Buffer.from(manifest.key, 'base64'))).length) {
      throw new Error('這個 ID 已從商店安裝，請先移除商店版本')
    }
    const rows = await localExtensions()
    const previous = rows.find((row) => row.path.toLowerCase() === full.toLowerCase())
    if (previous && exts.getExtension(previous.id)) exts.removeExtension(previous.id)
    let ext, runtimePath, key = manifest.key || previous?.key
    try {
      if (manifest.permissions?.includes('userScripts')) {
        // 使用者腳本的原生注入只接受套件內的檔案，放管理副本避免寫進使用者的原始碼。
        key ||= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
        const id = idFromKey(Buffer.from(key, 'base64'))
        runtimePath = path.join(dir, `.local-${id}_${Date.now()}`)
        await rawFs.cp(full, runtimePath, { recursive: true, dereference: false, filter: async (file) => !(await rawFs.lstat(file)).isSymbolicLink() })
        await fs.promises.writeFile(path.join(runtimePath, 'manifest.json'), JSON.stringify({ ...manifest, key }))
      }
      ext = await exts.loadExtension(runtimePath || full, { allowFileAccess: false })
      await saveLocalExtensions([...rows.filter((row) => row.id !== ext.id && row !== previous), { id: ext.id, path: full, ...(runtimePath ? { runtimePath, key } : {}) }])
      await saveState(ext.id, { record: { ...extensionRecord(ext), sourcePath: full } })
      if (saved(ext.id).enabled === false) exts.removeExtension(ext.id)
      if (previous?.runtimePath) tryRemove([path.basename(previous.runtimePath)])
    } catch {
      if (ext) exts.removeExtension(ext.id)
      if (runtimePath) tryRemove([path.basename(runtimePath)])
      if (previous && saved(previous.id).enabled !== false) await loadDir(previous.runtimePath || previous.path)
      throw new Error('擴充功能載入或儲存失敗，請檢查 manifest.json 與 Electron 支援的功能')
    }
    onActionsChanged?.()
    return { id: ext.id, name: ext.name }
  }
  /** 刪掉這些目錄，回傳有沒有全部刪掉 */
  const tryRemove = (names) => names.map((name) => {
    try { removeTreeSync(path.join(dir, name)); return true } catch { return false }
  }).every(Boolean)

  /** App 啟動時把裝過的全部載回來（每個 ID 只載最新那份，舊的順手清掉） */
  async function loadInstalled() {
    await userScripts.ready
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
    for (const [id, name] of latest) if (saved(id).enabled !== false) await loadDir(path.join(dir, name))
    const locals = await localExtensions()
    const runtimeNames = new Set(locals.map((row) => row.runtimePath && path.basename(row.runtimePath)))
    tryRemove(fs.readdirSync(dir).filter((name) => /^\.local-[a-p]{32}_\d+$/.test(name) && !runtimeNames.has(name)))
    for (const row of locals) if (saved(row.id).enabled !== false) await loadDir(row.runtimePath || row.path)
  }

  /** @param {string} id */
  async function install(id) {
    if (!ID_RE.test(id)) throw new Error('擴充功能 ID 不對')
    if ((await localExtensions()).some((row) => row.id === id)) throw new Error('這個 ID 已從本機載入，請先移除本機版本')
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
      let ext
      try {
        ext = saved(id).enabled === false
          ? { id, path: final, manifest, name: saved(id).record?.name || manifest.name, version: manifest.version, url: `chrome-extension://${id}/` }
          : await exts.loadExtension(final, { allowFileAccess: false })
      } catch (error) {
        tryRemove([path.basename(final)])
        if (old[0] && saved(id).enabled !== false) await loadDir(path.join(dir, old[0]))
        throw error
      }
      await saveState(ext.id, { record: extensionRecord(ext) })
      if (saved(ext.id).enabled === false) exts.removeExtension(ext.id)
      fs.rmSync(marker(id), { force: true })
      tryRemove(old)
      return { id: ext.id, name: ext.name }
    } finally {
      fs.rmSync(zipFile, { force: true })
      removeTreeSync(staging)
    }
  }

  /**
   * 預設擴充功能：每個 ID 只自動裝一次（記在 `.defaults-seeded`），使用者之後移除就不再裝回來。
   * 下載失敗（沒網路）不記，下次啟動再試。
   * @param {string[]} ids
   */
  async function ensureDefaults(ids) {
    const file = path.join(dir, '.defaults-seeded')
    let seeded = []
    try { seeded = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 第一次 */ }
    for (const id of ids.filter((x) => !seeded.includes(x))) {
      try {
        if (!list().some((ext) => ext.id === id)) await install(id)
        seeded = [...seeded, id]
        fs.writeFileSync(file, JSON.stringify(seeded))
      } catch (error) {
        console.warn('[browser-ext] 預設擴充功能安裝失敗:', id, error?.message || error)
      }
    }
  }

  /** @param {string} id */
  async function remove(id) {
    if (!ID_RE.test(id)) return
    const rows = await localExtensions()
    if (rows.some((row) => row.id === id)) await saveLocalExtensions(rows.filter((row) => row.id !== id))
    if (exts.getExtension(id)) exts.removeExtension(id)
    await userScripts.clear(id)
    tryRemove(rows.filter((row) => row.id === id && row.runtimePath).map((row) => path.basename(row.runtimePath)))
    if (!tryRemove(dirsOf(id).map((m) => m[0]))) fs.writeFileSync(marker(id), '')
    await saveState(id, null)
    onActionsChanged?.()
  }

  /** 已載入的：名稱、按工具列圖示要開的 popup、設定頁 */
  function list() {
    const records = new Map(Object.values(state).filter((s) => s.record).map((s) => [s.record.id, s.record]))
    for (const ext of exts.getAllExtensions()) records.set(ext.id, extensionRecord(ext))
    return [...records.values()].map((ext) => ({ ...ext, enabled: !!exts.getExtension(ext.id),
      userScripts: !!allowed(ext.id) })).sort((a, b) => a.name.localeCompare(b.name))
  }

  function extensionRecord(ext) {
    const m = ext.manifest || {}
    const store = !!dirsOf(ext.id).length
    return { id: ext.id, name: ext.name, version: ext.version, description: m.description || '', path: ext.path,
      sourcePath: store ? ext.path : (saved(ext.id).record?.sourcePath || ext.path),
      source: store ? 'store' : 'local', url: ext.url,
      popup: (m.action || m.browser_action || m.page_action)?.default_popup || '', options: m.options_ui?.page || m.options_page || '',
      newtab: m.chrome_url_overrides?.newtab || '',
      sidepanel: m.side_panel?.default_path || '',
      permissions: m.permissions || [], hostPermissions: [...new Set([...(m.host_permissions || []),
        ...(m.permissions || []).filter((v) => v === '<all_urls>' || /^(\*|https?|file|ftp):\/\//.test(v)),
        ...(m.content_scripts || []).flatMap((s) => s.matches || [])])], homepage: m.homepage_url || '' }
  }

  async function change(id, action, value, source) {
    if (!ID_RE.test(id)) throw new Error('擴充功能 ID 不對')
    const ext = list().find((row) => row.id === id)
    if (!ext) throw new Error('找不到這個擴充功能')
    if (action === 'remove') return remove(id)
    if (action === 'options') return openOptions(ext, source)
    if (action === 'reload' && ext.source === 'local') return installLocal(ext.sourcePath)
    if (action === 'enabled') {
      if (typeof value !== 'boolean') throw new Error('設定格式不對')
      await saveState(id, { enabled: value, record: ext })
      if (!value) { if (exts.getExtension(id)) exts.removeExtension(id); return }
    } else if (action === 'userScripts') {
      if (typeof value !== 'boolean' || !ext.permissions.includes('userScripts')) throw new Error('這個套件未申請使用者指令碼權限')
      await saveState(id, { userScripts: value, record: ext })
    } else if (action === 'update') {
      if (ext.source !== 'store') throw new Error('本機套件請使用重新載入')
      return install(id)
    } else if (action !== 'reload') throw new Error('不支援的操作')
    if (exts.getExtension(id)) exts.removeExtension(id)
    if (saved(id).enabled !== false) {
      const loaded = await loadDir(ext.path)
      if (!loaded) throw new Error('擴充功能載入失敗')
    }
  }

  function internalUrl(value) {
    let url
    try { url = new URL(value) } catch { return '' }
    if (['chrome:', 'edge:'].includes(url.protocol) && url.hostname === 'extensions') {
      const result = new URL(EXTENSIONS_PAGE_URL)
      result.searchParams.set('extension', ID_RE.test(url.searchParams.get('id') || '') ? url.searchParams.get('id') : '')
      return result.href
    }
    if (isExtensionManagerUrl(url.href)) return url.href
    return isInternalBrowserUrl(url.href) && exts.getExtension(url.hostname) ? url.href : ''
  }
  function openInternalUrl(value, source) {
    const url = internalUrl(value)
    if (!url) return false
    void requestTab(url, source).catch(() => console.warn('[browser-ext] 無法開啟插件分頁'))
    return true
  }
  async function pickLocal(parent) {
    const options = { title: '選擇含 manifest.json 的擴充功能資料夾', properties: ['openDirectory'] }
    const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    return result.canceled || !result.filePaths[0] ? null : installLocal(result.filePaths[0])
  }
  const manager = require('./browser-extension-manager').createManager({ session, list, change, checkUpdates, installLocal: pickLocal,
    openStore: (source) => requestTab(STORE_HOME, source).then(() => undefined), openUrl: requestTab,
    page: path.join(__dirname, '../renderer/pages/browser-extensions.html'), preload: path.join(__dirname, '../preload/browser-extensions-preload.js') })

  /** 擴充功能的設定頁沿用來源瀏覽器的新分頁。 */
  function openOptions(ext, source) {
    const page = ext.options || ext.newtab || ext.popup || ext.sidepanel
    if (!page || !ext.enabled) throw new Error('請先啟用套件，或這個套件沒有提供設定介面')
    const url = new URL(page, ext.url)
    if (url.protocol !== 'chrome-extension:' || url.hostname !== ext.id) throw new Error('套件選項網址不對')
    return requestTab(url.href, source, !ext.options && !ext.newtab).then(() => undefined)
  }

  /** 按擴充功能圖示：popup 浮在工具列下方；沒有 popup 時送 action.onClicked。 */
  function activate(extensionId, tab, anchor) {
    if (tab.session !== session) return
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
    const tab = require('electron').webContents.fromId(tabId)
    if (tab && tab.session !== session) return []
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
    const installed = list().filter((ext) => ext.source === 'store')
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
    const items = [{ label: '管理擴充功能…', click: () => manager.open('', tab).catch(() => notify('開分頁失敗')) }, { type: 'separator' }]
    if (tab && openCompatible && /^https?:\/\//.test(tab.getURL())) items.push({ label: '在無套件相容視窗開啟此頁', click: () => openCompatible(tab.getURL(), tab.getTitle()) }, { type: 'separator' })
    if (storeId) {
      items.push({
        label: exts.getExtension(storeId) ? '重新安裝這個擴充功能' : '安裝這個擴充功能',
        click: () => install(storeId).then((ext) => notify(`已安裝「${ext.name}」，重新整理網頁後生效`))
          .catch((error) => notify(`安裝失敗：${error.message}`))
      }, { type: 'separator' })
    }
    for (const ext of installed) {
      const sub = []
      if (tab) sub.push({ label: ext.popup ? '開啟' : '執行', enabled: ext.enabled && tab.session === session, click: () => activate(ext.id, tab, anchor) })
      if (ext.options || ext.newtab || ext.popup || ext.sidepanel) sub.push({ label: ext.options ? '完整設定…' : '套件介面與設定…', enabled: ext.enabled, click: () => openOptions(ext, tab).catch(() => notify('開分頁失敗')) })
      sub.push({ label: '詳細設定…', click: () => manager.open(ext.id, tab).catch(() => notify('開分頁失敗')) },
        { label: ext.enabled ? '停用' : '啟用', click: () => change(ext.id, 'enabled', !ext.enabled).catch(() => notify('切換失敗')) },
        { label: '重新載入', enabled: ext.enabled, click: () => change(ext.id, 'reload').catch(() => notify('重新載入失敗')) })
      sub.push({ label: '移除', click: () => remove(ext.id).then(() => notify(`已移除「${ext.name}」`))
        .catch(() => notify('移除失敗，請稍後再試')) })
      items.push({ label: ext.name, submenu: sub })
    }
    if (!installed.length) items.push({ label: '（還沒有安裝擴充功能）', enabled: false })
    items.push({ type: 'separator' },
      { label: '從 Chrome 線上應用程式商店安裝', click: () => requestTab(STORE_HOME, tab).catch(() => notify('開分頁失敗')) },
      { label: '安裝本機擴充功能資料夾…', click: async () => {
        try {
          const ext = await pickLocal(parent)
          if (!ext) return
          notify(`已安裝「${ext.name}」，重新整理網頁後生效；請保留原始資料夾`)
        } catch (error) { notify(error.message || '本機擴充功能安裝失敗') }
      } })
    return items
  }

  /** 擴充功能自己加的右鍵項目（chrome.contextMenus） */
  function contextMenuItems(contents, params) {
    if (contents.session !== session) return []
    try { return crx.getContextMenuItems(contents, params) } catch { return [] }
  }

  return { loadInstalled, ensureDefaults, install, installLocal, remove, list, attachTab, menuItems, contextMenuItems, activate, actions, checkUpdates, startAutoUpdate,
    change, openInternalUrl }
}

module.exports = { createBrowserExtensions, storeIdFromUrl, idFromKey, parseCrx, isNewer, parseUpdateXml, STORE_HOME }
