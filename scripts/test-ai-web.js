'use strict'
// 網頁版 AI 對話的網址／標題把關：`node scripts/test-ai-web.js`
const assert = require('node:assert/strict')
const { SITES, safeUrl, isChatUrl, sanitizeWeb, titleFromPage, installGoogleLoginFix, isLoginPopup, chromeUserAgent, allowPermission, brandList, clientHints } = require('../src/main/ai-web')

assert.equal(safeUrl('chatgpt', 'https://chatgpt.com/c/abc'), 'https://chatgpt.com/c/abc')
assert.equal(safeUrl('chatgpt', 'https://evil.example/c/abc'), '', '別的網域不收')
assert.equal(safeUrl('claude', 'https://claude.ai/login'), '', '登入頁不收')
assert.equal(safeUrl('grok', 'https://grok.com/c/9?code=secret'), '', '帶授權碼不收')
assert.equal(safeUrl('nope', 'https://chatgpt.com/'), '', '不認得的站')

assert.equal(sanitizeWeb(null), null, '一般對話')
assert.equal(sanitizeWeb({ site: 'nope' }), null)
assert.deepEqual(sanitizeWeb({ site: 'gemini', url: 'https://evil.example/' }),
  { site: 'gemini', url: SITES.gemini.home, title: '' }, '壞網址回首頁')
assert.deepEqual(sanitizeWeb({ site: 'claude', url: 'https://claude.ai/chat/1', title: 'x' }),
  { site: 'claude', url: 'https://claude.ai/chat/1', title: 'x' })

assert.equal(titleFromPage('claude', '寫報告 - Claude'), '寫報告')
assert.equal(titleFromPage('grok', 'Grok'), '', '只有站名不算標題')
assert.equal(titleFromPage('chatgpt', '  旅遊  規劃 '), '旅遊 規劃')
assert.equal(titleFromPage('gemini', 'Google Gemini'), '', 'Gemini 首頁標題')
assert.equal(titleFromPage('gemini', '‎Google Gemini'), '', '前面藏方向字元的 Gemini 首頁標題')

assert.ok(isChatUrl('chatgpt', 'https://chatgpt.com/c/abc-1'))
assert.ok(isChatUrl('chatgpt', 'https://chatgpt.com/g/g-x/c/abc'))
assert.ok(isChatUrl('claude', 'https://claude.ai/chat/1'))
assert.ok(isChatUrl('grok', 'https://grok.com/c/9'))
assert.ok(isChatUrl('gemini', 'https://gemini.google.com/app/42ab'))
assert.ok(!isChatUrl('claude', 'https://claude.ai/login'), '登入頁不是對話')
assert.ok(!isChatUrl('grok', 'https://grok.com/'), '首頁（含 Cloudflare 驗證頁）不是對話')
assert.ok(!isChatUrl('gemini', 'https://accounts.google.com/signin'), '別的網域')

// Google 登入：只改 accounts.google.com 的識別並拿掉 Client Hints；其他 https 請求補上真 Chrome 的 Client Hints
let filter, handler
installGoogleLoginFix({ webRequest: { onBeforeSendHeaders: (f, h) => { filter = f; handler = h } } })
assert.deepEqual(filter.urls, ['https://*/*'])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
handler({ url: 'https://accounts.google.com/gsi/iframe', resourceType: 'subFrame', requestHeaders: { 'User-Agent': UA } }, (out) => {
  assert.equal(out.requestHeaders['User-Agent'], UA, '網站嵌的 Google 登入元件不換識別')
})
handler({ url: 'https://accounts.google.com/signin', resourceType: 'mainFrame', requestHeaders: { 'User-Agent': 'Chrome', 'sec-ch-ua': 'x', 'Sec-CH-UA-Platform': 'y', Accept: '*/*' } }, (out) => {
  assert.deepEqual(out.requestHeaders, { 'User-Agent': 'https://accounts.google.com/', Accept: '*/*' })
})
handler({ url: 'https://example.com/', resourceType: 'mainFrame', requestHeaders: { 'User-Agent': UA } }, (out) => {
  assert.equal(out.requestHeaders['sec-ch-ua'], '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"', '補上 Chrome 150 的品牌')
  assert.equal(out.requestHeaders['sec-ch-ua-platform'], '"Windows"')
  assert.equal(out.requestHeaders['sec-ch-ua-mobile'], '?0')
})
handler({ url: 'https://example.com/', resourceType: 'xhr', requestHeaders: { 'User-Agent': UA, 'Sec-CH-UA': 'kept' } }, (out) => {
  assert.deepEqual(out, {}, '已經有 Client Hints 就不動')
})
// 對照真 Chrome 實際送出的字串（不同版號的假品牌與順序都不同）
assert.equal(clientHints(UA.replace('150', '120'))['sec-ch-ua'], '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"')
assert.equal(clientHints(UA.replace('150', '124'))['sec-ch-ua'], '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"')
assert.equal(clientHints(`${UA} Edg/124.0.0.0`.replace('150', '124'))['sec-ch-ua'], '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"')
assert.equal(clientHints('curl/8'), null)
assert.deepEqual(brandList(150, '150.0.7871.250').map((b) => b.version), ['8.0.0.0', '150.0.7871.250', '150.0.7871.250'], '完整版號清單')
assert.ok(isLoginPopup('https://accounts.google.com/o/oauth2/v2/auth?x=1'), 'Google 登入小視窗留在 App')
assert.ok(isLoginPopup('https://github.com/login/oauth/authorize'))
assert.ok(!isLoginPopup('https://github.com/user/repo'), '回答裡的 GitHub 連結不當登入小視窗')
assert.ok(!isLoginPopup('https://x.com/someone/status/1'))
assert.ok(!isLoginPopup('http://accounts.google.com/'), '只收 https')
assert.ok(isLoginPopup('https://api.infinitynewtab.com/login/google'), '第三方網站自己的登入頁也當小視窗')
assert.ok(isLoginPopup('https://example.com/oauth/authorize?client_id=1'))
assert.ok(!isLoginPopup('https://example.com/author/someone'), 'author 不是 auth')
assert.ok(!isLoginPopup('https://example.com/blog/login-tips'), '段落要整段吻合')
const { extensionIdOf, isRedirect } = require('../src/main/crx-identity')
const EXT = 'nnnkddnnlpamobajfibfdgfnbcnkgngh'
assert.equal(extensionIdOf(`chrome-extension://${EXT}/newtab/index.html`), EXT)
assert.equal(extensionIdOf('https://evil.example/'), '', '一般網頁不算擴充功能')
assert.ok(isRedirect(`https://${EXT}.chromiumapp.org/cb#access_token=x`, EXT))
assert.ok(!isRedirect(`https://${EXT}.chromiumapp.org.evil.com/`, EXT), '後綴網域不算')
assert.ok(!isRedirect(`http://${EXT}.chromiumapp.org/`, EXT), '只收 https')
assert.equal(chromeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) axondeck/1.38.4 Chrome/150.0.7871.224 Electron/43.4.1 Safari/537.36'),
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', 'UA 跟真 Chrome 一樣')
assert.ok(allowPermission('clipboard-sanitized-write'))
assert.ok(allowPermission('media', { mediaTypes: ['audio'] }), '語音輸入可以用麥克風')
assert.ok(!allowPermission('media', { mediaTypes: ['audio', 'video'] }), '不給相機')
assert.ok(!allowPermission('media', {}), '沒說要什麼就不給')
assert.ok(!allowPermission('notifications'))
assert.ok(!allowPermission('geolocation'))

const { passedTitle, toElectronCookie } = require('../src/main/grok-clearance')
assert.ok(passedTitle('Grok'))
assert.ok(!passedTitle('請稍候...'), 'Cloudflare 驗證頁不算通過')
assert.ok(!passedTitle('Just a moment...'))
assert.ok(!passedTitle('grok.com/'), '載入中標題是網址')
const ck = toElectronCookie({ name: 'cf_clearance', value: 'v', domain: '.grok.com', path: '/', secure: true, httpOnly: true, expires: 2e9, sameSite: 'None' })
assert.deepEqual([ck.url, ck.domain, ck.sameSite, ck.expirationDate], ['https://grok.com/', '.grok.com', 'no_restriction', 2e9])
assert.equal(toElectronCookie({ name: 'a', value: 'b', domain: 'grok.com', path: '/', expires: -1 }).expirationDate, undefined, '工作階段 cookie 不給到期日')
console.log('PASS ai-web 網址、標題、Google 登入、登入小視窗、UA 與權限把關')
