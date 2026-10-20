'use strict'

// 用法：node scripts/test-workspace-commands.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function readModule(name) {
  return fs.readFileSync(path.join(__dirname, '../src/renderer/scripts', name), 'utf8')
    .replace(/^import .* from '[^']*'$/gm, '')
    .replace(/^export /gm, '')
}

function element(tag, document) {
  const attributes = new Map()
  const listeners = new Map()
  const classes = new Set()
  return {
    tag, children: [], hidden: false, value: '', parent: null,
    get isConnected() { return tag === 'body' || Boolean(this.parent?.isConnected) },
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name) } },
    setAttribute(name, value) { attributes.set(name, value) },
    getAttribute(name) { return attributes.get(name) },
    removeAttribute(name) { attributes.delete(name) },
    append(...items) { items.forEach((item) => this.appendChild(item)) },
    appendChild(item) { this.children.push(item); item.parent = this; return item },
    replaceChildren(...items) {
      this.children.forEach((item) => { item.parent = null })
      this.children = []
      this.append(...items)
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    fire(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map((handler) => handler(event)))
    },
    focus() { document.activeElement = this },
    scrollIntoView() {}
  }
}

function key(keyName, extras = {}) {
  return {
    key: keyName, keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false,
    metaKey: false, isComposing: false, prevented: false, stopped: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
    stopImmediatePropagation() { this.stopped = true },
    ...extras
  }
}

function harness(commands = []) {
  const document = {}
  Object.assign(document, element('document', document))
  document.body = element('body', document)
  document.createElement = (tag) => element(tag, document)
  const previous = element('textarea', document)
  document.body.appendChild(previous)
  previous.focus()
  const toasts = []
  const quick = vm.createContext({})
  vm.runInContext(`${readModule('ws-quickopen.js')}\nthis.scorePath = scorePath`, quick)
  const context = vm.createContext({ document, scorePath: quick.scorePath,
    showToast: (...args) => toasts.push(args) })
  vm.runInContext(`${readModule('ws-commands.js')}\nthis.api = {
    rankCommands, isCommandShortcut, workspaceCommandItems, createWorkspaceCommands
  }`, context)
  let active = true
  let available = commands
  const panel = context.api.createWorkspaceCommands({
    getCommands: () => typeof available === 'function' ? available() : available,
    isActive: () => active
  })
  return { document, previous, toasts, panel, api: context.api,
    setActive: (next) => { active = next },
    setCommands: (next) => { available = next },
    host: () => document.body.children[1],
    input: () => document.body.children[1].children[0].children[0],
    list: () => document.body.children[1].children[0].children[1] }
}

const tests = []
function test(label, run) { tests.push({ label, run }) }
const labels = (rows) => Array.from(rows, (row) => row.label)

test('模糊搜尋沿用 quick open 分數，忽略大小寫與前後空白', () => {
  const { api } = harness()
  const commands = ['切換專案 Alpha', '開啟 AI 記錄', '新增 Codex 終端機', '新增 Claude Code 終端機']
    .map((label) => ({ label }))
  assert.deepEqual(labels(api.rankCommands('  CODEX  ', commands)), ['新增 Codex 終端機'])
  assert.deepEqual(labels(api.rankCommands('cc', commands)), ['新增 Claude Code 終端機'])
  assert.equal(api.rankCommands('不存在', commands).length, 0)
  assert.deepEqual(labels(api.rankCommands(' ', commands)), labels(commands))
  assert.notEqual(api.rankCommands('', commands), commands)
})

test('完整命中排在零散命中前，路徑分隔符可搜尋', () => {
  const { api } = harness()
  const commands = [{ label: 'C o d e x' }, { label: 'Codex' }, { label: '專案 D:\\Workspace\\Alpha' }]
  assert.deepEqual(labels(api.rankCommands('codex', commands)), ['Codex', 'C o d e x'])
  assert.deepEqual(labels(api.rankCommands('d:/workspace/alpha', commands)), [commands[2].label])
})

test('所有指令類型與第 50 筆以後的專案都能找到', () => {
  const { api } = harness()
  const names = ['切換專案 Alpha', '切換終端機 Codex', '新增 Claude Code 終端機',
    '新增 Codex 終端機', '新增 Grok 終端機', '新增 OpenCode 終端機',
    '新增 Antigravity 終端機', '新增純 shell 終端機', '在新 worktree 開 agent',
    '開 Git 面板', '開 AI 記錄', '開檔案樹', '快速開啟檔案']
  const commands = [...Array.from({ length: 75 }, (_, index) => ({ label: `專案 ${index}` })),
    ...names.map((label) => ({ label }))]
  for (const name of names) assert.equal(api.rankCommands(name, commands)[0].label, name)
  assert.equal(api.rankCommands('專案 74', commands)[0].label, '專案 74')
  assert.equal(api.rankCommands('', commands).length, commands.length)
})

test('Ctrl+Shift+P 只在工作區開啟，IME 與其他按鍵原樣放行', async () => {
  const h = harness([{ label: '開 Git 面板', run() {} }])
  const shortcut = { ctrlKey: true, shiftKey: true }
  for (const extras of [{ isComposing: true }, { keyCode: 229 }, { altKey: true },
    { metaKey: true }, { ctrlKey: false }, { shiftKey: false }]) {
    const event = key('P', { ...shortcut, ...extras })
    await h.document.fire('keydown', event)
    assert.equal(event.prevented, false)
    assert.equal(h.host(), undefined)
  }
  h.setActive(false)
  const outside = key('P', shortcut)
  await h.document.fire('keydown', outside)
  assert.equal(outside.prevented, false)
  await h.panel.open()
  assert.equal(h.host(), undefined)
  h.setActive(true)
  const event = key('P', shortcut)
  await h.document.fire('keydown', event)
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  assert.equal(h.host().hidden, false)
  assert.equal(h.document.activeElement, h.input())
  await h.document.fire('keydown', key('p', shortcut))
  assert.equal(h.host().hidden, true)
  assert.equal(h.document.activeElement, h.previous)
})

test('上下鍵選取有界線，Enter 執行目前項目並還原焦點', async () => {
  const ran = []
  const h = harness(['Alpha', 'Beta'].map((label) => ({ label, run: () => ran.push(label) })))
  await h.panel.open()
  assert.equal(h.input().getAttribute('aria-expanded'), 'true')
  assert.equal(h.input().getAttribute('aria-activedescendant'), 'ws-command-0')
  await h.host().fire('keydown', key('ArrowUp'))
  assert.equal(h.input().getAttribute('aria-activedescendant'), 'ws-command-0')
  await h.host().fire('keydown', key('ArrowDown'))
  await h.host().fire('keydown', key('ArrowDown'))
  assert.equal(h.input().getAttribute('aria-activedescendant'), 'ws-command-1')
  assert.equal(h.list().children[1].getAttribute('aria-selected'), 'true')
  await h.host().fire('keydown', key('Enter'))
  assert.deepEqual(ran, ['Beta'])
  assert.equal(h.host().hidden, true)
  assert.equal(h.document.activeElement, h.previous)
  assert.equal(h.input().getAttribute('aria-expanded'), 'false')
})

test('輸入會重新過濾與選第一筆，空結果不能執行', async () => {
  let runs = 0
  const h = harness(['Alpha', 'Beta'].map((label) => ({ label, run: () => { runs += 1 } })))
  await h.panel.open()
  await h.host().fire('keydown', key('ArrowDown'))
  h.input().value = 'Alpha'
  await h.input().fire('input')
  assert.equal(h.list().children.length, 1)
  assert.equal(h.list().children[0].textContent, 'Alpha')
  assert.equal(h.input().getAttribute('aria-activedescendant'), 'ws-command-0')
  h.input().value = '找不到'
  await h.input().fire('input')
  assert.equal(h.list().children[0].textContent, '沒有符合的指令')
  assert.equal(h.input().getAttribute('aria-activedescendant'), undefined)
  await h.host().fire('keydown', key('ArrowDown'))
  await h.host().fire('keydown', key('Enter'))
  assert.equal(runs, 0)
  assert.equal(h.host().hidden, false)
})

test('Tab 留在輸入框，Esc 關閉還原焦點', async () => {
  const h = harness([{ label: 'Alpha', run() {} }])
  await h.panel.open()
  for (const shiftKey of [false, true]) {
    h.list().children[0].focus()
    const tab = key('Tab', { shiftKey })
    await h.host().fire('keydown', tab)
    assert.equal(tab.prevented, true)
    assert.equal(h.document.activeElement, h.input())
  }
  await h.host().fire('keydown', key('Escape'))
  assert.equal(h.host().hidden, true)
  assert.equal(h.document.activeElement, h.previous)
})

test('組字中的 Enter／Esc／方向鍵與 slash 不被攔截', async () => {
  let runs = 0
  const h = harness([{ label: 'Alpha', run: () => { runs += 1 } }])
  await h.panel.open()
  for (const keyName of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Tab']) {
    for (const extras of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = key(keyName, extras)
      await h.host().fire('keydown', event)
      assert.equal(event.prevented, false)
    }
  }
  for (const target of [h.document, h.host()]) {
    const slash = key('/')
    await target.fire('keydown', slash)
    assert.equal(slash.prevented, false)
    assert.equal(slash.stopped, false)
  }
  assert.equal(runs, 0)
  assert.equal(h.host().hidden, false)
})

test('滑鼠選取會執行，點背景關閉；重新開啟重讀最新指令', async () => {
  let runs = 0
  const h = harness([{ label: 'Alpha', run: () => { runs += 1 } }])
  await h.panel.open()
  const down = key('')
  await h.list().children[0].fire('mousedown', down)
  assert.equal(down.prevented, true)
  await h.list().children[0].fire('click')
  assert.equal(runs, 1)
  h.setCommands([{ label: 'Beta', run() {} }])
  await h.panel.open()
  assert.equal(h.list().children[0].textContent, 'Beta')
  await h.host().fire('mousedown', { target: h.input() })
  assert.equal(h.host().hidden, false)
  await h.host().fire('mousedown', { target: h.host() })
  assert.equal(h.host().hidden, true)
})

test('讀取與執行失敗只顯示固定訊息，不顯示原始錯誤', async () => {
  const h = harness()
  h.setCommands(() => { throw new Error('secret source path') })
  await h.panel.open()
  assert.deepEqual(h.toasts, [['讀不到工作區指令，請稍後再試', 'error']])
  h.setCommands([{ label: '失敗', run: async () => { throw new Error('secret stderr') } }])
  await h.panel.open()
  await h.list().children[0].fire('click')
  assert.deepEqual(h.toasts[1], ['指令執行失敗，請稍後再試', 'error'])
  assert.equal(h.host().hidden, true)
})

function commandOptions(calls) {
  const project = { id: 'p1', name: 'Alpha' }
  return { projects: [project, { id: 'p2', name: 'Beta' }], project,
    sessions: [{ id: 't1', title: 'Claude', projectId: 'p1', state: 'running' },
      { id: 't2', title: '已停止 Codex', projectId: 'p1', state: 'stopped' },
      { id: 't3', title: '其他專案', projectId: 'p2' }],
    presets: [{ key: 'shell', label: '純 shell' }, { key: 'claude', label: 'Claude Code' },
      { key: 'codex', label: 'Codex' }, { key: 'grok', label: 'Grok' },
      { key: 'opencode', label: 'OpenCode' }, { key: 'agy', label: 'Antigravity' }],
    selectProject: (id) => calls.push(['project', id]),
    focusSession: (session) => calls.push(['terminal', session]),
    newAgent: (preset) => calls.push(['new', preset]),
    addWorktree: () => calls.push(['worktree']),
    setPanel: (name) => calls.push(['panel', name]),
    setFilesView: (name) => calls.push(['files-view', name]),
    quickOpen: (item) => calls.push(['quick', item]) }
}

function terminalKeyHandler() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/terminal-page.js'), 'utf8')
  const start = source.indexOf('  term.attachCustomKeyEventHandler(')
  const end = source.indexOf('\n  })', start)
  assert.ok(start !== -1 && end > start, '找到真實 xterm 按鍵處理函式')
  let handler
  vm.runInNewContext(source.slice(start, end) + '\n  })', {
    term: { attachCustomKeyEventHandler: (callback) => { handler = callback }, hasSelection: () => false },
    scrollAiViewport: () => false, items: [{ id: 'test-terminal', preset: 'codex' }],
    id: 'test-terminal', cliMouse: () => false, handleCopyKey: () => false,
    nativeMouse: false, findOpen: () => false
  })
  return handler
}

test('真實 xterm 處理器將 Ctrl+Shift+P 交給工作區，IME 與 slash 留給 CLI', () => {
  const handler = terminalKeyHandler()
  for (const type of ['keydown', 'keyup']) {
    const shortcut = key('P', { ctrlKey: true, shiftKey: true, type })
    assert.equal(handler(shortcut), false)
    assert.equal(shortcut.prevented, false, '工作區仍需收到原始按鍵事件')
    assert.equal(shortcut.stopped, false)
    for (const extras of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(handler(key('p', { ctrlKey: true, shiftKey: true, type, ...extras })), true)
    }
    assert.equal(handler(key('/', { type })), true)
    assert.equal(handler(key('p', { ctrlKey: true, type })), true)
  }
})

test('指令項目呼叫既有操作，含停止的目前專案終端機與全部 preset', async () => {
  const { api } = harness()
  const calls = []
  const options = commandOptions(calls)
  const commands = api.workspaceCommandItems(options)
  assert.equal(new Set(commands.map((command) => command.id)).size, commands.length)
  assert.equal(commands.find((command) => command.id === 'terminal:t3'), undefined)
  for (const command of commands) {
    assert.equal(api.rankCommands(command.label, commands)[0].id, command.id)
    await command.run()
  }
  assert.deepEqual(calls, [['project', 'p1'], ['project', 'p2'],
    ['terminal', options.sessions[0]], ['terminal', options.sessions[1]],
    ...options.presets.map((preset) => ['new', preset.key]), ['worktree'],
    ['panel', 'git'], ['panel', 'agents'], ['files-view', 'tree'], ['panel', 'files'], ['quick', options.project]])
})

test('沒選專案時只提供切換專案', () => {
  const { api } = harness()
  const calls = []
  const commands = api.workspaceCommandItems({ ...commandOptions(calls), project: null })
  assert.deepEqual(Array.from(commands, (command) => command.id), ['project:p1', 'project:p2'])
  commands[1].run()
  assert.deepEqual(calls, [['project', 'p2']])
})

test('非同步目錄回覆後關閉／切頁不會重開，舊請求不能蓋新項目', async () => {
  const h = harness()
  let resolve
  h.setCommands(() => new Promise((done) => { resolve = done }))
  const first = h.panel.open()
  h.panel.close()
  resolve([{ label: '舊項目', run() {} }])
  await first
  assert.equal(h.host(), undefined)
  const switched = h.panel.open()
  h.setActive(false)
  resolve([])
  await switched
  assert.equal(h.host(), undefined)
  h.setActive(true)
  const stale = h.panel.open()
  const finishStale = resolve
  h.setCommands([{ label: '最新項目', run() {} }])
  await h.panel.open()
  finishStale([{ label: '過期項目', run() {} }])
  await stale
  assert.equal(h.list().children[0].textContent, '最新項目')
})

async function main() {
  let passed = 0
  for (const { label, run } of tests) {
    await run()
    passed += 1
    console.log(`PASS ${label}`)
  }
  console.log(`\n${passed} passed, 0 failed`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
