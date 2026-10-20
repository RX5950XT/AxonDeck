/**
 * 網頁版 AI 對話（ChatGPT／Gemini／Claude／Grok）存在 chats.json 的 `web: { site, url, title }`。
 * 這裡只管把關：網址只收該站自己的網域，登入／OAuth 轉址與授權碼不當成對話記錄保存。
 */
const SITES = Object.freeze({
  chatgpt: { name: 'ChatGPT', home: 'https://chatgpt.com/' },
  gemini: { name: 'Gemini', home: 'https://gemini.google.com/app' },
  claude: { name: 'Claude', home: 'https://claude.ai/new' },
  grok: { name: 'Grok', home: 'https://grok.com/' }
})

/** 真正的對話頁（首頁、登入、Cloudflare 驗證頁的分頁標題都不拿來當對話標題） */
const CHAT_PATHS = Object.freeze({
  chatgpt: /^\/(g\/[^/]+\/)?c\/[\w-]+/,
  gemini: /^\/app\/[\w-]+/,
  claude: /^\/chat\/[\w-]+/,
  grok: /^\/(c|chat)\/[\w-]+/
})

function isSite(site) {
  return typeof site === 'string' && Object.hasOwn(SITES, site)
}

function safeUrl(site, value) {
  if (!isSite(site) || typeof value !== 'string' || value.length > 2048) return ''
  try {
    const url = new URL(value)
    if (url.origin !== new URL(SITES[site].home).origin || url.username || url.password) return ''
    if (/\/(auth|login|logout|signin|oauth|callback)(\/|$)/i.test(url.pathname)) return ''
    if (['code', 'token', 'access_token', 'id_token'].some((key) => url.searchParams.has(key))) return ''
    return url.href
  } catch { return '' }
}

/** 讀檔正規化：不是網頁版對話回 null */
function sanitizeWeb(raw) {
  if (!raw || typeof raw !== 'object' || !isSite(raw.site)) return null
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 60) : ''
  return { site: raw.site, url: safeUrl(raw.site, raw.url) || SITES[raw.site].home, title }
}

function isChatUrl(site, value) {
  const url = safeUrl(site, value)
  return !!url && CHAT_PATHS[site].test(new URL(url).pathname)
}

/** 分頁標題去掉站名尾巴（「某某對話 - Claude」→「某某對話」）；只剩站名就回空字串 */
function titleFromPage(site, value) {
  if (!isSite(site) || typeof value !== 'string') return ''
  const name = SITES[site].name
  // Gemini 的標題前面藏了方向控制字元（U+200E），先拿掉
  const text = value.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim().replace(/\s+/g, ' ')
    .replace(new RegExp(`\\s*[-|–—]\\s*(${name}|Google ${name})$`, 'i'), '')
  const bare = text.toLowerCase().replace(/^google\s+/, '')
  return text && bare !== name.toLowerCase() ? text.slice(0, 60) : ''
}

// Google 登入看到內嵌 Chromium 就擋（「這個瀏覽器或應用程式可能有安全疑慮」）。只在 accounts.google.com
// 把瀏覽器識別換成不是瀏覽器的字串、拿掉 Client Hints，Google 會改走精簡版登入頁，不擋（Ferdium 的做法）。
// 只動這個網域：其他網站（含 Gemini 本身）仍是一般 Chrome 識別。
const GOOGLE_LOGIN_UA = 'https://accounts.google.com/'

/**
 * 真 Chrome 的品牌清單（Chromium `GenerateBrandVersionList`：假品牌與順序都由主版號決定）。
 * Electron 只報 Chromium 一家、而且改過 UA 之後**完全不送** `Sec-CH-UA`——真 Chrome 每個 https 請求都有，
 * Cloudflare／Google 拿這個分辨內嵌瀏覽器。`ai-web-shim.js` 用同一套算法補 `navigator.userAgentData`。
 * @param {number} major
 * @param {string} version 主版號或完整版號
 * @param {string} [brand]
 */
function brandList(major, version, brand = 'Google Chrome') {
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][major % 6]
  const chars = ' (:-./);=?_'
  const greaseVersion = ['8', '99', '24'][major % 3]
  const out = []
  out[order[0]] = { brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`, version: version.includes('.') ? `${greaseVersion}.0.0.0` : greaseVersion }
  out[order[1]] = { brand: 'Chromium', version }
  out[order[2]] = { brand, version }
  return out
}

/** 照請求自己的 UA 產生 `Sec-CH-UA` 那三個標頭（Grok 用的是 Edge 的 UA，品牌就要是 Edge）；認不出版號回 null */
function clientHints(userAgent) {
  const major = Number(String(userAgent).match(/Chrome\/(\d+)/)?.[1])
  // 照實報 Electron 的分頁（installChallengeFallback）不補：原版 Electron 本來就不送
  if (!major || /\sElectron\//.test(userAgent)) return null
  const brand = /\sEdg\//.test(userAgent) ? 'Microsoft Edge' : 'Google Chrome'
  return {
    'sec-ch-ua': brandList(major, String(major), brand).map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  }
}

/**
 * 每個 https 請求補上真 Chrome 會送的 Client Hints；accounts.google.com 的整頁導覽則反過來
 * 換成精簡版登入頁的識別。同一個 session 的 onBeforeSendHeaders 只能掛一個，兩件事寫在一起。
 * @param {import('electron').Session} ses
 */
function installGoogleLoginFix(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    // 只換登入頁本身（整頁導覽）：網站嵌的 Google 登入元件（/gsi/ iframe、腳本）看到怪識別會直接不動
    if (details.resourceType === 'mainFrame' && details.url.startsWith(GOOGLE_LOGIN_UA)) {
      headers['User-Agent'] = GOOGLE_LOGIN_UA
      for (const key of Object.keys(headers)) if (/^sec-ch-ua/i.test(key)) delete headers[key]
      return callback({ requestHeaders: headers })
    }
    if (Object.keys(headers).some((key) => /^sec-ch-ua$/i.test(key))) return callback({})
    const hints = clientHints(headers['User-Agent'] || '')
    callback(hints ? { requestHeaders: { ...headers, ...hints } } : {})
  })
}

// 「用 Google／Apple／X… 登入」若是開小視窗（Claude 的 Google 登入就是），要在 App 裡開、共用同一個登入分區，
// 丟去系統瀏覽器的話登入結果回不來。只放行這些登入網域，其他外部連結開成專案瀏覽器分頁。
// x.com／github.com 只認登入路徑：回答裡貼的一般連結開成專案瀏覽器分頁
const LOGIN_POPUPS = new Map([
  ['accounts.google.com', /^\//], ['appleid.apple.com', /^\//], ['login.microsoftonline.com', /^\//],
  ['login.live.com', /^\//], ['auth.openai.com', /^\//], ['accounts.x.ai', /^\//],
  ['x.com', /^\/i\/(oauth2|flow\/login)/], ['api.x.com', /^\/oauth/], ['github.com', /^\/login/]
])

// 第三方網站常先開自己的 /login/google、/oauth/authorize 再轉去 Google；路徑某一段是這些字就當登入頁
const AUTH_PATH = /(^|\/)(oauth2?|authorize|auth|log-?in|sign-?in|sso)(\/|$)/i

function isLoginPopup(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (!!LOGIN_POPUPS.get(url.hostname)?.test(url.pathname) || AUTH_PATH.test(url.pathname))
  } catch { return false }
}

/** Electron 的 UA 拿掉 Electron／App 字樣，版本縮成真 Chrome 送的 `Chrome/150.0.0.0`（完整版號是機器人特徵） */
function chromeUserAgent(fallback) {
  return String(fallback).replace(/\s(Electron|axondeck)\/\S+/gi, '').replace(/Chrome\/(\d+)[\d.]+/, 'Chrome/$1.0.0.0')
}

/** Electron 原本的識別，只拿掉 App 名字（帶 App 名字一樣過不了 Cloudflare） */
function electronUserAgent(fallback) {
  return String(fallback).replace(/\saxondeck\/\S+/gi, '')
}

/**
 * Cloudflare 驗證認得出「裝成 Chrome 的 Electron」：自動檢查不過、勾選框點了也一直重來；照實報 Electron 卻多半直接放行
 * （2026-10-17 實測 ACS／OUP／RSC／SSRN，換 Chrome 版號、標頭順序、拿掉 shim 都沒用，只有 UA 帶 Electron 有用）。
 * 平常仍裝 Chrome（Google 登入等要），哪個分頁的整頁回應被 Cloudflare 擋就把那個分頁改回 Electron 識別重新載入；
 * 通行證綁識別，那個分頁之後一直用它。同一個 session 的 onHeadersReceived 只能掛一個（Grok 分區有自己的 grok-clearance）。
 * @param {import('electron').Session} ses
 * @param {string} electronUa
 */
function installChallengeFallback(ses, electronUa) {
  ses.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (details, callback) => {
    callback({})
    const contents = details.webContents
    if (details.resourceType !== 'mainFrame' || !contents || contents.isDestroyed() || contents.getUserAgent() === electronUa) return
    const mitigated = Object.entries(details.responseHeaders || {}).find(([key]) => key.toLowerCase() === 'cf-mitigated')?.[1]
    if (!String(mitigated || '').includes('challenge')) return
    contents.setUserAgent(electronUa)
    setImmediate(() => { if (!contents.isDestroyed()) contents.reload() })
  })
}

// Electron 沒設處理器時所有權限一律放行（通知、相機、定位…），真 Chrome 會先問；兩者都不對。
// 只給網頁版 AI 會用到的：麥克風（語音輸入，只限聲音）、剪貼簿、全螢幕。通知等其他一律不給。
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'media'])

function allowPermission(permission, details) {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false
  if (permission !== 'media') return true
  const types = details?.mediaTypes || (details?.mediaType ? [details.mediaType] : [])
  return types.length > 0 && types.every((type) => type === 'audio')
}

/**
 * 網頁版 AI 一個登入分區的設定（main 在 whenReady 叫）
 * @param {import('electron').Session} ses
 * @param {{ userAgent: string, shimPath: string, languages?: string }} opts
 */
function setupSession(ses, { userAgent, shimPath, languages }) {
  // 第二個參數是 Accept-Language：不給的話只送一個 `zh-TW`，跟 navigator.languages 的三個對不上
  ses.setUserAgent(chromeUserAgent(userAgent), languages || undefined)
  ses.registerPreloadScript({ type: 'frame', id: 'axondeck-ai-web-shim', filePath: shimPath })
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowPermission(permission, details)))
  ses.setPermissionCheckHandler((_contents, permission, _origin, details) => allowPermission(permission, details))
  installGoogleLoginFix(ses)
}

module.exports = {
  SITES, isSite, safeUrl, isChatUrl, sanitizeWeb, titleFromPage, installGoogleLoginFix, isLoginPopup,
  chromeUserAgent, electronUserAgent, installChallengeFallback, allowPermission, setupSession, brandList, clientHints
}
