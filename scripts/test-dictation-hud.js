'use strict'

// 不開窗、不錄音：驗證暖機後重新載入與螢幕位置變動。
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')

let display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
class Window extends EventEmitter {
  constructor(opts) {
    super()
    this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }
    this.visible = false
    this.destroyed = false
    this.webContents = new EventEmitter()
    this.messages = []
    this.webContents.send = (_channel, payload) => this.messages.push(payload)
    this.webContents.setWindowOpenHandler = () => {}
  }
  setMenu() {}
  setAlwaysOnTop() {}
  loadFile() {}
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  getBounds() { return this.bounds }
  setBounds(bounds) { this.bounds = bounds }
  showInactive() { this.visible = true }
  hide() { this.visible = false }
  destroy() { this.destroyed = true; this.emit('closed') }
}
const source = path.join(__dirname, '../src/main/dictation/hud.js')
const mod = { exports: {} }
vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
  module: mod, __dirname: path.dirname(source), setTimeout, clearTimeout,
  require: (id) => id === 'electron' ? {
    BrowserWindow: Window,
    screen: { getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) }
  } : require(id)
}, { filename: source })
const hud = mod.exports
function check(name, run) {
  try { run(); console.log(`PASS: ${name}`) }
  catch (err) { console.error(`FAIL: ${name}: ${err.message}`); process.exitCode = 1 }
}

hud.warm()
const win = hud._window()
check('暖機及重新載入後會補送最新狀態', () => {
  hud.update({ state: 'processing' })
  assert.equal(win.messages.length, 0)
  win.webContents.emit('did-finish-load')
  assert.equal(win.messages.at(-1).state, 'processing')
  win.webContents.emit('did-start-loading')
  hud.update({ state: 'recording', level: 0.4 })
  assert.equal(win.messages.length, 1, '重新載入期間先保留最新狀態，不送到舊頁面')
  win.webContents.emit('did-finish-load')
  assert.equal(win.messages.at(-1).state, 'recording', '重新載入後補送狀態，膠囊才會顯示')
})

check('螢幕工作區變動及 OS 移位後會重新定位', () => {
  display = { ...display, workArea: { x: 0, y: 0, width: 1280, height: 720 } }
  hud.update({ state: 'recording' })
  assert.equal(win.bounds.x, Math.round((1280 - hud.SIZE.width) / 2), '同一螢幕改解析度也要重新定位')
  assert.equal(win.bounds.y, 720 - hud.SIZE.height - hud.MARGIN_BOTTOM)
  win.bounds = { ...win.bounds, x: -4000 }
  hud.update({ state: 'recording' })
  assert.equal(win.bounds.x, Math.round((1280 - hud.SIZE.width) / 2), '被 OS 移走後要回到畫面內')
})
hud.close()
