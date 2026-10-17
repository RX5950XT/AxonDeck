'use strict'
// 網頁版 AI 對話的網址／標題把關：`node scripts/test-ai-web.js`
const assert = require('node:assert/strict')
const { SITES, safeUrl, isChatUrl, sanitizeWeb, titleFromPage, installGoogleLoginFix, isLoginPopup, chromeUserAgent, electronUserAgent, installChallengeFallback, allowPermission, brandList, clientHints } = require('../src/main/ai-web')

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
const ELECTRON_UA = electronUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) axondeck/1.56.1 Chrome/150.0.7871.250 Electron/43.7.5 Safari/537.36')
assert.equal(ELECTRON_UA, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.250 Electron/43.7.5 Safari/537.36', '只拿掉 App 名字')
assert.equal(clientHints(ELECTRON_UA), null, '照實報 Electron 的分頁不補 Client Hints')
// Cloudflare 擋整頁 → 那個分頁改回 Electron 識別重新載入；子資源、沒擋、已經換過的都不動
let onHeaders
installChallengeFallback({ webRequest: { onHeadersReceived: (_f, h) => { onHeaders = h } } }, ELECTRON_UA)
const tab = { ua: UA, reloads: 0, isDestroyed: () => false, getUserAgent() { return this.ua }, setUserAgent(ua) { this.ua = ua }, reload() { this.reloads++ } }
const fire = (resourceType, headers) => onHeaders({ resourceType, webContents: tab, responseHeaders: headers }, (out) => assert.deepEqual(out, {}))
fire('subFrame', { 'cf-mitigated': ['challenge'] })
fire('mainFrame', { server: ['cloudflare'] })
assert.equal(tab.ua, UA, '沒被擋不換')
fire('mainFrame', { 'Cf-Mitigated': ['challenge'] })
assert.equal(tab.ua, ELECTRON_UA, '被擋就換識別')
fire('mainFrame', { 'cf-mitigated': ['challenge'] })
setImmediate(() => assert.equal(tab.reloads, 1, '重載一次；換過還被擋不再重載（交給使用者勾選）'))
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

// 執行真正的 preload：沿用 Edge 通行證 UA 時，HTTP 與網頁的品牌／主版號仍一致。
const vm = require('node:vm')
const fs = require('node:fs')
for (const ua of [UA, UA.replace('150','140') + ' Edg/140.0.0.0']) {
  class AgentData { get brands() { return [{brand:'Chromium',version:'150'}] } toJSON() { return {brands:this.brands,mobile:false,platform:'Windows'} } getHighEntropyValues() { return Promise.resolve({brands:this.brands,uaFullVersion:'150.1.2.3',fullVersionList:[{brand:'Chromium',version:'150.1.2.3'}]}) } }
  const data = new AgentData(), sandbox = { navigator:{userAgent:ua,userAgentData:data},window:{chrome:{}},require:()=>({contextBridge:{executeInMainWorld:({func})=>func()}}) }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload/ai-web-shim'),'utf8'),sandbox)
  const major = Number(/Chrome\/(\d+)/.exec(ua)[1]), brand = ua.includes('Edg/') ? 'Microsoft Edge' : 'Google Chrome'
  assert.equal(JSON.stringify(data.brands),JSON.stringify(brandList(major,String(major),brand)))
  assert.equal(JSON.stringify(data.toJSON().brands),JSON.stringify(data.brands))
}
console.log('PASS browser preload brands match Chrome / Edge UA')
vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload/ai-web-shim'),'utf8'),{
  navigator:{userAgent:UA},window:{chrome:{}},require:()=>({contextBridge:{executeInMainWorld:({func})=>func()}})
})
console.log('PASS browser preload without userAgentData in insecure contexts')
{
  const brands = [{ brand: 'Chromium', version: '150' }], win = { chrome: undefined }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload/ai-web-shim'),'utf8'),{
    navigator:{userAgent:ELECTRON_UA,userAgentData:{brands}},window:win,require:()=>({contextBridge:{executeInMainWorld:({func})=>func()}})
  })
  assert.deepEqual([win.chrome, brands.length], [undefined, 1], 'Electron 識別的分頁照原樣，不補 chrome／品牌')
}
console.log('PASS browser preload leaves Electron-identity tabs untouched')
