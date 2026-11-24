#!/usr/bin/env node
'use strict'

/**
 * 獨立瀏覽器視窗的尋找列：工具列高度、開／關尋找列會讓網頁讓位、
 * findInPage 打在網頁（WebContentsView）而不是工具列自己。
 */

const assert = require('assert/strict')
const Module = require('module')
const path = require('path')

const wins = []
const views = []

class FakeWebContents {
  constructor(kind) {
    this.kind = kind
    this.id = FakeWebContents.nextId++
    this.destroyed = false
    this.handlers = {}
    this.sent = []
    this.findCalls = []
    this.stopCalls = []
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  }
  isDestroyed() { return this.destroyed }
  isLoading() { return false }
  getURL() { return 'https://example.com/' }
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return this }
  once(name, fn) { this.on(name, fn); return this }
  send(channel, payload) { this.sent.push([channel, payload]) }
  findInPage(query, options) { this.findCalls.push([query, options]) }
  stopFindInPage(action) { this.stopCalls.push(action) }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  setWindowOpenHandler() {}
  setTitle() {}
}
FakeWebContents.nextId = 1

class FakeView {
  constructor() {
    this.webContents = new FakeWebContents('page')
    this.bounds = null
    views.push(this)
  }
  setBounds(bounds) { this.bounds = bounds }
}

class FakeWindow {
  constructor() {
    this.webContents = new FakeWebContents('bar')
    this.contentView = { addChildView() {} }
    this.handlers = {}
    this._size = [1200, 820]
    wins.push(this)
  }
  setMenu() {}
  getContentSize() { return this._size }
  on(name, fn) { (this.handlers[name] ||= []).push(fn) }
  once(name, fn) { this.on(name, fn) }
  isDestroyed() { return false }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  show() {}
}

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { BrowserWindow: FakeWindow, WebContentsView: FakeView }
  }
  return origLoad.call(this, request, ...rest)
}

const bw = require('../src/main/browser-window')

assert.equal(bw.BAR_HEIGHT, 44)
assert.equal(bw.FIND_BAR_HEIGHT, 36)
assert.equal(bw.chromeHeight(false), 44)
assert.equal(bw.chromeHeight(true), 80)
assert.equal(bw.chromeHeight(0), 44, '沒開尋找列時不要多加高度')

async function main() {
  const win = await bw.open('https://example.com/', 'Example')
  assert.ok(win)
  const view = views[0]
  const bar = win.webContents
  assert.deepEqual(view.bounds, { x: 0, y: 44, width: 1200, height: 776 })

  assert.equal(bw.setFindOpen(bar, true), true)
  assert.deepEqual(view.bounds, { x: 0, y: 80, width: 1200, height: 740 }, '開尋找列時網頁下移 36px')

  win._size = [800, 500]
  view.bounds = null
  win.handlers.resize.forEach((fn) => fn())
  assert.deepEqual(view.bounds, { x: 0, y: 80, width: 800, height: 420 }, '縮放時仍扣掉尋找列')

  assert.equal(bw.setFindOpen(bar, false), true)
  assert.equal(view.bounds.y, 44)

  const page = view.webContents
  assert.equal(bw.findInPage(bar, 'hello', { forward: true, findNext: false }), true)
  assert.deepEqual(page.findCalls, [['hello', { forward: true, findNext: false }]])
  assert.equal(bw.findInPage(bar, '', {}), true)
  assert.deepEqual(page.stopCalls, ['clearSelection'])
  assert.equal(bw.stopFindInPage(bar), true)
  assert.deepEqual(page.stopCalls, ['clearSelection', 'clearSelection'])

  const found = page.handlers['found-in-page']
  assert.ok(found && found.length, '要轉送 found-in-page 給工具列')
  found[0]({}, { matches: 3, activeMatchOrdinal: 1 })
  assert.deepEqual(bar.sent.filter((row) => row[0] === 'browserWindow:foundInPage'), [
    ['browserWindow:foundInPage', { matches: 3, activeMatchOrdinal: 1 }]
  ])

  assert.equal(bw.setFindOpen({ id: 999999 }, true), false)
  assert.equal(bw.findInPage({ id: 999999 }, 'x'), false)

  const preload = require('fs').readFileSync(path.join(__dirname, '../src/preload/browser-window-preload.js'), 'utf8')
  assert.match(preload, /browserWindow:setFindOpen/)
  assert.match(preload, /browserWindow:findInPage/)
  const html = require('fs').readFileSync(path.join(__dirname, '../src/renderer/pages/browser-window.html'), 'utf8')
  assert.match(html, /id="bwFind"/)
  const renderer = require('fs').readFileSync(path.join(__dirname, '../src/renderer/scripts/browser-window.js'), 'utf8')
  assert.match(renderer, /handleFindShortcut/)
  const main = require('fs').readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.match(main, /browserWindow:findInPage/)

  console.log('test-browser-window-find: all passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
