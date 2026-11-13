'use strict'
// 擴充功能鍵盤快速鍵：裝 Bitwarden、最終啟用右鍵 → 預設快速鍵 → 在分頁按下去開 popup／送 commands.onCommand →
// 管理頁「鍵盤快速鍵」錄新組合、衝突擋下、全域登記與清除。
// npx electron scripts/probe-crx-commands.js；AXONDECK_ASAR 可驗證打包內的實作。
const assert = require('node:assert/strict')
const path = require('node:path')
const { app, session, protocol, BrowserWindow } = require('electron')
const { tempDir } = require('./lib/test-temp')
const DATA = tempDir('cmd-'), ROOT = process.env.AXONDECK_ASAR || path.join(__dirname, '..')
const BW = 'nngceckbapebfimnlniiiahkandclblb', RC = 'emfeppdfcjnldjgmofdkbggeacapegen'
app.setPath('userData', DATA)
protocol.registerSchemesAsPrivileged([require(path.join(ROOT, 'src/main/browser-extension-manager')).PRIVILEGES])
app.commandLine.appendSwitch('log-level', '3')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const wait = async (fn, label, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)) }
  throw new Error(label + ': timeout')
}
const press = (contents, keyCode, modifiers) => {
  contents.focus()
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

async function main() {
  await app.whenReady()
  const ses = session.fromPartition('persist:wsbrowser')
  let service
  const browser = require('./lib/browser-tabs').browserTabs(ses, (contents, win) => service.attachTab(contents, win))
  browser.host.setPosition(-3000, -3000)
  service = require(path.join(ROOT, 'src/main/browser-extensions.js')).createBrowserExtensions({ session: ses,
    dir: path.join(DATA, 'browser-extensions'), fetch, chromeVersion: process.versions.chrome,
    aliasPreload: path.join(ROOT, 'src/preload/crx-browser-alias.js'), identityPreload: path.join(ROOT, 'src/preload/crx-identity.js'),
    openUrl: browser.openUrl })
  await service.loadInstalled()
  await service.install(BW); await service.install(RC)
  const shortcuts = (id) => service.list().find((row) => row.id === id).shortcuts
  const keyOf = (id, name) => shortcuts(id).find((c) => c.name === name)?.key
  console.log('Bitwarden:', shortcuts(BW).map((c) => `${c.description}=${c.key || '未設定'}`).join('；'))
  console.log('最終啟用右鍵:', shortcuts(RC).map((c) => `${c.description}=${c.key || '未設定'}`).join('；'))
  assert.equal(keyOf(BW, '_execute_action'), 'Ctrl+Shift+Y', 'Bitwarden 開 popup 預設 Ctrl+Shift+Y')
  assert.equal(keyOf(RC, '_execute_action'), '', '沒寫 commands 的也列出「啟用擴充功能」')
  console.log('PASS 讀到 manifest 的預設快速鍵')

  await browser.openUrl('https://example.com/')
  const tab = browser.tabs[0].webContents
  browser.tabs[0].showInactive()
  const popups = []
  app.on('web-contents-created', (_e, contents) => contents.once('did-start-navigation', ({ url }) => popups.push(url)))
  press(tab, 'Y', ['control', 'shift'])
  await wait(() => popups.some((url) => url.startsWith(`chrome-extension://${BW}/`)), 'Ctrl+Shift+Y 開 Bitwarden popup')
  console.log('PASS 分頁按 Ctrl+Shift+Y 開出 Bitwarden popup')
  for (const win of BrowserWindow.getAllWindows()) if (win !== browser.host && win.webContents.getURL().startsWith('chrome-extension://')) win.close()

  // 擴充功能頁自己掛 onCommand（跟背景頁同一條 router），確認收到指令名與分頁
  const listener = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } })
  const page = new URL(service.list().find((row) => row.id === BW).popup, `chrome-extension://${BW}/`).href
  await listener.loadURL(page)
  const js = (code) => listener.webContents.executeJavaScript(code, true)
  await js('globalThis.__got = []; chrome.commands.onCommand.addListener((name, tab) => __got.push([name, tab && tab.url])); true')
  const all = await js('chrome.commands.getAll()')
  assert.equal(all.find((c) => c.name === '_execute_action')?.shortcut, 'Ctrl+Shift+Y', 'chrome.commands.getAll 帶快速鍵')
  console.log('PASS chrome.commands.getAll 回報快速鍵')
  // 用「鎖定密碼庫」：沒登入時按下去不會另外開視窗
  const other = shortcuts(BW).find((c) => /lock/i.test(c.name)) || shortcuts(BW).find((c) => !c.name.startsWith('_execute_'))
  await service.change(BW, 'shortcut', { name: other.name, input: { code: 'KeyK', control: true, shift: true } })
  assert.equal(keyOf(BW, other.name), 'Ctrl+Shift+K')
  press(tab, 'K', ['control', 'shift'])
  const got = await wait(() => js('__got.at(-1)'), 'onCommand 收到')
  assert.deepEqual(got, [other.name, 'https://example.com/'])
  console.log(`PASS 改成 Ctrl+Shift+K，按下後 onCommand 收到「${other.name}」與目前分頁`)

  await assert.rejects(service.change(BW, 'shortcut', { name: other.name, input: { code: 'KeyY', control: true, shift: true } }), /已經給/)
  await assert.rejects(service.change(BW, 'shortcut', { name: other.name, input: { code: 'KeyK', shift: true } }), /Ctrl 或 Alt/)
  console.log('PASS 撞到別的快速鍵、少了 Ctrl/Alt 都會擋下')

  await service.change(BW, 'shortcut', { name: other.name, global: true })
  assert.equal(shortcuts(BW).find((c) => c.name === other.name).global, true)
  await service.change(BW, 'shortcut', { name: other.name, clear: true })
  assert.equal(keyOf(BW, other.name), '')
  console.log('PASS 全域登記成功、清除後變未設定')

  // 管理頁：鍵盤快速鍵分頁 → 點 Bitwarden 開 popup 那格 → 按 Alt+Shift+B
  await browser.openUrl('axon-extensions://manager/pages/browser-extensions.html?view=shortcuts&theme=dark')
  const manager = browser.tabs[1].webContents
  browser.tabs[1].showInactive()
  const mjs = (code) => manager.executeJavaScript(code, true)
  await wait(() => mjs('document.querySelectorAll(".shortcut-card").length >= 2'), '快速鍵卡片')
  await mjs(`[...document.querySelectorAll('.shortcut-card')].find((c) => c.textContent.includes('Bitwarden')).querySelector('.shortcut-key').click(); true`)
  await wait(() => mjs('!!document.querySelector(".shortcut-key.recording")'), '進入錄製')
  press(manager, 'B', ['alt', 'shift'])
  await wait(() => keyOf(BW, '_execute_action') === 'Alt+Shift+B', '管理頁錄到 Alt+Shift+B')
  await wait(() => mjs('document.body.innerText.includes("Alt+Shift+B")'), '畫面更新')
  console.log('PASS 管理頁錄下 Alt+Shift+B，畫面同步更新')
  popups.length = 0
  press(tab, 'B', ['alt', 'shift'])
  await wait(() => popups.some((url) => url.startsWith(`chrome-extension://${BW}/`)), '新快速鍵開 popup')
  console.log('PASS 新快速鍵在分頁裡開出 popup')

  // 工具列釘選：取消後圖示列不列它、右鍵選單只列它且勾選消失；快速鍵照樣能開
  const onBar = async () => (await service.actions(tab.id)).some((a) => a.id === BW)
  assert.equal(await onBar(), true, '預設釘選')
  await service.change(BW, 'pinned', false)
  assert.equal(await onBar(), false, '取消釘選後不在工具列')
  const menu = service.menuItems({ tab, anchor: { x: 0, y: 0, width: 1, height: 1 }, parent: null, notify: () => {}, only: BW })
  assert.equal(menu.find((item) => item.label === '釘選到工具列')?.checked, false, '右鍵選單顯示未釘選')
  assert.ok(!menu.some((item) => item.submenu), '圖示右鍵只列這個擴充功能')
  // 上一個 popup 還開著的話，再按一次是關掉它（跟 Chrome 一樣），先收掉
  for (const win of BrowserWindow.getAllWindows()) if (![browser.host, listener].includes(win)) win.destroy()
  popups.length = 0
  press(tab, 'B', ['alt', 'shift'])
  await wait(() => popups.some((url) => url.startsWith(`chrome-extension://${BW}/`)), '沒釘選也能用快速鍵開')
  await service.change(BW, 'pinned', true)
  assert.equal(await onBar(), true, '重新釘選')
  console.log('PASS 取消釘選→工具列拿掉、快速鍵仍可開；重新釘選→放回')
}

main().then(() => app.exit(0), (error) => { console.error('FAIL', error); app.exit(1) })
