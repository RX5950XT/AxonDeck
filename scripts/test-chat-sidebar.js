/**
 * chat-sidebar.js 回歸：
 * - 改名輸入框在 IME 選字期間的 Enter 不得送出
 * - 對話與資料夾整列右鍵／選單鍵叫出選單（沒有三點與改名、刪除小按鈕）
 * - 選單貼游標並夾在視窗內；兩參數的 openChatMenu 仍貼在 anchor
 * 不啟動 renderer 或 Electron。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.join(__dirname, '..', 'src/renderer/scripts')
const sidebarFile = path.join(root, 'chat-sidebar.js')
const sidebarSource = fs.readFileSync(sidebarFile, 'utf8')

const MENU_W = 180
const MENU_H = 220
const WIN_W = 500
const WIN_H = 400

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert(start >= 0, `找不到 ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`函式沒結束 ${name}`)
}

class ImeInput {
  constructor(tagName) {
    this.tagName = tagName
    this.listeners = new Map()
    this.parentElement = { querySelector: () => null }
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  setAttribute() {}

  dispatch(type, event) {
    return this.listeners.get(type)?.(event)
  }

  replaceWith(element) {
    this.replacedWith = element
  }

  focus() {}
  select() {}
}

async function runRenameIme() {
  const functionSource = extractFunction(sidebarSource, 'startRename')
  const document = { createElement: (tagName) => new ImeInput(tagName) }
  let renderCount = 0
  const context = { document, renderPending: false, render: () => { renderCount++ } }
  vm.runInNewContext(`${functionSource}\nthis.startRename = startRename`, context)

  async function renameWithKeydown(props) {
    const text = new ImeInput('span')
    const commits = []
    context.startRename(text, '舊名稱', 40, async (next) => { commits.push(next) })
    const input = text.replacedWith
    input.value = '新名稱'
    let prevented = false
    input.dispatch('keydown', {
      key: 'Enter',
      preventDefault: () => { prevented = true },
      ...props
    })
    await Promise.resolve()
    return { commits, prevented, input, text }
  }

  for (const props of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    const result = await renameWithKeydown(props)
    assert.deepEqual(result.commits, [])
    assert.equal(result.prevented, false)
    assert.equal(result.input.replacedWith, undefined)
  }
  const normal = await renameWithKeydown({ isComposing: false, keyCode: 13 })
  assert.deepEqual(normal.commits, ['新名稱'])
  assert.equal(normal.prevented, true)
  assert.equal(normal.input.replacedWith, normal.text)
  assert.equal(renderCount, 0)
  console.log('PASS: chat-sidebar 改名在 IME Enter 不送出，普通 Enter 仍送出')
}

function hasClass(el, name) {
  return (el.className || '').split(/\s+/).includes(name)
}

class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase()
    this.doc = doc
    this.className = ''
    this.children = []
    this.parentElement = null
    this.dataset = {}
    this.attrs = {}
    this.style = {}
    this.hidden = false
    this.disabled = false
    this.tabIndex = undefined
    this.rect = null
    this._text = ''
    this._listeners = {}
    this.classList = {
      add: (...names) => {
        const set = new Set((this.className || '').split(/\s+/).filter(Boolean))
        for (const name of names) set.add(name)
        this.className = [...set].join(' ')
      },
      remove: (...names) => {
        const drop = new Set(names)
        this.className = (this.className || '').split(/\s+/).filter((name) => name && !drop.has(name)).join(' ')
      },
      contains: (name) => hasClass(this, name)
    }
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent || '').join('')
    return this._text
  }

  set textContent(value) {
    this._text = value == null ? '' : String(value)
    for (const child of this.children) child.parentElement = null
    this.children = []
  }

  get offsetWidth() {
    return hasClass(this, 'chat-menu') ? MENU_W : 0
  }

  get offsetHeight() {
    return hasClass(this, 'chat-menu') ? MENU_H : 0
  }

  getBoundingClientRect() {
    return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = []
    this._listeners[type].push(fn)
  }

  appendChild(child) {
    if (child.parentElement) child.remove()
    child.parentElement = this
    this.children.push(child)
    return child
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null
    this.children = []
    for (const node of nodes) this.appendChild(node)
  }

  replaceWith(node) {
    const parent = this.parentElement
    if (!parent) return
    const index = parent.children.indexOf(this)
    if (node.parentElement) node.remove()
    parent.children[index] = node
    node.parentElement = parent
    this.parentElement = null
  }

  remove() {
    const parent = this.parentElement
    if (!parent) return
    const index = parent.children.indexOf(this)
    if (index >= 0) parent.children.splice(index, 1)
    this.parentElement = null
  }

  before(node) {
    const parent = this.parentElement
    if (!parent) return
    if (node.parentElement) node.remove()
    const index = parent.children.indexOf(this)
    parent.children.splice(index, 0, node)
    node.parentElement = parent
  }

  after(node) {
    const parent = this.parentElement
    if (!parent) return
    if (node.parentElement) node.remove()
    const index = parent.children.indexOf(this)
    parent.children.splice(index + 1, 0, node)
    node.parentElement = parent
  }

  matches(sel) {
    return sel.split(/\s*,\s*/).some((part) => matchesSimple(this, part))
  }

  closest(sel) {
    let node = this
    while (node) {
      if (node.matches?.(sel)) return node
      node = node.parentElement
    }
    return null
  }

  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentElement
    }
    return false
  }

  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/)
    let current = [this]
    for (const part of parts) {
      const next = []
      for (const node of current) walk(node, (el) => { if (matchesSimple(el, part)) next.push(el) })
      current = next
    }
    return current
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null
  }

  focus() {
    this.doc.activeElement = this
  }

  select() {}

  dispatch(type, props = {}) {
    const event = {
      bubbles: true,
      button: 0,
      key: '',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      clientX: 0,
      clientY: 0,
      isComposing: false,
      keyCode: 0,
      ...props,
      type,
      defaultPrevented: false,
      _stop: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this._stop = true }
    }
    const chain = []
    for (let node = this; node; node = node.parentElement) chain.push(node)
    event.target = this
    for (const node of chain) {
      event.currentTarget = node
      for (const fn of (node._listeners[type] || []).slice()) fn(event)
      if (event._stop) break
    }
    return event
  }
}

function matchesSimple(el, sel) {
  if (!el || el.tagName === '#TEXT') return false
  if (sel === 'button:not(:disabled)') return el.tagName === 'BUTTON' && !el.disabled
  let dataId = null
  const rest = sel.replace(/\[data-id="([^"]*)"\]/g, (_, value) => {
    dataId = value
    return ''
  })
  if (dataId !== null && el.dataset?.id !== dataId) return false
  if (!rest) return true
  if (rest.startsWith('.')) {
    const need = rest.slice(1).split('.').filter(Boolean)
    return need.every((name) => hasClass(el, name))
  }
  return el.tagName === rest.toUpperCase()
}

function walk(node, visit) {
  for (const child of node.children || []) {
    visit(child)
    walk(child, visit)
  }
}

function createDocument() {
  const doc = {
    activeElement: null,
    _listeners: [],
    createElement(tag) { return new El(tag, doc) },
    createElementNS(_ns, tag) { return new El(tag, doc) },
    createTextNode(text) {
      const node = new El('#text', doc)
      node.textContent = text
      return node
    },
    addEventListener(type, fn) { doc._listeners.push({ type, fn }) },
    removeEventListener(type, fn) {
      doc._listeners = doc._listeners.filter((entry) => entry.type !== type || entry.fn !== fn)
    },
    emit(type, event) {
      for (const entry of doc._listeners.slice()) if (entry.type === type) entry.fn(event)
    },
    elementFromPoint() { return null },
    querySelector(sel) { return doc.body.querySelector(sel) },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel) }
  }
  doc.body = new El('body', doc)
  return doc
}

function stripModule(source) {
  return source.replace(/^import .*$/gm, '').replace(/^export /gm, '')
}

function loadSandbox() {
  const document = createDocument()
  const windowListeners = []
  const sandbox = {
    Math,
    Number,
    Promise,
    setTimeout,
    clearTimeout,
    console,
    CSS: { escape: (value) => String(value) },
    innerWidth: WIN_W,
    innerHeight: WIN_H,
    document,
    addEventListener(type, fn) { windowListeners.push({ type, fn }) },
    removeEventListener(type, fn) {
      const index = windowListeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (index >= 0) windowListeners.splice(index, 1)
    },
    emit(type, event) {
      for (const entry of windowListeners.slice()) if (entry.type === type) entry.fn(event)
    }
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  for (const name of ['usage-reorder.js', 'list-reorder.js', 'chat-menu.js', 'chat-sidebar.js']) {
    vm.runInContext(stripModule(fs.readFileSync(path.join(root, name), 'utf8')), sandbox, { filename: name })
  }
  return sandbox
}

function menuButtons(document) {
  return document.querySelectorAll('.chat-menu-item')
}

function menuPos(document) {
  const menu = document.querySelector('.chat-menu')
  if (!menu) return null
  return { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function runRowMenu() {
  /** @type {string[]} */
  const failures = []
  const check = (name, ok, detail) => {
    if (ok) console.log(`PASS: ${name}`)
    else {
      console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
      failures.push(name)
    }
  }

  check('側欄沒有刪除鈕計時器', !sidebarSource.includes('DELETE_ARM_MS') && !sidebarSource.includes('function armDelete') && !sidebarSource.includes('function disarmDelete'))
  check('側欄沒有三點小按鈕helper', !sidebarSource.includes('function listActionButton') && !sidebarSource.includes("className = 'chat-list-btn'"))
  check('側欄接上右鍵與選單鍵', sidebarSource.includes("addEventListener('contextmenu'") && sidebarSource.includes("'ContextMenu'") && sidebarSource.includes("'F10'"))

  const sandbox = loadSandbox()
  const { document } = sandbox
  const anchor = document.createElement('button')
  anchor.rect = { left: 100, top: 10, right: 200, bottom: 40, width: 100, height: 30 }
  document.body.appendChild(anchor)
  const items = [{ label: 'A', onSelect() {} }]

  sandbox.openChatMenu(anchor, items)
  let pos = menuPos(document)
  // 貼在 anchor 下方：bottom 40 + 4 = 44；44+220 沒超出 400-8
  check('兩參數仍貼在 anchor 下方', pos && pos.left === 100 && pos.top === 44, JSON.stringify(pos))
  sandbox.openChatMenu(anchor, items)
  check('兩參數再叫一次收合', document.querySelector('.chat-menu') == null)

  anchor.rect = { left: 100, top: 350, right: 200, bottom: 380, width: 100, height: 30 }
  sandbox.openChatMenu(anchor, items)
  pos = menuPos(document)
  // 384+220 超出 392，改貼到 anchor 上方：350-220-4 = 126
  check('兩參數超出下緣仍往上翻', pos && pos.left === 100 && pos.top === 126, JSON.stringify(pos))
  sandbox.closeChatMenu()

  sandbox.openChatMenu(anchor, items, { x: 40, y: 50 })
  pos = menuPos(document)
  check('第三參數貼在游標', pos && pos.left === 40 && pos.top === 50, JSON.stringify(pos))
  sandbox.openChatMenu(anchor, items, { x: 400, y: 300 })
  pos = menuPos(document)
  // 400+180 > 492 → 312；300+220 > 392 → 172。再叫一次不得收合
  check('游標貼齊並夾在視窗內', pos && pos.left === 312 && pos.top === 172, JSON.stringify(pos))
  sandbox.openChatMenu(anchor, items, { x: 0, y: 0 })
  pos = menuPos(document)
  check('貼邊仍留 8px', pos && pos.left === 8 && pos.top === 8, JSON.stringify(pos))
  sandbox.closeChatMenu()

  const api = []
  let confirmGate = null
  const opened = []
  sandbox.electronAPI = {
    chat: {
      async list() { return sandbox._conversations.map((row) => ({ ...row })) },
      async folders() { return sandbox._folders.map((row) => ({ ...row })) },
      async rename(id, title) { api.push(['rename', id, title]) },
      async delete(id) { api.push(['delete', id]) },
      async moveToFolder(id, folderId) { api.push(['move', id, folderId]) },
      async createFolder(name) {
        api.push(['createFolder', name])
        return { id: 'f-new', name }
      },
      async updateFolder(id, patch) { api.push(['updateFolder', id, patch]) },
      async deleteFolder(id) { api.push(['deleteFolder', id]) },
      async export(id) { api.push(['export', id]); return { ok: true, saved: true } },
      async reorder(payload) { api.push(['reorder', payload]) },
      async reorderFolders(ids) { api.push(['reorderFolders', ids]) }
    }
  }
  sandbox.showToast = () => {}
  sandbox.cleanIpcError = (error) => String(error?.message || error)
  sandbox.askConfirm = (title, opts = {}) => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    confirmGate = { title, opts, resolve, promise }
    return promise
  }
  sandbox.askInput = async () => '專案'

  async function mount(conversations, folders) {
    sandbox._conversations = conversations
    sandbox._folders = folders
    sandbox.closeChatMenu()
    const listEl = document.createElement('div')
    document.body.appendChild(listEl)
    const sidebar = sandbox.createChatSidebar({
      listEl,
      searchInput: null,
      getCurrentId: () => '',
      statusOf: () => '',
      onOpen: (id) => opened.push(id),
      onNew: (folderId) => api.push(['new', folderId]),
      onDeleted: async (id) => { api.push(['deleted', id]) }
    })
    await sidebar.reload()
    return { listEl, sidebar }
  }

  try {
    const { listEl } = await mount(
      [
        { id: 'c1', title: '甲', updatedAt: 1, folderId: 'f1', messageCount: 2 },
        { id: 'c2', title: '乙', updatedAt: 2, folderId: '', messageCount: 1 }
      ],
      [{ id: 'f1', name: '工作', collapsed: false }]
    )
    const item = listEl.querySelector('.chat-list-item')
    const openBtn = item?.querySelector('.chat-list-open')
    const head = listEl.querySelector('.chat-folder-head')
    const toggle = head?.querySelector('.chat-folder-toggle')
    check('對話列沒有小按鈕', item && item.querySelectorAll('.chat-list-btn').length === 0, String(item?.querySelectorAll('.chat-list-btn').length))
    check('資料夾列沒有小按鈕', head && head.querySelectorAll('.chat-list-btn').length === 0)
    check('列可被程式聚焦', item?.tabIndex === -1 && head?.tabIndex === -1, `item=${item?.tabIndex} head=${head?.tabIndex}`)

    const contextEvent = openBtn.dispatch('contextmenu', { button: 2, clientX: 40, clientY: 50 })
    const labels = menuButtons(document).map((button) => button.textContent)
    check('右鍵不開啟對話', opened.length === 0, opened.join(','))
    check('右鍵擋掉瀏覽器選單', contextEvent.defaultPrevented === true)
    check('對話選單含改名刪除匯出與搬移',
      labels.indexOf('重新命名') >= 0
      && labels.indexOf('重新命名') < labels.indexOf('刪除對話')
      && labels.indexOf('刪除對話') < labels.indexOf('匯出 Markdown…')
      && labels.indexOf('匯出 Markdown…') < labels.indexOf('未分類')
      && labels.indexOf('未分類') < labels.indexOf('工作')
      && labels.indexOf('工作') < labels.indexOf('＋ 新資料夾並移入…'),
      labels.join('|'))
    const work = menuButtons(document).find((button) => button.textContent === '工作')
    const loose = menuButtons(document).find((button) => button.textContent === '未分類')
    const danger = menuButtons(document).find((button) => button.textContent === '刪除對話')
    check('目前資料夾打勾', work?.getAttribute('aria-checked') === 'true' && loose?.getAttribute('aria-checked') === 'false')
    check('刪除是危險項', Boolean(danger && hasClass(danger, 'is-danger')))
    pos = menuPos(document)
    check('對話選單開在游標', pos && pos.left === 40 && pos.top === 50, JSON.stringify(pos))

    openBtn.dispatch('click')
    check('左鍵仍開啟對話', opened.length === 1 && opened[0] === 'c1', opened.join(','))

    if (danger) {
      danger.dispatch('click')
      check('刪除先確認、尚未刪', confirmGate?.opts?.danger === true && confirmGate.title.includes('甲') && !api.some((call) => call[0] === 'delete'))
      confirmGate.resolve(false)
      await confirmGate.promise
      await flush()
      check('取消不刪對話', !api.some((call) => call[0] === 'delete'))
    }

    item.rect = { left: 30, top: 350, right: 230, bottom: 390, width: 200, height: 40 }
    const keyEvent = openBtn.dispatch('keydown', { key: 'F10', shiftKey: true })
    pos = menuPos(document)
    // 鍵盤沒有游標：貼在列底 (30+8, 390)，高度超出就上移到 172
    check('Shift+F10 叫出選單並夾在視窗內', keyEvent.defaultPrevented === true && pos && pos.left === 38 && pos.top === 172, JSON.stringify(pos))
    const menuKey = openBtn.dispatch('keydown', { key: 'ContextMenu' })
    check('ContextMenu 後選單還在', menuKey.defaultPrevented === true && document.querySelector('.chat-menu') != null)
    openBtn.dispatch('contextmenu', { button: 0, clientX: 0, clientY: 0 })
    check('鍵盤 contextmenu 不把選單收掉', document.querySelector('.chat-menu') != null)
    document.emit('keydown', {
      key: 'Escape',
      preventDefault() {},
      stopPropagation() {}
    })
    check('Escape 回到原列', document.activeElement === item && document.querySelector('.chat-menu') == null)

    openBtn.dispatch('contextmenu', { button: 2, clientX: 40, clientY: 50 })
    menuButtons(document).find((button) => button.textContent === '重新命名')?.dispatch('click')
    const input = listEl.querySelector('.chat-list-rename')
    check('選單改名換成輸入框', Boolean(input))
    if (input) {
      input.value = '新名'
      input.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false })
      await flush()
      check('改名寫回', api.some((call) => call[0] === 'rename' && call[1] === 'c1' && call[2] === '新名'))
    }

    const fresh = listEl.querySelector('.chat-list-item[data-id="c1"] .chat-list-open')
    fresh?.dispatch('contextmenu', { button: 2, clientX: 40, clientY: 50 })
    menuButtons(document).find((button) => button.textContent === '刪除對話')?.dispatch('click')
    if (confirmGate && !api.some((call) => call[0] === 'delete')) {
      confirmGate.resolve(true)
      await confirmGate.promise
      await flush()
    }
    check('確認後才刪對話', api.some((call) => call[0] === 'delete' && call[1] === 'c1') && api.some((call) => call[0] === 'deleted' && call[1] === 'c1'))

    fresh?.dispatch('contextmenu', { button: 2, clientX: 40, clientY: 50 })
    menuButtons(document).find((button) => button.textContent === '匯出 Markdown…')?.dispatch('click')
    await flush()
    check('匯出這則對話', api.some((call) => call[0] === 'export' && call[1] === 'c1'))

    fresh?.dispatch('contextmenu', { button: 2, clientX: 40, clientY: 50 })
    menuButtons(document).find((button) => button.textContent === '未分類')?.dispatch('click')
    await flush()
    check('移出資料夾', api.some((call) => call[0] === 'move' && call[1] === 'c1' && call[2] === ''))

    fresh?.dispatch('contextmenu', { button: 2, clientX: 40, clientY: 50 })
    menuButtons(document).find((button) => button.textContent === '＋ 新資料夾並移入…')?.dispatch('click')
    await flush()
    check('新資料夾並移入', api.some((call) => call[0] === 'createFolder' && call[1] === '專案') && api.some((call) => call[0] === 'move' && call[1] === 'c1' && call[2] === 'f-new'))

    const folderEvent = toggle.dispatch('contextmenu', { button: 2, clientX: 36, clientY: 70 })
    const folderLabels = menuButtons(document).map((button) => button.textContent)
    pos = menuPos(document)
    check('資料夾右鍵不收合', folderEvent.defaultPrevented === true && !api.some((call) => call[0] === 'updateFolder'))
    check('資料夾選單在游標', pos && pos.left === 36 && pos.top === 70, JSON.stringify(pos))
    check('資料夾選單含新增改名刪除',
      folderLabels.includes('在這裡新增對話') && folderLabels.includes('重新命名') && folderLabels.includes('刪除資料夾')
      && !folderLabels.includes('匯出 Markdown…'),
      folderLabels.join('|'))
    menuButtons(document).find((button) => button.textContent === '在這裡新增對話')?.dispatch('click')
    check('在資料夾新增對話', api.some((call) => call[0] === 'new' && call[1] === 'f1'))

    toggle.dispatch('contextmenu', { button: 2, clientX: 36, clientY: 70 })
    const deleteFolder = menuButtons(document).find((button) => button.textContent === '刪除資料夾')
    check('刪資料夾是危險項', Boolean(deleteFolder && hasClass(deleteFolder, 'is-danger')))
    if (deleteFolder) {
      deleteFolder.dispatch('click')
      check('刪資料夾先確認', confirmGate?.title?.includes('工作') && confirmGate.opts?.danger === true && !api.some((call) => call[0] === 'deleteFolder'))
      confirmGate.resolve(false)
      await confirmGate.promise
      await flush()
      check('取消不刪資料夾', !api.some((call) => call[0] === 'deleteFolder'))
    }

    const liveToggle = listEl.querySelector('.chat-folder-toggle')
    liveToggle.dispatch('click')
    await flush()
    check('左鍵仍收合資料夾', api.some((call) => call[0] === 'updateFolder' && call[2]?.collapsed === true))

    api.length = 0
    const dragged = await mount(
      [
        { id: 'a', title: 'A', updatedAt: 1, folderId: '', messageCount: 1 },
        { id: 'b', title: 'B', updatedAt: 2, folderId: '', messageCount: 1 }
      ],
      []
    )
    const rows = dragged.listEl.querySelectorAll('.chat-list-item')
    rows[0].rect = { left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 }
    rows[1].rect = { left: 0, top: 50, right: 200, bottom: 90, width: 200, height: 40 }
    rows[1].dispatch('pointerdown', { button: 2, clientX: 20, clientY: 70 })
    rows[1].dispatch('contextmenu', { button: 2, clientX: 40, clientY: 60 })
    check('右鍵不寫入排序', !api.some((call) => call[0] === 'reorder'))
    sandbox.closeChatMenu()
    rows[1].dispatch('pointerdown', { button: 0, clientX: 20, clientY: 70 })
    sandbox.emit('pointermove', { button: 0, clientX: 20, clientY: 10 })
    sandbox.emit('pointerup', { button: 0, clientX: 20, clientY: 10 })
    await flush()
    const reorder = api.find((call) => call[0] === 'reorder')
    const order = reorder ? reorder[1].map((entry) => entry.id || entry) : []
    check('左鍵拖曳仍寫回順序', order[0] === 'b' && order[1] === 'a', order.join(','))
  } catch (error) {
    check('側欄案例沒丟例外', false, error.stack || error.message)
  }

  return failures
}

async function run() {
  await runRenameIme()
  const failures = await runRowMenu()
  if (failures.length) {
    console.error(`FAIL: ${failures.length} failed`)
    process.exitCode = 1
    return
  }
  console.log('PASS: 側欄整列右鍵選單、定位與刪除確認')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
