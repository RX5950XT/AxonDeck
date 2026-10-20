'use strict'

// 用法：node scripts/test-workspace-terminal-operations.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function harness(hooks = {}) {
  const calls = []
  const toasts = []
  const listeners = new Set()
  let unsubscribed = 0
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-tabs.js'), 'utf8')
    .replace(/^import [\s\S]*?from '[^']*'$/gm, '')
    .replace(/^export /gm, '').replaceAll('import.meta.url', "'file:///test.js'")
    .replaceAll("import('./terminal-page.js')", 'loadTerminal()')
  function record(name, fallback) {
    return async (...args) => {
      calls.push({ name, args })
      return hooks[name] ? hooks[name](...args) : fallback
    }
  }
  const context = vm.createContext({
    console, URL, showToast: (...args) => toasts.push(args),
    electronAPI: {
      terminal: { onStatus: (handler) => {
        listeners.add(handler)
        return () => { listeners.delete(handler); unsubscribed += 1 }
      }, create: record('create', { ok: true, data: { id: 'new-terminal' } }),
        write: record('write', { ok: true, data: true }) },
      workspace: { worktreeSetupCommand: record('setup', { ok: true, data: 'setup-command' }),
        scriptCommand: record('script', { ok: true, data: 'script-command' }) }
    },
    loadTerminal: async () => ({ openTerminalSession: record('open', undefined) })
  })
  const flow = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/ws-worktree-flow.js'), 'utf8')
    .replace(/^import .* from '[^']*'$/gm, '').replace(/^export /gm, '')
  const flowContext = vm.createContext({ showToast: (...args) => toasts.push(args) })
  vm.runInContext(`${flow}\nthis.watch = watchWorktreeSetup`, flowContext)
  context.watchWorktreeSetup = flowContext.watch
  vm.runInContext(`${source}\nthis.api = { runInTerminal, newPresetTerminal,
    setProject: (next) => { project = next; projectSwitch += 1 } }`, context)
  const project = { id: 'worktree-project', path: 'D:\\worktrees\\new-worktree', name: '新 worktree' }
  context.api.setProject(project)
  return { api: context.api, project, calls, toasts, hooks, listeners,
    unsubscribed: () => unsubscribed,
    status: (event) => { for (const handler of listeners) handler(event) },
    runSetup: () => context.api.runInTerminal('scripts/setup.ps1', { setupProjectId: project.id }) }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const tests = []
function test(label, run) { tests.push({ label, run }) }
const steps = (h) => h.calls.map((call) => call.name)

function assertOpenArgs(args, id) {
  assert.equal(args[0], id)
  assert.equal(typeof args[1], 'function')
  assert.equal(args[1](), true)
}

test('初始化建立新專案 PowerShell 終端機，在同一個 id 執行 main 準備的命令', async () => {
  const h = harness()
  assert.equal(await h.runSetup(), 'new-terminal')
  assert.deepEqual(steps(h), ['create', 'open', 'setup', 'write'])
  assert.deepEqual({ ...h.calls[0].args[0] }, {
    shell: 'powershell', preset: 'shell', cwd: h.project.path,
    projectId: h.project.id, title: '執行 setup.ps1'
  })
  assertOpenArgs(h.calls[1].args, 'new-terminal')
  assert.deepEqual(h.calls[2].args, [h.project.id, 'new-terminal'])
  assert.deepEqual(h.calls[3].args, ['new-terminal', 'setup-command\r'])
  assert.equal(h.toasts.length, 0)
})

test('建立終端機失敗就停止，不準備或寫入命令', async () => {
  const h = harness({ create: () => ({ ok: false }) })
  assert.equal(await h.runSetup(), undefined)
  assert.deepEqual(steps(h), ['create'])
  assert.deepEqual(h.toasts, [['建立終端機失敗', 'error']])
})

test('初始化命令準備失敗保留已開的終端機，不送出文字', async () => {
  const h = harness({ setup: () => ({ ok: false }) })
  assert.equal(await h.runSetup(), undefined)
  assert.deepEqual(steps(h), ['create', 'open', 'setup'])
  assert.deepEqual(h.toasts, [['準備初始化腳本失敗', 'error']])
})

test('初始化命令準備拋錯不會寫入或洩漏錯誤', async () => {
  const h = harness({ setup: () => { throw new Error('secret stderr') } })
  assert.equal(await h.runSetup(), undefined)
  assert.deepEqual(steps(h), ['create', 'open', 'setup'])
  assert.equal(h.toasts.length, 0)
})

test('terminal.write 回報失敗、未寫入或沒有回覆都不回成功 id', async () => {
  for (const response of [{ ok: false }, { ok: true, data: false }, undefined]) {
    const h = harness({ write: () => response })
    assert.equal(await h.runSetup(), undefined)
    assert.deepEqual(steps(h), ['create', 'open', 'setup', 'write'])
    assert.equal(h.listeners.size, 0)
    assert.equal(h.unsubscribed(), 1)
  }
})

test('terminal.write 拋錯不回成功 id', async () => {
  const h = harness({ write: () => { throw new Error('write failed') } })
  assert.equal(await h.runSetup(), undefined)
  assert.deepEqual(steps(h), ['create', 'open', 'setup', 'write'])
  assert.equal(h.listeners.size, 0)
  assert.equal(h.unsubscribed(), 1)
})

test('等待 terminal.write 確認成功才回終端機 id', async () => {
  const entered = deferred()
  const finish = deferred()
  const h = harness({ write: () => { entered.resolve(); return finish.promise } })
  let settled = false
  const running = h.runSetup().then((id) => { settled = true; return id })
  await entered.promise
  assert.equal(settled, false)
  assert.equal(h.listeners.size, 1, '寫入前就要監看狀態，以免漏掉很快結束的腳本')
  finish.resolve({ ok: true, data: true })
  assert.equal(await running, 'new-terminal')
})

test('初始化所屬專案與目前專案不同時，不建立終端機', async () => {
  const h = harness()
  const result = await h.api.runInTerminal('setup.ps1', { setupProjectId: 'another-project' })
  assert.equal(result, undefined)
  assert.equal(h.calls.length, 0)
})

test('建立終端機、開分頁或準備命令期間切專案，都不送出初始化命令', async () => {
  for (const stage of ['create', 'open', 'setup']) {
    const entered = deferred()
    const finish = deferred()
    const h = harness({ [stage]: () => { entered.resolve(); return finish.promise } })
    const running = h.runSetup()
    await entered.promise
    h.api.setProject({ id: 'other-project', path: 'D:\\other-project' })
    const result = stage === 'create' ? { ok: true, data: { id: 'new-terminal' } }
      : stage === 'setup' ? { ok: true, data: 'setup-command' } : undefined
    finish.resolve(result)
    assert.equal(await running, undefined, stage)
    assert.equal(h.calls.some((call) => call.name === 'write'), false, stage)
    assert.equal(h.calls[0].args[0].cwd, h.project.path)
    assert.equal(h.calls[0].args[0].projectId, h.project.id)
    const setup = h.calls.find((call) => call.name === 'setup')
    if (setup) assert.deepEqual(setup.args, [h.project.id, 'new-terminal'])
  }
})

test('空路徑或帶換行的路徑不建立初始化終端機', async () => {
  const h = harness()
  for (const rel of ['', 'setup.ps1\nwhoami', 'setup.ps1\rwhoami']) {
    assert.equal(await h.api.runInTerminal(rel, { setupProjectId: h.project.id }), undefined)
  }
  assert.equal(h.calls.length, 0)
})

test('各 preset 沿用既有 newTerminal，以目前專案路徑建立並回同一 id', async () => {
  for (const preset of ['shell', 'claude', 'codex', 'grok', 'opencode', 'agy']) {
    const h = harness()
    assert.equal(await h.api.newPresetTerminal(preset), 'new-terminal')
    assert.deepEqual(steps(h), ['create', 'open'])
    assert.deepEqual({ ...h.calls[0].args[0] }, {
      preset, cwd: h.project.path, projectId: h.project.id, admin: false
    })
    assertOpenArgs(h.calls[1].args, 'new-terminal')
  }
})

test('preset 建立失敗不開分頁；無專案沿用空 cwd 與 projectId', async () => {
  const h = harness({ create: () => ({ ok: false }) })
  assert.equal(await h.api.newPresetTerminal('codex'), undefined)
  assert.deepEqual(steps(h), ['create'])
  h.hooks.create = () => ({ ok: true, data: { id: 'unclassified' } })
  h.api.setProject(null)
  assert.equal(await h.api.newPresetTerminal('shell'), 'unclassified')
  assert.deepEqual({ ...h.calls[1].args[0] }, {
    preset: 'shell', cwd: '', projectId: '', admin: false
  })
  assertOpenArgs(h.calls[2].args, 'unclassified')
})

test('agent 建立或開分頁等待時切專案，不開錯分頁、不回成功 id', async () => {
  for (const stage of ['create', 'open']) {
    const entered = deferred()
    const finish = deferred()
    const h = harness({ [stage]: () => { entered.resolve(); return finish.promise } })
    const running = h.api.newPresetTerminal('codex')
    await entered.promise
    const opened = h.calls.find((call) => call.name === 'open')
    if (opened) assertOpenArgs(opened.args, 'new-terminal')
    h.api.setProject({ id: 'other-project', path: 'D:\\other-project' })
    if (opened) assert.equal(opened.args[1](), false, '傳給終端機的守衛會阻止搶焦點')
    finish.resolve(stage === 'create' ? { ok: true, data: { id: 'new-terminal' } } : undefined)
    assert.equal(await running, undefined)
    assert.deepEqual(steps(h), stage === 'create' ? ['create'] : ['create', 'open'])
  }
})

test('初始化初始 idle 不提早解除，忽略其他終端機與缺少結束碼的 idle', async () => {
  const h = harness()
  await h.runSetup()
  h.status({ id: 'new-terminal', state: 'idle', exitCode: 0 })
  h.status({ id: 'another-terminal', state: 'running' })
  h.status({ id: 'another-terminal', state: 'idle', exitCode: 1 })
  h.status({ id: 'another-terminal', state: 'exited', exitCode: 1 })
  assert.equal(h.listeners.size, 1)
  assert.equal(h.toasts.length, 0)
  h.status({ id: 'new-terminal', state: 'running' })
  h.status({ id: 'new-terminal', state: 'idle', exitCode: null })
  h.status({ id: 'new-terminal', state: 'idle' })
  assert.equal(h.listeners.size, 1)
  assert.equal(h.unsubscribed(), 0)
})

test('初始化非零結束碼只顯示固定失敗訊息，解除監看並忽略後續狀態', async () => {
  const h = harness()
  await h.runSetup()
  h.status({ id: 'new-terminal', state: 'running' })
  h.status({ id: 'new-terminal', state: 'idle', exitCode: 7, error: 'secret stderr' })
  assert.equal(h.listeners.size, 0)
  assert.equal(h.unsubscribed(), 1)
  assert.deepEqual(h.toasts, [['初始化腳本執行失敗或終端機已關閉；工作樹已保留', 'error']])
  h.status({ id: 'new-terminal', state: 'exited', exitCode: 7 })
  assert.equal(h.toasts.length, 1)
})

test('初始化結束碼 0 解除監看，不顯示失敗訊息；關閉終端機則顯示固定錯誤', async () => {
  const h = harness()
  await h.runSetup()
  h.status({ id: 'new-terminal', state: 'running' })
  h.status({ id: 'new-terminal', state: 'idle', exitCode: 0 })
  assert.equal(h.listeners.size, 0)
  assert.equal(h.unsubscribed(), 1)
  assert.equal(h.toasts.length, 0)
  await h.runSetup()
  h.status({ id: 'new-terminal', state: 'exited', exitCode: 0 })
  assert.equal(h.listeners.size, 0)
  assert.deepEqual(h.toasts, [['初始化腳本執行失敗或終端機已關閉；工作樹已保留', 'error']])
})

async function main() {
  let passed = 0
  for (const { label, run } of tests) {
    await run()
    console.log(`PASS ${label}`)
    passed += 1
  }
  console.log(`\n${passed} passed, 0 failed`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
