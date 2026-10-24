'use strict'

// 全部子程序都用 mock；這支測試不安裝、不更新本機工具。
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const vm = require('node:vm')
const cli = require('../src/main/ccswitch/cli-install')
let passed = 0
function ok(name, value) { assert.ok(value, name); passed++; console.log(`PASS ${name}`) }
function mockSpawn(reply, calls) {
  return (exe, args, options) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    calls.push({ exe, args, options, script })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { child.emit('close', null); return true }
    queueMicrotask(() => {
      const result = reply(script, calls.length)
      if (result.hang) return
      if (result.error) return child.emit('error', new Error('private-token'))
      child.stdout.emit('data', Buffer.from(result.output || ''))
      child.emit('close', result.code ?? 0)
    })
    return child
  }
}

async function main() {
  ok('五家固定安裝表', Object.keys(cli.INSTALLERS).length === 5)
  ok('Claude 官方原生安裝器', cli.INSTALLERS.claude.includes('https://claude.ai/install.ps1'))
  ok('Grok 官方原生安裝器', cli.INSTALLERS.grok.includes('https://x.ai/cli/install.ps1'))
  ok('agy 官方原生安裝器', cli.INSTALLERS.agy.includes('https://antigravity.google/cli/install.ps1'))
  ok('Codex 與 OpenCode 用官方 npm 套件', cli.INSTALLERS.codex.includes('@openai/codex') && cli.INSTALLERS.opencode.includes('opencode-ai'))
  const env = cli.withPath({ Path: 'old', PATH: 'duplicate', USERPROFILE: 'C:\\user', LOCALAPPDATA: 'C:\\local', APPDATA: 'C:\\roaming', ProgramFiles: 'C:\\program' }, 'new')
  ok('PATH 保留原鍵且合併大小寫', Object.keys(env).filter(k => /^path$/i.test(k)).length === 1 && env.Path.includes('new') && !env.Path.includes('duplicate'))
  ok('補上三家原生與 npm 的路徑', ['.local\\bin', '.grok\\bin', 'agy\\bin', 'roaming\\npm', 'nodejs'].every(s => env.Path.includes(s)))
  const calls = []
  let installed = false
  let hasNode = false
  const spawnImpl = mockSpawn(script => {
    if (script.includes("GetEnvironmentVariable('Path'")) return { output: hasNode ? 'C:\\new-node' : 'C:\\old' }
    if (script.includes('OpenJS.NodeJS.LTS')) { hasNode = true; return {} }
    if (script.includes('node --version') || script.includes('npm --version')) return { code: hasNode ? 0 : 1 }
    if (script.includes('npm.cmd install')) { installed = true; return {} }
    if (script.includes('codex --version')) return { output: installed ? 'codex-cli 9.9.9' : '', code: installed ? 0 : 1 }
    return {}
  }, calls)
  const runner = cli.createRunner({ spawnImpl, env: { SystemRoot: 'C:\\Windows', Path: 'old' } })
  const task = runner.run('codex')
  ok('同步取得工具鎖', runner.status('codex').phase === 'running')
  const busy = await runner.run('codex')
  ok('同工具禁止同時執行', busy.code === 'BUSY')
  const done = await task
  ok('補環境後安裝並驗版本', done.phase === 'succeeded' && done.local === '9.9.9')
  ok('環境安裝固定且靜默', calls.some(c => c.script.includes('OpenJS.NodeJS.LTS') && c.script.includes('--silent') && c.script.includes('--disable-interactivity')))
  ok('環境安裝後同程序使用新 PATH', calls.find(c => c.script.includes('npm.cmd install')).options.env.Path.includes('C:\\new-node'))
  ok('全部子程序隱藏且 stdin ignore', calls.every(c => c.options.windowsHide && c.options.stdio[0] === 'ignore' && c.options.shell === false))
  const updated = await runner.run('codex')
  ok('已安裝使用自己的 updater', updated.action === 'update' && calls.some(c => c.script.includes('codex update')))
  for (const key of Object.keys(cli.INSTALLERS)) {
    const toolCalls = []
    let present = false
    const toolRunner = cli.createRunner({ spawnImpl: mockSpawn(script => {
      if (script.includes(`${key} --version`)) return { code: present ? 0 : 1, output: present ? '1.2.3' : '' }
      if (script.includes(cli.INSTALLERS[key])) present = true
      return {}
    }, toolCalls) })
    const install = await toolRunner.run(key)
    const update = await toolRunner.run(key)
    ok(`${key} 安裝與更新固定指令且完成後驗版本`, install.action === 'install' && update.action === 'update' && update.phase === 'succeeded' && toolCalls.some(c => c.script.includes(cli.UPDATERS[key])))
  }
  const sharedCalls = []
  let sharedNode = false
  const sharedRunner = cli.createRunner({ spawnImpl: mockSpawn(script => {
    if (script.includes('OpenJS.NodeJS.LTS')) { sharedNode = true; return {} }
    if (script.includes('node --version') || script.includes('npm --version')) return { code: sharedNode ? 0 : 1 }
    if (/codex --version|opencode --version/.test(script)) return { output: '1.2.3' }
    return {}
  }, sharedCalls) })
  const sharedResults = await Promise.all([sharedRunner.run('codex'), sharedRunner.run('opencode')])
  ok('不同工具共用一次 Node 環境安裝', sharedResults.every(r => r.phase === 'succeeded') && sharedCalls.filter(c => c.script.includes('OpenJS.NodeJS.LTS')).length === 1)
  const missingCalls = []
  const missing = cli.createRunner({ spawnImpl: mockSpawn(script => ({ code: script.includes('GetEnvironmentVariable') ? 0 : 1 }), missingCalls) })
  ok('環境安裝失敗就停止，不跑 CLI 安裝', (await missing.run('opencode')).phase === 'failed' && !missingCalls.some(c => c.script.includes(cli.INSTALLERS.opencode)))
  const shimCalls = []
  let shimNode = false
  const shim = cli.createRunner({ spawnImpl: mockSpawn(script => {
    if (script.includes('OpenJS.NodeJS.LTS')) { shimNode = true; return {} }
    if (script.includes('node --version') || script.includes('npm --version')) return { code: shimNode ? 0 : 1 }
    if (script.includes('codex --version')) return { code: shimNode ? 0 : 1, output: shimNode ? '1.2.3' : '' }
    return {}
  }, shimCalls) })
  ok('已裝 npm shim 缺 Node 時補環境後使用 updater', (await shim.run('codex')).action === 'update' && !shimCalls.some(c => c.script.includes(cli.INSTALLERS.codex)))
  const before = calls.length
  const invalid = await runner.run('codex; bad')
  ok('拒絕任意工具與指令', invalid.code === 'INVALID_TOOL' && calls.length === before)
  const badCalls = []
  const failure = cli.createRunner({ spawnImpl: mockSpawn(script => script.includes('GetEnvironmentVariable') ? {} : { code: 1, output: 'Authorization: Bearer private-value\nhttps://user:secret@example.com/?token=secret\nETIMEDOUT\nEACCES' }, badCalls) })
  const failed = await failure.run('agy')
  ok('失敗只回固定摘要', failed.phase === 'failed' && failed.summary.includes('權限') && !JSON.stringify(failed).includes('secret') && !JSON.stringify(failed).includes('private-value'))
  const timeoutCalls = []
  const timeout = cli.createRunner({ timeoutMs: 30, spawnImpl: mockSpawn(() => ({ hang: true }), timeoutCalls) })
  ok('整個任務逾時', (await timeout.run('grok')).code === 'TIMEOUT')
  ok('逾時後釋放工具鎖', timeout.status('grok').phase === 'failed')
  const treeCalls = []
  const treeSpawn = (exe, args, options) => {
    treeCalls.push({ exe, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.pid = 424242
    child.kill = () => child.emit('close', null)
    if (exe.endsWith('taskkill.exe')) queueMicrotask(() => child.emit('close', 0))
    return child
  }
  const tree = cli.createRunner({ timeoutMs: 20, spawnImpl: treeSpawn })
  ok('逾時只清自己的 PID tree', (await tree.run('agy')).code === 'TIMEOUT' && treeCalls.some(c => c.exe.endsWith('taskkill.exe') && JSON.stringify(c.args) === '["/PID","424242","/T","/F"]'))
  const thrown = cli.createRunner({ spawnImpl: () => { throw new Error('private-token') } })
  ok('spawn 拋錯也回固定摘要與釋放鎖', (await thrown.run('agy')).code === 'SPAWN_FAILED' && thrown.status('agy').phase === 'failed')
  const version = require('../src/main/ccswitch/cli-version')
  const urls = []
  const fetchImpl = async url => { urls.push(url); return { ok: true, status: 200, body: { getReader: () => {
    let sent = false
    return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from('{"version":"1.2.17"}') }), releaseLock() {} }
  } } } }
  ok('agy 從官方 manifest 讀最新版', await version.fetchAgyLatest({ fetchImpl, platform: 'win32' }) === '1.2.17')
  await version.fetchAgyLatest({ fetchImpl, arch: 'arm64', platform: 'win32' })
  ok('agy 依 CPU 查公開平台 manifest', urls[0].endsWith('/windows_amd64.json') && urls[1].endsWith('/windows_arm64.json'))
  await version.fetchAgyLatest({ fetchImpl, arch: 'x64', platform: 'linux' })
  await version.fetchAgyLatest({ fetchImpl, arch: 'arm64', platform: 'linux' })
  ok('agy 在 Linux 查 linux manifest', urls[2].endsWith('/linux_amd64.json') && urls[3].endsWith('/linux_arm64.json'))
  // 模組 IPC 真正註冊與 sender 守衛；絕不呼叫本機安裝服務。
  const handlers = new Map()
  const { registerCcSwitchIpc } = require('../src/main/ccswitch/ipc')
  const mainEvent = {}
  registerCcSwitchIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, isMainSender: e => e === mainEvent,
    service: { runCliTask: key => ({ key, phase: 'succeeded' }), cliTaskStatus: () => ({ phase: 'idle' }) } })
  ok('安裝 IPC 維持主視窗守衛', (await handlers.get('ccswitch:runCliTask')({}, 'agy')).error.code === 'FORBIDDEN')
  ok('背景任務與狀態 IPC 完整註冊，移除舊指令 IPC', (await handlers.get('ccswitch:runCliTask')(mainEvent, 'agy')).data.key === 'agy' && (await handlers.get('ccswitch:cliTaskStatus')(mainEvent, 'agy')).data.phase === 'idle' && !handlers.has('ccswitch:updateCommand'))
  await checkRenderer()
  console.log(`${passed} passed`)
}

async function checkRenderer() {
  // 只載入負責的三個函式；假 DOM 驗按鈕狀態與晚到回應，不開瀏覽器。
  const source = fs.readFileSync(require.resolve('../src/renderer/scripts/ccswitch-page.js'), 'utf8')
  const section = source.slice(source.indexOf('// ===== CLI 版本 ====='), source.indexOf('// ===== 生命週期 ====='))
  function element(tag, className = '', text = '') {
    return { tag, className, text, dataset: {}, children: [], attrs: {}, disabled: false,
      get textContent() { return this.text + this.children.map(c => c.textContent).join('') },
      set textContent(value) { this.text = value },
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = children },
      setAttribute(key, value) { this.attrs[key] = value }, addEventListener() {} }
  }
  const list = element('div'), check = element('button', '', '重新檢查')
  const tool = { key: 'agy', label: 'Antigravity CLI', installed: false, latest: '1.2.17' }
  const done = { phase: 'succeeded', message: '安裝完成', local: '1.2.17' }
  let finishTask, finishPoll, tick, checks = 0, cleared = false
  const api = { runCliTask: key => { assert.equal(key, 'agy'); return new Promise(resolve => { finishTask = resolve }) },
    cliTaskStatus: () => new Promise(resolve => { finishPoll = resolve }),
    checkVersions: async () => { checks++; return { ok: true, data: [{ ...tool, installed: true, local: '1.2.17', task: done }] } } }
  const renderer = vm.runInNewContext(`(() => { let versions=[]; ${section}; return { renderVersions, runUpdate, set: value => versions=value, get: () => versions } })()`, {
    document: { getElementById: id => id === 'ccVersionList' ? list : check }, el: element,
    electronAPI: { ccswitch: api }, call: async reply => (await reply).data,
    window: { setInterval: fn => { tick = fn; return 1 }, clearInterval: () => { cleared = true } }
  })
  renderer.set([tool]); renderer.renderVersions()
  const button = () => list.children[0].children[1].children[0]
  ok('未安裝列顯示安裝鈕與最新版本', button().textContent === '安裝' && list.textContent.includes('最新 1.2.17'))
  const pending = renderer.runUpdate(tool)
  ok('按下立即 disable 並顯示安裝中', button().disabled && button().textContent === '安裝中…')
  const latePoll = tick()
  finishTask({ ok: true, data: done }); await pending
  ok('完成自動重查版本並恢復更新鈕', checks === 1 && cleared && !button().disabled && button().textContent === '更新')
  finishPoll({ ok: true, data: { phase: 'running', message: '準備環境中…' } }); await latePoll
  ok('晚到的進度不可蓋掉完成狀態', renderer.get()[0].task.phase === 'succeeded' && !button().disabled)
  renderer.set([{ ...tool, task: { phase: 'failed', message: '執行失敗', summary: '連線或下載失敗' } }]); renderer.renderVersions()
  ok('列上顯示精簡錯誤且可以重試', list.textContent.includes('連線或下載失敗') && !button().disabled)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
