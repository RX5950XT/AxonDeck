/** 視窗搬移的生命週期：不靠 UI 字串或原始碼比對。 */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { NAV_PAGES } = require('./lib/nav-pages')

const views = []
const windows = []
class Contents extends EventEmitter {
  constructor() { super(); this.messages = []; this.destroyed = false }
  isDestroyed() { return this.destroyed }
  send(channel, payload) { this.messages.push({ channel, payload }) }
  loadFile() { return Promise.resolve() }
  close() { this.destroyed = true }
}
class View {
  constructor() { this.webContents = new Contents(); views.push(this) }
  setBackgroundColor() {}
  setBounds(bounds) { this.bounds = bounds }
  setVisible(visible) { this.visible = visible }
}
class Window extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.webContents = new Contents()
    this.children = new Set()
    this.contentView = {
      addChildView: (view) => this.children.add(view),
      removeChildView: (view) => this.children.delete(view)
    }
    this.size = [1200, 800]
    windows.push(this)
  }
  isDestroyed() { return !!this.destroyed }
  isMinimized() { return false }
  isMaximized() { return false }
  setMenu() {}
  getContentSize() { return this.size }
  show() {}
  focus() {}
  destroy() { this.destroyed = true; this.emit('closed') }
}

const filename = path.resolve('src/main/page-windows.js')
const context = { module: { exports: {} }, __dirname: path.dirname(filename), setTimeout, clearTimeout, setImmediate,
  require: (name) => name === 'electron' ? { BrowserWindow: Window, WebContentsView: View } : require(name) }
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
const main = new Window()
const pages = context.module.exports.createPageWindows({ main, isDev: false, hidden: true,
  icon: '', background: () => '#000000', secure: () => {} })
const open = async (page, detached = false) => {
  const pending = pages.navigate({ page }, detached)
  pages.ready(pages.contents(page))
  await pending
  return views.find((view) => view.webContents === pages.contents(page))
}

async function test() {
  await assert.rejects(pages.navigate({ page: '../invalid' }))
  await assert.rejects(pages.navigate({ page: NAV_PAGES[0], action: 'evil' }))
  assert.equal(pages.owns(new Contents()), false)
  assert.equal(pages.ready(new Contents()), false)
  const first = await open(NAV_PAGES[0])
  assert.equal(pages.owns(first.webContents), true)
  assert.equal(main.children.has(first), true)
  await open(NAV_PAGES[0], true)
  const popup = pages.host(first.webContents)
  assert.notEqual(popup, main)
  assert.equal(main.children.has(first), false)
  assert.equal(popup.children.has(first), true)
  assert.equal(first.visible, true)
  // 工作列顯示的是視窗標題：要帶那一頁的名稱，不能每個都叫 AxonDeck
  const navLabel = fs.readFileSync('src/renderer/index.html', 'utf8')
    .match(new RegExp(`data-page="${NAV_PAGES[0]}"[^>]*aria-label="([^"]+)"`))[1]
  assert.equal(popup.options.title, `${navLabel} — AxonDeck`)
  await open(NAV_PAGES[0], true)
  assert.equal(views.length, 1)
  assert.equal(windows.length, 2)
  popup.size = [1000, 650]
  popup.emit('resize')
  assert.equal(first.bounds.width, 1000)
  const second = await open(NAV_PAGES[1], true)
  assert.notEqual(pages.host(second.webContents), popup)
  popup.emit('minimize')
  assert.equal(!!popup.destroyed, false) // 原生事件內不同步 destroy
  await new Promise(setImmediate)
  assert.equal(popup.destroyed, true)
  assert.equal(main.children.has(first), true)
  assert.equal(first.webContents.isDestroyed(), false)
  assert.notEqual(pages.host(second.webContents), main)
  const secondPopup = pages.host(second.webContents)
  let prevented = false
  secondPopup.emit('close', { preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  // 收回時主視窗維持原本那頁，收回的頁先藏著
  assert.equal(main.children.has(first), true)
  assert.equal(first.visible, true)
  assert.equal(main.children.has(second), false)
  assert.equal(second.visible, false)
  main.size = [1600, 1000]
  main.emit('resize')
  assert.equal(first.bounds.height, 1000)
  assert.equal(pages.dock(second.webContents), false)
  await open(NAV_PAGES[1])
  assert.equal(main.children.has(second), true)
  assert.equal(await pages.history(-1), true)
  assert.equal(main.children.has(first), true)
  const slow = pages.navigate({ page: NAV_PAGES[2] })
  await open(NAV_PAGES[1])
  pages.ready(pages.contents(NAV_PAGES[2]))
  assert.equal(await slow, false)
  assert.equal(main.children.has(second), true)
  await open(NAV_PAGES[0], true)
  main.destroy()
  assert.ok(views.every((view) => view.webContents.isDestroyed()))
  assert.ok(windows.every((win) => win.isDestroyed()))
  console.log('PASS 功能視窗：驗證、單一實例、原生最小化／關閉、搬移、尺寸、歷史、競態與清理')
}
test().catch((error) => { console.error(error); main.destroy(); process.exitCode = 1 })
