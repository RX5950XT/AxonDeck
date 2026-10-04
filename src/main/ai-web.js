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

/** @param {import('electron').Session} ses */
function installGoogleLoginFix(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, callback) => {
    // 只換登入頁本身（整頁導覽）：網站嵌的 Google 登入元件（/gsi/ iframe、腳本）看到怪識別會直接不動
    if (details.resourceType !== 'mainFrame') return callback({})
    const headers = { ...details.requestHeaders, 'User-Agent': GOOGLE_LOGIN_UA }
    for (const key of Object.keys(headers)) if (/^sec-ch-ua/i.test(key)) delete headers[key]
    callback({ requestHeaders: headers })
  })
}

// 「用 Google／Apple／X… 登入」若是開小視窗（Claude 的 Google 登入就是），要在 App 裡開、共用同一個登入分區，
// 丟去系統瀏覽器的話登入結果回不來。只放行這些登入網域，其他外部連結照舊交給系統瀏覽器。
// x.com／github.com 只認登入路徑：回答裡貼的一般連結仍交給系統瀏覽器
const LOGIN_POPUPS = new Map([
  ['accounts.google.com', /^\//], ['appleid.apple.com', /^\//], ['login.microsoftonline.com', /^\//],
  ['login.live.com', /^\//], ['auth.openai.com', /^\//], ['accounts.x.ai', /^\//],
  ['x.com', /^\/i\/(oauth2|flow\/login)/], ['api.x.com', /^\/oauth/], ['github.com', /^\/login/]
])

function isLoginPopup(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !!LOGIN_POPUPS.get(url.hostname)?.test(url.pathname)
  } catch { return false }
}

/** Electron 的 UA 拿掉 Electron／App 字樣，版本縮成真 Chrome 送的 `Chrome/150.0.0.0`（完整版號是機器人特徵） */
function chromeUserAgent(fallback) {
  return String(fallback).replace(/\s(Electron|voiceink)\/\S+/gi, '').replace(/Chrome\/(\d+)[\d.]+/, 'Chrome/$1.0.0.0')
}

// Grok 的 Cloudflare 認得出這是 Electron：識別裝成 Chrome、縮版號、多帶 App 名字都會一直「正在執行安全驗證」，
// 只有 Electron 原本的識別直接放行（2026-10-04 實測）。所以這個分區只拿掉 App 名字，其他照實。
const ELECTRON_UA_PARTITIONS = new Set(['persist:ai-grok'])

/** 分區該用的瀏覽器識別 */
function userAgentFor(partition, fallback) {
  return ELECTRON_UA_PARTITIONS.has(partition) ? String(fallback).replace(/\svoiceink\/\S+/gi, '') : chromeUserAgent(fallback)
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
 * @param {{ partition: string, userAgent: string, shimPath: string }} opts
 */
function setupSession(ses, { partition, userAgent, shimPath }) {
  ses.setUserAgent(userAgentFor(partition, userAgent))
  ses.registerPreloadScript({ type: 'frame', id: 'voiceink-ai-web-shim', filePath: shimPath })
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowPermission(permission, details)))
  ses.setPermissionCheckHandler((_contents, permission, _origin, details) => allowPermission(permission, details))
  installGoogleLoginFix(ses)
}

module.exports = {
  SITES, isSite, safeUrl, isChatUrl, sanitizeWeb, titleFromPage, installGoogleLoginFix, isLoginPopup,
  chromeUserAgent, userAgentFor, allowPermission, setupSession
}
