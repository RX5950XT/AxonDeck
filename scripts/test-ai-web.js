'use strict'
// 網頁版 AI 對話的網址／標題把關：`node scripts/test-ai-web.js`
const assert = require('node:assert/strict')
const { SITES, safeUrl, isChatUrl, sanitizeWeb, titleFromPage, installGoogleLoginFix, isLoginPopup, chromeUserAgent, allowPermission } = require('../src/main/ai-web')

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

// Google 登入：只改 accounts.google.com 的識別並拿掉 Client Hints
let filter, handler
installGoogleLoginFix({ webRequest: { onBeforeSendHeaders: (f, h) => { filter = f; handler = h } } })
assert.deepEqual(filter.urls, ['https://accounts.google.com/*'])
handler({ resourceType: 'subFrame', requestHeaders: { 'User-Agent': 'Chrome' } }, (out) => {
  assert.deepEqual(out, {}, '網站嵌的 Google 登入元件不動')
})
handler({ resourceType: 'mainFrame', requestHeaders: { 'User-Agent': 'Chrome', 'sec-ch-ua': 'x', 'Sec-CH-UA-Platform': 'y', Accept: '*/*' } }, (out) => {
  assert.deepEqual(out.requestHeaders, { 'User-Agent': 'https://accounts.google.com/', Accept: '*/*' })
})
assert.ok(isLoginPopup('https://accounts.google.com/o/oauth2/v2/auth?x=1'), 'Google 登入小視窗留在 App')
assert.ok(isLoginPopup('https://github.com/login/oauth/authorize'))
assert.ok(!isLoginPopup('https://github.com/user/repo'), '回答裡的 GitHub 連結交給系統瀏覽器')
assert.ok(!isLoginPopup('https://x.com/someone/status/1'))
assert.ok(!isLoginPopup('http://accounts.google.com/'), '只收 https')
assert.equal(chromeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) voiceink/1.38.4 Chrome/150.0.7871.224 Electron/43.4.1 Safari/537.36'),
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', 'UA 跟真 Chrome 一樣')
assert.ok(allowPermission('clipboard-sanitized-write'))
assert.ok(allowPermission('media', { mediaTypes: ['audio'] }), '語音輸入可以用麥克風')
assert.ok(!allowPermission('media', { mediaTypes: ['audio', 'video'] }), '不給相機')
assert.ok(!allowPermission('media', {}), '沒說要什麼就不給')
assert.ok(!allowPermission('notifications'))
assert.ok(!allowPermission('geolocation'))
console.log('PASS ai-web 網址、標題、Google 登入、登入小視窗、UA 與權限把關')
