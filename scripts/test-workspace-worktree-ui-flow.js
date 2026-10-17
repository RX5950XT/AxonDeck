'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-worktree-flow.js'), 'utf8')
  .replace(/^import .* from '[^']+'\r?$/gm, '').replace(/^export /gm, '')
const noop = () => {}
const context = vm.createContext({ console, showToast: noop, askInput: noop, initCustomSelects: noop, showMenu: noop })
vm.runInContext(`${source}\nthis.api = { defaultWorktreeName, createWorktreeFlow, askWorktree }`, context)
const { defaultWorktreeName, createWorktreeFlow, askWorktree } = context.api
let passed = 0

function harness(overrides = {}) {
  const source = { id: 'source', path: 'D:\\repo', setupScript: 'scripts/setup.ps1' }
  const target = { id: 'target', path: 'D:\\repo-wt', setupScript: 'scripts/setup.ps1' }
  let current = source
  const calls = []
  const messages = []
  const ok = (data) => ({ ok: true, data })
  const options = {
    api: {
      worktreeList: async () => ok({ trees: [{ current: true, branch: 'master' }] }),
      worktreeAdd: async (...args) => { calls.push(['add', ...args]); return ok({ projectId: 'target', branch: 'wt-test' }) },
      setSetupScript: async (...args) => { calls.push(['setting', ...args]); return ok(source) },
      worktreeAdopt: async (...args) => { calls.push(['adopt', ...args]); return ok({ projectId: 'target' }) }
    },
    currentProject: () => current,
    getPresets: async () => [{ key: 'codex', label: 'Codex' }],
    choose: async (data) => { calls.push(['form', data]); return { name: 'wt-test', base: 'master', preset: 'codex', setup: true } },
    reloadList: async () => { calls.push(['reload']) },
    selectProject: async (id) => { calls.push(['select', id]); current = target; return true },
    runSetup: async (rel, req) => { calls.push(['setup', rel, req.setupProjectId]); return 't_setup' },
    newAgent: async (preset) => { calls.push(['agent', preset]); return 't_agent' },
    notify: (...args) => messages.push(args), input: async () => 'scripts/setup.ps1', ...overrides
  }
  return { flow: createWorktreeFlow(options), calls, messages, options, source,
    switchTo: (project) => { current = project } }
}

async function check(name, fn) {
  await fn()
  passed++
  console.log(`PASS ${name}`)
}

async function main() {
  await check('預設名稱用本機日期時間並補零', () => {
    assert.equal(defaultWorktreeName(new Date(2026, 9, 17, 3, 42)), 'wt-1017-0342')
    assert.equal(defaultWorktreeName(new Date(2026, 0, 2, 0, 7)), 'wt-0102-0007')
  })
  await check('單次表單包含目前分支與preset，依序切換、初始化、另開agent', async () => {
    const h = harness()
    await h.flow.add()
    assert.equal(h.calls[0][1].branch, 'master')
    assert.equal(h.calls[0][1].presets[0].key, 'codex')
    assert.deepEqual(h.calls.slice(1), [
      ['add', 'source', 'wt-test', 'master'], ['reload'], ['select', 'target'],
      ['setup', 'scripts/setup.ps1', 'target'], ['agent', 'codex']
    ])
  })
  await check('取消不建工作樹', async () => {
    const h = harness({ choose: async () => null })
    await h.flow.add()
    assert.equal(h.calls.length, 0)
  })
  await check('不開agent且不初始化時只建立切換', async () => {
    const h = harness({ choose: async () => ({ name: 'wt-test', base: 'master', preset: '', setup: false }) })
    await h.flow.add()
    assert.deepEqual(h.calls.map((row) => row[0]), ['add', 'reload', 'select'])
  })
  await check('建立失敗只提示固定訊息', async () => {
    const h = harness()
    h.options.api.worktreeAdd = async () => { throw new Error('secret stderr') }
    await h.flow.add()
    assert.equal(h.messages[0][0], '建立 worktree 失敗')
    assert.equal(h.calls.some((row) => row[0] === 'setup'), false)
  })
  await check('初始化、agent或切換失敗保留worktree並指出失敗階段', async () => {
    for (const [key, text] of [['runSetup', '啟動初始化腳本'], ['newAgent', '開啟 agent 終端機'], ['selectProject', '切換到新專案']]) {
      const h = harness({ [key]: async () => false })
      await h.flow.add()
      assert.ok(h.messages[0][0].includes(text))
      assert.ok(h.messages[0][0].includes('工作樹已保留'))
      assert.equal(h.calls.filter((row) => row[0] === 'add').length, 1)
    }
  })
  await check('加入清單失敗保留worktree，不開任何終端機', async () => {
    const h = harness()
    h.options.api.worktreeAdd = async () => ({ ok: true, data: { projectId: '' } })
    await h.flow.add()
    assert.ok(h.messages[0][0].includes('加入專案清單失敗'))
    assert.deepEqual(h.calls.map((row) => row[0]), ['form', 'reload'])
  })
  await check('表單開著切換專案後不建立', async () => {
    const h = harness({ choose: async () => { h.switchTo({ id: 'elsewhere' }); return { name: 'wt-test' } } })
    await h.flow.add()
    assert.equal(h.calls.length, 0)
  })
  await check('建立途中切換專案不再切回或開agent', async () => {
    const h = harness()
    h.options.api.worktreeAdd = async () => { h.switchTo({ id: 'elsewhere' }); return { ok: true, data: { projectId: 'target' } } }
    await h.flow.add()
    assert.ok(h.messages[0][0].includes('專案已切換'))
    assert.equal(h.calls.some((row) => row[0] === 'select'), false)
  })
  await check('設定可清除，取消不寫入', async () => {
    const h = harness({ input: async () => '' })
    await h.flow.configureSetup(h.source)
    assert.deepEqual(h.calls[0], ['setting', 'source', ''])
    const cancelled = harness({ input: async () => null })
    await cancelled.flow.configureSetup(cancelled.source)
    assert.equal(cancelled.calls.length, 0)
  })
  await check('重新執行先加入未登錄worktree再切換並在該專案啟動', async () => {
    const h = harness()
    await h.flow.rerunSetup(h.source, { path: 'D:\\repo-wt' })
    assert.deepEqual(h.calls, [['adopt', 'source', 'D:\\repo-wt'], ['reload'], ['select', 'target'], ['setup', 'scripts/setup.ps1', 'target']])
  })
  await testDialog()
  await testRemoveGuard()
  console.log(`\n${passed} passed, 0 failed`)
}

async function testRemoveGuard() {
  const page = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/workspace-page.js'), 'utf8')
    .replace(/^import [\s\S]*?from '[^']*'$/gm, '').replace(/^export /gm, '')
  let state = { removable: false, runningTerminals: [{ id: 't', title: 'Claude task', preset: 'claude' }] }
  const calls = []
  const alerts = []
  const confirmations = []
  let accept = false
  const scope = vm.createContext({
    console, createListReorder: () => ({}), createProjectFolders: () => ({ load: async () => {} }), showToast: noop,
    showAlert: async (...args) => alerts.push(args),
    askConfirm: async (...args) => { confirmations.push(args); return accept },
    electronAPI: { workspace: {
      worktreeCheck: async () => { calls.push('check'); return { ok: true, data: state } },
      worktreeRemove: async () => { calls.push('remove'); return { ok: true } },
      listProjects: async () => ({ ok: true, data: [] })
    } }
  })
  vm.runInContext(`${page}\nthis.remove = removeWorktree`, scope)
  const remove = () => scope.remove({ id: 'p' }, { path: 'D:\\repo-wt', branch: 'wt-test' })
  await check('移除確認前列出使用中的終端機，不開確認框也不結束程序', async () => {
    await remove()
    assert.ok(alerts[0][1].desc.includes('Claude task（claude）'))
    assert.equal(confirmations.length, 0)
    assert.deepEqual(calls, ['check'])
  })
  await check('移除確認列未推提交並明說保留分支，取消不移除', async () => {
    state = { removable: true, unpushed: 4 }
    await remove()
    assert.ok(confirmations[0][1].desc.includes('4 個提交沒推上遠端'))
    assert.ok(confirmations[0][1].desc.includes('分支與提交仍會保留'))
    assert.equal(calls.includes('remove'), false)
  })
  await check('未知提交數不顯示推送數字，確認後才呼叫移除', async () => {
    state = { removable: true, unpushed: null }
    accept = true
    await remove()
    assert.equal(confirmations[1][1].desc.includes('沒推上遠端'), false)
    assert.equal(calls.at(-1), 'remove')
  })
}

async function testDialog() {
  class Node {
    constructor(tagName) { this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = {}; this.value = ''; this.checked = false }
    append(...nodes) { this.children.push(...nodes) }
    appendChild(node) { this.children.push(node); return node }
    setAttribute() {}
    addEventListener(type, fn) { this.listeners[type] = fn }
    close(value) { this.returnValue = value; this.listeners.close() }
    remove() { this.removed = true }
    showModal() { this.open = true }
    focus() {}
    select() {}
  }
  const body = new Node('body')
  context.document = { body, createElement: (tag) => new Node(tag) }
  const nodes = (root) => [root, ...root.children.flatMap(nodes)]
  await check('同一dialog具備三欄與可選初始化，IMＥ Enter不送出', async () => {
    const done = askWorktree({ branch: 'master', presets: [{ key: 'shell', label: '純 shell' }], setupScript: 'setup.ps1' })
    const dialog = body.children.at(-1)
    assert.equal(dialog.open, true)
    const fields = nodes(dialog).filter((node) => node.tagName === 'INPUT' || node.tagName === 'SELECT')
    assert.equal(fields.length, 4)
    assert.equal(fields[0].value, 'master')
    assert.equal(fields[3].checked, true)
    const form = dialog.children[0]
    let prevented = false
    form.listeners.keydown({ key: 'Enter', keyCode: 229, preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    fields[1].value = 'custom-name'
    form.listeners.submit({ preventDefault() {} })
    const result = await done
    assert.equal(result.name, 'custom-name')
    assert.equal(dialog.removed, true)
  })
  await check('沒有設定不出現初始化勾選，Esc取消不回資料', async () => {
    const done = askWorktree({ branch: 'master', presets: [], setupScript: '' })
    const dialog = body.children.at(-1)
    assert.equal(nodes(dialog).filter((node) => node.type === 'checkbox').length, 0)
    dialog.close('')
    assert.equal(await done, null)
  })
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
