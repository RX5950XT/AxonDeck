#!/usr/bin/env node
'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const { tempDir } = require('./lib/test-temp')
const files = require('../src/main/workspace/files')
const store = require('../src/main/workspace/store')

let passed = 0
async function test(name, run) {
  await run()
  passed += 1
  console.log(`  PASS ${name}`)
}

function harness(root, overrides = {}) {
  const source = { id: 'source', path: root, setupScript: 'setup.ps1' }
  const target = { id: 'target', path: root + '-wt', setupScript: 'setup.ps1',
    worktreeSourceDir: root, worktreeBase: 'a'.repeat(40) }
  const calls = []
  const state = { projects: [source, target], running: [], terminal: {
    id: 'term', projectId: target.id, cwd: target.path, preset: 'shell', shell: 'powershell'
  }, ...overrides }
  const spawn = (exe, args, options) => {
    assert.equal(exe, 'git')
    assert.equal(options.shell, false)
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
    calls.push({ args, cwd: options.cwd })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr = new EventEmitter()
    child.kill = () => {}
    process.nextTick(() => {
      const result = state.git ? state.git(args, options.cwd) : gitResult(args, source, target)
      child.stdout.emit('data', result.stdout || '')
      child.stderr.emit('data', 'secret stderr must never escape')
      child.emit('close', result.code || 0)
    })
    return child
  }
  const fakeStore = { ...store, get: async id => state.projects.find(item => item.id === id),
    list: async () => state.projects,
    setSetupScript: async (id, setupScript) => ({ id, setupScript }),
    create: async req => {
      state.createdProject = req
      if (state.storeError) throw new Error('store failed')
      return { ...req, id: 'created' }
    }, remove: async () => true }
  const dependencies = { path, child_process: { spawn }, './store': fakeStore, './files': files,
    '../raw-fs': fs, '../terminal/service': { listRunningUnder: async () => (
      typeof state.running === 'function' ? state.running() : state.running) },
    '../terminal/store': { get: async () => state.terminal },
    '../script-launch': { terminalCommand: async (...args) => {
      state.commandArgs = args
      if (state.commandError) throw new Error('secret stderr must never escape')
      return '& powershell -EncodedCommand encoded'
    }, psQuote: require('../src/main/script-launch').psQuote } }
  const context = { module: { exports: {} }, require: name => {
    assert.ok(name in dependencies, `未預期的依賴：${name}`)
    return dependencies[name]
  }, process, setTimeout, clearTimeout }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/workspace/worktree.js'), 'utf8'), context)
  return { api: context.module.exports, state, calls, source, target }
}

function gitResult(args, source, target) {
  if (args[0] === 'worktree' && args[1] === 'list') return { stdout:
    `worktree ${source.path}\nbranch refs/heads/main\n\nworktree ${target.path}\nbranch refs/heads/wt\n\n` }
  if (args[0] === 'rev-parse') return args.includes('@{u}') ? { code: 1 } : { stdout: 'a'.repeat(40) }
  if (args[0] === 'merge-base') return { stdout: 'a'.repeat(40) }
  if (args[0] === 'rev-list') return { stdout: '3\n' }
  if (args[0] === 'branch') return { stdout: 'wt\n' }
  return { stdout: '' }
}

async function scripts(root) {
  const { api, state, target, source } = harness(root)
  fs.mkdirSync(target.path)
  fs.writeFileSync(path.join(root, 'setup.ps1'), 'Write-Output ready')
  fs.writeFileSync(path.join(target.path, 'setup.ps1'), 'Write-Output ready')
  await test('只接受專案相對的 PowerShell／batch 腳本', async () => {
    for (const invalid of ['../setup.ps1', 'a/../../setup.cmd', 'C:\\setup.ps1', 'C:setup.ps1', 'D:setup.cmd', '/setup.ps1', 'setup.js', 'a.ps1\n']) {
      assert.equal(store.normalizeSetupScript(invalid), '')
      await assert.rejects(api.setSetupScript(source.id, invalid), { code: 'BAD_SCRIPT' })
    }
    for (const valid of ['setup.ps1', 'scripts/setup.CMD', 'scripts\\setup.bat']) {
      assert.equal(store.normalizeSetupScript(valid), valid.replace(/\\/g, '/'))
    }
    assert.equal((await api.setSetupScript(source.id, 'setup.ps1')).setupScript, 'setup.ps1')
    assert.equal((await api.setSetupScript(source.id, '')).setupScript, '')
    await assert.rejects(api.setSetupScript(source.id, 'missing.ps1'), { code: 'BAD_SCRIPT' })
  })
  await test('真 junction 逃逸在設定與執行前都擋下', async () => {
    const outside = tempDir('setup-outside-')
    fs.writeFileSync(path.join(outside, 'setup.ps1'), 'outside')
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
    fs.symlinkSync(outside, path.join(target.path, 'escape'), 'junction')
    await assert.rejects(api.setSetupScript(source.id, 'escape/setup.ps1'), { code: 'BAD_PATH' })
    target.setupScript = 'escape/setup.ps1'
    await assert.rejects(api.setupCommand(target.id, 'term'), { code: 'BAD_PATH' })
    target.setupScript = 'setup.ps1'
  })
  await test('初始化沿用 terminalCommand 並帶三個環境變數', async () => {
    source.path += "'quoted"
    target.worktreeSourceDir = source.path
    const command = await api.setupCommand(target.id, 'term')
    assert.deepEqual(state.commandArgs, [path.join(target.path, 'setup.ps1'), target.id, 'term'])
    assert.ok(command.includes(`$env:AXONDECK_SOURCE_DIR='${source.path.replace(/'/g, "''")}'`))
    assert.ok(command.includes(`$env:AXONDECK_WORKTREE_DIR='${target.path}'`))
    assert.ok(command.includes("$env:AXONDECK_BRANCH='wt'"))
    assert.ok(command.endsWith('& powershell -EncodedCommand encoded'))
  })
  await test('初始化拒絕其他專案或其他 cwd 的終端機', async () => {
    state.terminal.projectId = source.id
    await assert.rejects(api.setupCommand(target.id, 'term'), { code: 'FORBIDDEN' })
    state.terminal.projectId = target.id
    state.terminal.cwd += '-other'
    await assert.rejects(api.setupCommand(target.id, 'term'), { code: 'FORBIDDEN' })
    state.terminal.cwd = target.path
  })
  await test('準備失敗只回固定文字，不帶下游錯誤', async () => {
    state.commandError = true
    await assert.rejects(api.setupCommand(target.id, 'term'), error => (
      error.code === 'SETUP_FAILED' && !error.userMessage.includes('secret') && error.userMessage.includes('保留')))
  })
}

async function counts(root) {
  await test('專案重讀拒絕來源路徑裡的 NUL 與換行', async () => {
    for (const control of ['\0', '\r', '\n']) {
      const records = store.sanitizeAll([{ id: 'source-path', path: root,
        worktreeSourceDir: root + control + 'unexpected' }])
      assert.equal(records[0].worktreeSourceDir, undefined)
    }
  })
  await test('專案重讀保留初始化設定與基底，壞設定不帶入', async () => {
    const records = store.sanitizeAll([{ id: 'valid', path: root, setupScript: 'scripts\\setup.CMD',
      worktreeSourceDir: root, worktreeBase: 'a'.repeat(40) },
    { id: 'invalid', path: root + '-bad', setupScript: '../setup.ps1', worktreeBase: '--all' }])
    assert.equal(records[0].setupScript, 'scripts/setup.CMD')
    assert.equal(records[0].worktreeSourceDir, root)
    assert.equal(records[0].worktreeBase, 'a'.repeat(40))
    assert.equal(records[1].setupScript, undefined)
    assert.equal(records[1].worktreeBase, undefined)
  })
  await test('有 upstream 時直接計算 upstream..HEAD', async () => {
    const h = harness(root)
    h.state.git = args => args.includes('@{u}') ? { stdout: 'b'.repeat(40) } : gitResult(args, h.source, h.target)
    assert.equal((await h.api.check('source', h.target.path)).unpushed, 3)
    assert.ok(h.calls.some(call => call.args.join(' ') === 'rev-list --count @{u}..HEAD'))
    assert.ok(!h.calls.some(call => call.args[0] === 'merge-base'))
  })
  await test('沒 upstream 時先對建立基底取 merge-base', async () => {
    const h = harness(root)
    assert.equal((await h.api.check('source', h.target.path)).unpushed, 3)
    assert.ok(h.calls.some(call => call.args.join(' ') === `merge-base ${h.target.worktreeBase} HEAD`))
    assert.ok(h.calls.some(call => call.args.join(' ') === `rev-list --count ${'a'.repeat(40)}..HEAD`))
  })
  await test('沒有建立基底就用遠端預設分支，算不出回 null', async () => {
    const h = harness(root)
    delete h.target.worktreeBase
    h.state.git = args => args[0] === 'symbolic-ref' ? { stdout: 'refs/remotes/origin/main\n' } : gitResult(args, h.source, h.target)
    assert.equal((await h.api.check('source', h.target.path)).unpushed, 3)
    assert.ok(h.calls.some(call => call.args.join(' ') === 'merge-base refs/remotes/origin/main HEAD'))
    h.state.git = args => args[0] === 'merge-base' ? { code: 1 } : gitResult(args, h.source, h.target)
    assert.equal((await h.api.check('source', h.target.path)).unpushed, null)
  })
}

async function lifecycle(root) {
  await test('目前工作樹與專案 ID 用 Windows 大小寫一致的路徑比對', async () => {
    const h = harness(root)
    h.state.git = args => args[0] === 'worktree' && args[1] === 'list' ? { stdout:
      `worktree ${root.toUpperCase()}\nbranch refs/heads/main\n\nworktree ${h.target.path}\nbranch refs/heads/wt\n\n`
    } : gitResult(args, h.source, h.target)
    const listed = await h.api.list('source')
    assert.equal(listed.trees[0].current, process.platform === 'win32')
    assert.equal(listed.trees[0].projectId, process.platform === 'win32' ? 'source' : '')
    assert.equal(listed.trees[1].current, false)
  })
  await test('新 worktree 保存初始化腳本、來源與建立基底', async () => {
    const h = harness(root)
    const added = await h.api.add('source', 'new-agent', 'main')
    assert.equal(added.projectId, 'created')
    assert.equal(added.path, root + '-new-agent')
    assert.equal(h.state.createdProject.setupScript, 'setup.ps1')
    assert.equal(h.state.createdProject.worktreeSourceDir, root)
    assert.equal(h.state.createdProject.worktreeBase, 'a'.repeat(40))
    assert.ok(h.calls.some(call => call.args.join(' ') === `worktree add -b new-agent ${root}-new-agent main`))
  })
  await test('建立成功但登錄失敗仍回保留的工作樹', async () => {
    const h = harness(root, { storeError: true })
    const added = await h.api.add('source', 'kept')
    assert.equal(added.path, root + '-kept')
    assert.equal(added.projectId, '')
    assert.ok(added.warning.includes('保留'))
  })
  await test('正在用的終端機會擋移除，而且不執行 git remove', async () => {
    const h = harness(root, { running: [{ id: 'busy', title: 'Claude', preset: 'claude' }] })
    const checked = await h.api.check('source', h.target.path)
    assert.equal(checked.removable, false)
    assert.equal(checked.runningTerminals[0].id, 'busy')
    await assert.rejects(h.api.remove('source', h.target.path), { code: 'BLOCKED' })
    assert.ok(!h.calls.some(call => call.args[1] === 'remove'))
  })
  await test('確認後新出現終端機仍擋下，不自動結束程序', async () => {
    let reads = 0
    const h = harness(root, { running: () => ++reads === 1 ? [] : [{ id: 'new' }] })
    // renderer 的流程：先 check、跳確認框，按下移除才呼叫 remove（remove 會再 check 一次）
    assert.equal((await h.api.check('source', h.target.path)).removable, true)
    await assert.rejects(h.api.remove('source', h.target.path), { code: 'BLOCKED' })
    assert.ok(!h.calls.some(call => call.args[1] === 'remove'))
  })
  await test('移除只刪工作樹，不刪分支', async () => {
    const h = harness(root)
    await h.api.remove('source', h.target.path)
    assert.ok(h.calls.some(call => call.args.join(' ') === `worktree remove ${h.target.path}`))
    assert.ok(!h.calls.some(call => call.args.includes('-D') || call.args.includes('-d')))
    await assert.rejects(h.api.remove('source', h.source.path), { code: 'BLOCKED' })
  })
  await test('讀不到狀態時 check 與 remove 都擋下，不執行 git remove', async () => {
    const h = harness(root)
    h.state.git = args => args[0] === 'status' ? { code: 1 } : gitResult(args, h.source, h.target)
    for (const action of [h.api.check, h.api.remove]) {
      await assert.rejects(action('source', h.target.path), error => (
        error.code === 'CHECK_FAILED' && error.userMessage === '讀不到工作樹狀態，暫時無法移除'))
    }
    assert.ok(!h.calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'remove'))
  })
}

async function main() {
  const root = path.join(tempDir('worktree-flow-'), 'repo')
  fs.mkdirSync(root)
  await scripts(root)
  await counts(root)
  await lifecycle(root)
  console.log(`\n${passed} passed, 0 failed`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
