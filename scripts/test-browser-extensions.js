'use strict'
// 工作區瀏覽器擴充功能：商店網址、CRX3 拆包與公鑰對 ID：`node scripts/test-browser-extensions.js`
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { storeIdFromUrl, idFromKey, parseCrx, isNewer, parseUpdateXml } = require('../src/main/browser-extensions')
const { matchBrowserShortcut, resolveShortcutGuest, resolveShortcutHost, resolveShortcutGuestId } = require('../src/main/browser-shortcuts')

const ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const { EXTENSIONS_PAGE_URL, isInternalBrowserUrl, isExtensionManagerUrl, isExtensionShortcutsUrl } = require('../src/shared/browser-url.mjs')
assert.ok(isExtensionManagerUrl(EXTENSIONS_PAGE_URL + '?extension=' + ID))
assert.equal(isExtensionShortcutsUrl(EXTENSIONS_PAGE_URL + '?extension=' + ID), false)
assert.ok(isExtensionShortcutsUrl(EXTENSIONS_PAGE_URL + '?view=shortcuts&theme=dark'))
assert.equal(isExtensionShortcutsUrl('axon-extensions://evil/pages/browser-extensions.html?view=shortcuts'), false)
assert.ok(isInternalBrowserUrl(`chrome-extension://${ID}/options.html`))
for (const url of ['file:///C:/x.html', 'javascript:alert(1)', 'chrome-extension://invalid/options.html',
  'axon-extensions://evil/pages/browser-extensions.html', 'axon-extensions://manager/scripts/browser-extensions-page.js',
  'axon-extensions://user:password@manager/pages/browser-extensions.html']) assert.equal(isInternalBrowserUrl(url), false)
assert.equal(storeIdFromUrl(`https://chromewebstore.google.com/detail/ublock-origin-lite/${ID}`), ID)
assert.equal(storeIdFromUrl(`https://chromewebstore.google.com/detail/${ID}?hl=zh-TW`), ID)
assert.equal(storeIdFromUrl(`https://evil.example/detail/x/${ID}`), '', '別的網域不算')
assert.equal(storeIdFromUrl('https://chromewebstore.google.com/'), '')

// 自己做一個 CRX3：欄位 2（RSA 證明）裡放公鑰
const varint = (n) => { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128) } out.push(n); return Buffer.from(out) }
const field = (no, buf) => Buffer.concat([varint(no * 8 + 2), varint(buf.length), buf])
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
const key = publicKey.export({ type: 'spki', format: 'der' })
const id = idFromKey(key)
assert.match(id, /^[a-p]{32}$/)
const header = Buffer.concat([field(2, Buffer.concat([field(1, key), field(2, Buffer.from('sig'))])), field(10000, Buffer.from('x'))])
const zip = Buffer.from('PK\u0003\u0004zip-body')
const prefix = Buffer.alloc(12)
prefix.write('Cr24', 0, 'latin1')
prefix.writeUInt32LE(3, 4)
prefix.writeUInt32LE(header.length, 8)
const crx = Buffer.concat([prefix, header, zip])

const parsed = parseCrx(crx, id)
assert.deepEqual(parsed.zip, zip)
assert.equal(parsed.key, key.toString('base64'))
assert.throws(() => parseCrx(crx, ID), /對不上/, '公鑰跟 ID 不符要擋')
assert.throws(() => parseCrx(Buffer.from('PK not a crx'), id), /CRX3/)
assert.throws(() => parseCrx(Buffer.concat([prefix, header.subarray(0, 5)]), id), /不完整/)

// 自動更新：版本比較與商店更新檢查的 XML
assert.ok(isNewer('2026.1012.1545', '2026.1005.1'))
assert.ok(isNewer('1.10', '1.9'), '逐段比數字，不是比字串')
assert.ok(!isNewer('1.0.0', '1.0'), '補零後一樣不算新')
assert.ok(!isNewer('0', '3.2'))
const xml = '<gupdate><app appid="ddkjiahejlhfcafbddmgiahcphecmpfh" status="ok"><updatecheck codebase="https://x/a.crx" status="ok" version="2026.1012.1545"/></app>'
  + '<app appid="eimadpbcbfnmbkopoojfekhnkhdbieeh" status="ok"><updatecheck status="noupdate"/></app></gupdate>'
assert.deepEqual([...parseUpdateXml(xml)], [['ddkjiahejlhfcafbddmgiahcphecmpfh', '2026.1012.1545']])
assert.equal(parseUpdateXml('not xml').size, 0)

// 工作區瀏覽器快捷鍵比對
const keyIn = (over) => ({ type: 'keyDown', key: '', code: '', control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, ...over })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'ArrowLeft', alt: true })), { scope: 'page', action: 'back' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'ArrowRight', alt: true })), { scope: 'page', action: 'forward' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'F5' })), { scope: 'page', action: 'reload' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'r', code: 'KeyR', control: true })), { scope: 'page', action: 'reload' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'R', code: 'KeyR', control: true, shift: true })), { scope: 'page', action: 'reload-hard' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'F5', control: true })), { scope: 'page', action: 'reload-hard' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'F5', shift: true })), { scope: 'page', action: 'reload-hard' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'F12' })), { scope: 'page', action: 'devtools' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'I', code: 'KeyI', control: true, shift: true })), { scope: 'page', action: 'devtools' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'l', code: 'KeyL', control: true })), { scope: 'host', action: 'focus-url', focusHost: true })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'd', code: 'KeyD', alt: true })), { scope: 'host', action: 'focus-url', focusHost: true })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'f', code: 'KeyF', control: true })), { scope: 'host', action: 'find', focusHost: true })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'F3' })), { scope: 'host', action: 'find-next' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'F3', shift: true })), { scope: 'host', action: 'find-prev' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 't', code: 'KeyT', control: true })), { scope: 'host', action: 'new-tab', focusHost: true })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'w', code: 'KeyW', control: true })), { scope: 'host', action: 'close-tab' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'Tab', code: 'Tab', control: true })), { scope: 'host', action: 'next-tab' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'Tab', code: 'Tab', control: true, shift: true })), { scope: 'host', action: 'prev-tab' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'PageDown', control: true })), { scope: 'host', action: 'next-tab' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'PageUp', control: true })), { scope: 'host', action: 'prev-tab' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: '1', code: 'Digit1', control: true })), { scope: 'host', action: 'tab-1' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: '9', code: 'Numpad9', control: true })), { scope: 'host', action: 'tab-9' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: '=', code: 'Equal', control: true })), { scope: 'page', action: 'zoom-in' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: '-', code: 'Minus', control: true })), { scope: 'page', action: 'zoom-out' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: '0', code: 'Digit0', control: true })), { scope: 'page', action: 'zoom-reset' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'T', code: 'KeyT', control: true, shift: true })), { scope: 'host', action: 'new-terminal', focusHost: true })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'W', code: 'KeyW', control: true, shift: true })), { scope: 'host', action: 'close-tab' })
assert.deepEqual(matchBrowserShortcut(keyIn({ key: 'P', code: 'KeyP', control: true, shift: true })), { scope: 'host', action: 'command-palette', focusHost: true })
assert.equal(matchBrowserShortcut(keyIn({ key: 'l', code: 'KeyL', control: true, alt: true })), null, 'AltGr (Ctrl+Alt) 不誤判')
assert.equal(matchBrowserShortcut(keyIn({ key: 't', code: 'KeyT', control: true, isAutoRepeat: true })), null, '一般快捷鍵不重複觸發')
assert.deepEqual(matchBrowserShortcut(keyIn({ key: '=', code: 'Equal', control: true, isAutoRepeat: true })), { scope: 'page', action: 'zoom-in' }, '縮放允許長按重複')
assert.equal(matchBrowserShortcut(keyIn({ type: 'keyUp', key: 'F5' })), null)


// 擴充功能選項頁的 sandbox iframe：快捷鍵要送到外層 webview 的宿主，id 也用外層那顆
function fakeContents(id, type, parent = null) {
  return {
    id,
    hostWebContents: parent,
    getType: () => type,
    isDestroyed: () => false
  }
}
const windowHost = fakeContents(1, 'window')
const chatHost = fakeContents(2, 'window', windowHost)
// chat 頁是宿主 renderer（未必是 type window 的最頂層），webview.host = chatHost
chatHost.getType = () => 'other'
const webview = fakeContents(10, 'webview', chatHost)
const iframe = fakeContents(11, 'other', webview)
assert.equal(resolveShortcutGuest(webview), webview)
assert.equal(resolveShortcutHost(webview), chatHost)
assert.equal(resolveShortcutGuestId(webview), 10)
assert.equal(resolveShortcutGuest(iframe), webview, 'iframe 要對回分頁 webview')
assert.equal(resolveShortcutHost(iframe), chatHost, 'IPC 要送給工作區 renderer，不是 webview')
assert.equal(resolveShortcutGuestId(iframe), 10)
assert.equal(resolveShortcutGuest(null), null)
const dead = { id: 99, isDestroyed: () => true, getType: () => 'webview', hostWebContents: chatHost }
assert.equal(resolveShortcutGuest(dead), null)

console.log('test-browser-extensions: 通過')
