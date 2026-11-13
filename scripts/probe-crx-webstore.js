'use strict'
// 打真的 Chrome 線上應用程式商店：按「加到 Chrome」→ 確認 → 裝好、按鈕變「從 Chrome 中移除」→ 再按 → 確認 → 移除。
// npx electron scripts/probe-crx-webstore.js [擴充功能 ID]；AXONDECK_ASAR 可驗證打包內的實作。
const assert = require('node:assert/strict')
const path = require('node:path')
const { app, BrowserWindow, session, dialog, protocol } = require('electron')
const { tempDir } = require('./lib/test-temp')
const DATA = tempDir('ws-'), ROOT = process.env.AXONDECK_ASAR || path.join(__dirname, '..')
const ID = process.argv.find((a) => /^[a-p]{32}$/.test(a)) || 'eimadpbcbfnmbkopoojfekhnkhdbieeh' // Dark Reader
app.setPath('userData', DATA)
protocol.registerSchemesAsPrivileged([require(path.join(ROOT, 'src/main/browser-extension-manager')).PRIVILEGES])
app.commandLine.appendSwitch('log-level', '3')
// 探針視窗放在螢幕外：不關遮蔽偵測的話頁面沒有 rAF，商店按鈕會停在伺服器畫的停用狀態（看起來像「不支援」）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const wait = async (fn, label, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)) }
  throw new Error(label + ': timeout')
}
// 商店按鈕文字依語系（加到 Chrome／Add to Chrome／從 Chrome 中移除／Remove from Chrome）
const FIND = (re) => `[...document.querySelectorAll('button')].find((x) => ${re}.test(x.innerText.trim()) && !x.disabled && x.offsetParent)`
const BUTTON = (re) => `(() => ${FIND(re)}?.innerText.trim() || '')()`
const CLICK = (re) => `(() => { ${FIND(re)}.click(); return true })()`
const ADD = /^(加到|Add to) Chrome$/i, REMOVE = /^(從 Chrome 中移除|Remove from Chrome)$/i
const BUTTONS = `[...document.querySelectorAll('button')].map((b) => [b.innerText.trim(), b.disabled].join('|')).filter((t) => !t.startsWith('|'))`

async function main() {
  await app.whenReady()
  const ses = session.fromPartition('persist:wsbrowser')
  require(path.join(ROOT, 'src/main/ai-web')).setupSession(ses, { userAgent: app.userAgentFallback,
    shimPath: path.join(ROOT, 'src/preload/ai-web-shim.js'), languages: 'zh-TW,zh,en-US,en' })
  const service = require(path.join(ROOT, 'src/main/browser-extensions.js')).createBrowserExtensions({ session: ses,
    dir: path.join(DATA, 'browser-extensions'), fetch, chromeVersion: process.versions.chrome,
    aliasPreload: path.join(ROOT, 'src/preload/crx-browser-alias.js'), identityPreload: path.join(ROOT, 'src/preload/crx-identity.js'),
    openUrl: () => {} })
  await service.loadInstalled()
  const asked = []
  dialog.showMessageBox = async (...args) => { asked.push(args.at(-1).message); return { response: 0 } }

  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.setPosition(-3000, -3000); win.showInactive()
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const dumpOnFail = (error) => js(BUTTONS).then((rows) => { console.log('buttons:', rows); throw error })
  await win.loadURL(`https://chromewebstore.google.com/detail/${ID}`)
  assert.equal(await js('typeof chrome.webstorePrivate?.beginInstallWithManifest3'), 'function', 'webstorePrivate 有掛上')
  console.log('PASS 商店顯示可按的按鈕:', await wait(() => js(BUTTON(ADD)), '加到 Chrome 按鈕').catch(dumpOnFail))
  await js(CLICK(ADD))
  await wait(() => service.list().some((ext) => ext.id === ID && ext.enabled), '安裝完成', 90000)
  assert.equal(asked.length, 1, '安裝前跳一次確認'); console.log('PASS 確認視窗:', asked[0])
  console.log('PASS 安裝完成，按鈕變成:', await wait(() => js(BUTTON(REMOVE)), '按鈕變成移除').catch(dumpOnFail))
  // 裝好後 Chromium 會重掛原生 chrome.management（Electron 裡沒作用），要確認還是補上的那份
  assert.equal(await js('typeof chrome.management.createAppShortcut'), 'undefined', 'chrome.management 沒被原生的蓋掉')
  await js(CLICK(REMOVE))
  await wait(() => !service.list().some((ext) => ext.id === ID), '移除完成').catch(dumpOnFail)
  await wait(() => js(BUTTON(ADD)), '按鈕變回加到 Chrome').catch(dumpOnFail)
  assert.equal(asked.length, 2, '移除前跳一次確認'); console.log('PASS 移除完成，按鈕變回加到 Chrome')
  await win.loadURL('https://example.com/')
  assert.equal(await js('typeof chrome?.webstorePrivate'), 'undefined', '其他網站沒有 webstorePrivate')
  console.log('PASS 其他網站沒有 webstorePrivate')
}

main().then(() => app.exit(0), (error) => { console.error('FAIL', error); app.exit(1) })
