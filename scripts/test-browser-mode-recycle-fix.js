// 三個小修正的回歸測試：
// (a) 從 Browser 切回 Agent／Chat 要離開瀏覽器，收起的側欄也要點得到模式切換
// (b) 回收筒裡的整機搜尋結果要照一般檔案開，不能假裝「已還原」
// (c) 新增檔案／資料夾連按兩下，第一格輸入框不能被吃掉
const fs = require('fs')
const vm = require('vm')
const assert = require('assert/strict')

const strip = (file) => fs.readFileSync(file, 'utf8').replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '').replace(/^export /gm, '')
let passed = 0
const ok = (label) => { passed += 1; console.log(`ok - ${label}`) }

async function explorer() {
  const toasts = []
  const restored = []
  const api = {
    restoreEntry: async (key) => { restored.push(key); return { ok: true } },
    watch: async () => ({ ok: true, data: {} }), saveState: async () => {}, uffsCancel: async () => {},
  }
  const context = {
    console, setTimeout, clearTimeout,
    document: { getElementById: () => null },
    electronAPI: { explorer: api },
    showToast: (text, kind) => toasts.push([text, kind || '']),
  }
  vm.createContext(context)
  vm.runInContext(strip('src/renderer/scripts/explorer-dnd.js'), context)
  vm.runInContext(strip('src/renderer/scripts/explorer-page.js'), context)
  const run = (code) => vm.runInContext(code, context)
  run('paintList=paintStatus=paintCrumbs=paintNav=paintSidebar=paintRecycleChrome=()=>{}')
  run('globalThis.__nav = []; activeInRecycle = () => true; rightActive = () => false; navigate = async (p) => { __nav.push(p) }; refreshAfterMutate = async () => {}')

  await run("openEntry({ name: 'Docs', path: '/home/u/Docs', dir: true })")
  assert.deepEqual(restored, [], '搜尋結果不能送去還原')
  assert.equal(run('JSON.stringify(__nav)'), '["/home/u/Docs"]', '回收筒裡搜到的資料夾要直接進去')
  assert.ok(!toasts.some(([t]) => t.includes('已還原')), '沒還原就不能說已還原')
  ok('回收筒搜尋結果的資料夾：導航，不還原')

  await run("openEntry({ name: 'old.txt', recycleKey: 'k1', path: '' })")
  assert.deepEqual(restored, ['k1'])
  assert.deepEqual(toasts.at(-1), ['已還原', ''])
  ok('真正的回收筒項目：照舊還原')

  toasts.length = 0
  await run("restoreItems([{ name: 'a.txt', path: '/home/u/a.txt' }])")
  assert.deepEqual(restored, ['k1'], '沒有 recycleKey 的不送')
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0][1], 'error')
  assert.ok(!toasts[0][0].includes('已還原'))
  ok('全是搜尋結果時按「還原」：報錯，不假裝成功')

  toasts.length = 0
  await run("restoreItems([{ name: 'a.txt', path: '/x' }, { name: 'b', recycleKey: 'k2' }])")
  assert.deepEqual(restored, ['k1', 'k2'])
  assert.match(toasts[0][0], /已還原 1 個項目/)
  ok('混選：只還原回收筒項目，並說清楚數量')
}

function appModes() {
  // Windows 的 checkout 是 CRLF：先統一成 \n，下面的 \n}\n 才對得上
  const src = fs.readFileSync('src/renderer/scripts/app.js', 'utf8').replace(/\r\n/g, '\n')
  const fn = src.match(/export function paneAfterLeavingBrowser[\s\S]*?\n}\n/)
  assert.ok(fn, 'paneAfterLeavingBrowser 要存在')
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(fn[0].replace(/^export /, ''), ctx)
  const pick = (v) => vm.runInContext(`paneAfterLeavingBrowser(${JSON.stringify(v)})`, ctx)
  assert.equal(pick('workspace'), 'workspace')
  assert.equal(pick('web'), 'web')
  assert.equal(pick('chat'), 'chat')
  assert.equal(pick('browser'), 'chat')
  assert.equal(pick(undefined), 'chat')
  const init = src.match(/function initSidebarModes\(\) \{[\s\S]*?\n}\n/)[0]
  assert.match(init, /chatPaneMode === 'browser'\) setChatPaneMode\(paneAfterLeavingBrowser\(lastNonBrowserPane\)\)/, '切出 Browser 模式要把主區帶回來')
  const setter = src.match(/export function setChatPaneMode[\s\S]*?\n}\n/)[0]
  assert.match(setter, /if \(mode !== 'browser'\) lastNonBrowserPane = mode/)
  ok('切出 Browser 模式會還原主區（回到進 Browser 前的畫面）')

  const css = fs.readFileSync('src/renderer/styles/main.css', 'utf8')
  assert.ok(!/:not\(\.bt-open\) :is\(\.sidebar-modes, \.bt-head\) \{\s*visibility: hidden/.test(css), '收起時不能把模式切換藏起來')
  assert.match(css, /:not\(\.bt-open\) \.sidebar-modes \{\s*flex-direction: column/)
  const browser = fs.readFileSync('src/renderer/scripts/browser-page.js', 'utf8')
  assert.match(browser, /sidebar\.addEventListener\('focusin'/, '鍵盤走進收起的側欄要展開')
  ok('收起的 Browser 側欄仍看得到 Agent／Browser／Chat')
}

class FakeEl {
  constructor(tag) { this.tagName = tag; this.childNodes = []; this.listeners = {}; this.attrs = {}; this.value = ''; this.isConnected = true; this.parent = null }
  setAttribute(k, v) { this.attrs[k] = v }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  emit(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ type, stopPropagation() {}, preventDefault() {}, ...extra }) }
  replaceChildren(...nodes) { this.childNodes = nodes; for (const n of nodes) if (n) n.parent = this }
  closest() { return null }
  querySelector(sel) { return sel === 'input' ? this.childNodes.find((n) => n.tagName === 'input') || null : null }
  select() {}
  setSelectionRange() {}
}

async function inlineEdit() {
  const timers = []
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(tag) }
  const ctx = {
    document: doc,
    HTMLElement: FakeEl,
    window: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length } },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null },
  }
  FakeEl.prototype.focus = function () { doc.activeElement = this; this.emit('focus') }
  vm.createContext(ctx)
  vm.runInContext(strip('src/renderer/scripts/inline-edit.js'), ctx)
  const fire = () => { for (const t of timers.splice(0)) t.fn?.() }

  // 新增：沒打字就失焦（按第二下「新增」），寬限期內回來就繼續打
  const slot = new FakeEl('span')
  let result = 'pending'
  vm.runInContext('editInline', ctx)(slot, { emptyBlurGraceMs: 1500 }).then((v) => { result = v })
  const input = slot.querySelector('input')
  doc.activeElement = null
  input.emit('blur')
  await Promise.resolve()
  assert.equal(result, 'pending', '寬限期內不能取消')
  assert.equal(vm.runInContext('isInlineEditing()', ctx), true)
  input.focus()
  fire()
  await Promise.resolve()
  assert.equal(result, 'pending', '回到輸入框後計時器不能再取消')
  input.value = 'newdir'
  input.emit('keydown', { key: 'Enter' })
  await Promise.resolve()
  assert.equal(result, 'newdir')
  ok('新增輸入框：連按第二下時保留第一格，打完照常建立')

  // 寬限期過了還沒回來：跟以前一樣取消
  const slot2 = new FakeEl('span')
  let r2 = 'pending'
  vm.runInContext('editInline', ctx)(slot2, { emptyBlurGraceMs: 1500 }).then((v) => { r2 = v })
  doc.activeElement = null
  slot2.querySelector('input').emit('blur')
  fire()
  await Promise.resolve()
  assert.equal(r2, null)
  ok('新增輸入框：真的點走了，寬限期後取消')

  // 改名（沒給寬限）：失焦＝確定，行為不變
  const slot3 = new FakeEl('span')
  let r3 = 'pending'
  vm.runInContext('editInline', ctx)(slot3, { value: 'a.txt' }).then((v) => { r3 = v })
  const in3 = slot3.querySelector('input')
  in3.value = 'b.txt'
  in3.emit('blur')
  await Promise.resolve()
  assert.equal(r3, 'b.txt')
  ok('改名：失焦仍然是確定（行為不變）')

  const ws = fs.readFileSync('src/renderer/scripts/workspace-page.js', 'utf8').replace(/\r\n/g, '\n')
  const create = ws.match(/async function createEntry\(project, relDir, dir\) \{[\s\S]*?\n}\n/)[0]
  assert.match(create, /if \(pendingInput\) \{\s*pendingInput\.focus\(\)\s*return/, '已有一格在等名字時，第二下要回到那一格')
  assert.match(create, /emptyBlurGraceMs: CREATE_BLUR_GRACE_MS/)
  ok('專案檔案樹：連按「新增資料夾」聚焦原本那一格')
}

;(async () => {
  await explorer()
  appModes()
  await inlineEdit()
  console.log(`${passed} passed`)
})().catch((error) => { console.error(error); process.exit(1) })
