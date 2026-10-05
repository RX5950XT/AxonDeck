'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const net = require('node:net')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit'
  })
  child.on('exit', code => { process.exitCode = code || 0 })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
} else {
  const { HostClient } = require('../src/main/terminal/host-client')
  const { connection, stageRuntime, runtimeName } = require('../src/main/terminal/host-runtime')
  // ponytail: Electron 退路版宿主沒有 CreateEnvironmentBlock，只擋 Claude 標記；開 App 的終端機留下的其他變數照樣帶過去
  const native = Boolean(runtimeName().native)
  const userData = tempDir('terminal-host-test-')
  const id = 't_host_continuity'
  const meta = { id, shell: 'powershell', preset: 'shell', cwd: userData, title: 'Host test' }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  let client = new HostClient(userData, () => {})
  let pid = 0

  async function waitFor(fn, label, timeout = 15000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (await fn()) return
      await sleep(100)
    }
    throw new Error(label)
  }

  async function rejected(message) {
    const config = connection(userData)
    const socket = net.connect(config.pipe)
    let data = ''
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('未拒絕壞封包')) }, 5000)
      socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`))
      socket.on('data', chunk => { data += chunk })
      socket.on('error', () => socket.destroy())
      socket.on('close', () => { clearTimeout(timeout); resolve() })
    })
    assert.equal(data, '', '未認證的連線不可以取得終端機資料')
  }

  async function legacyHostContinuity() {
    // 可以指定留存的舊版產物；乾淨 checkout 沒有它時明確回報未涵蓋。
    const oldExe = process.env.LEGACY_TERM_EXE || path.join(root, 'resources/probe/voiceink-term.exe')
    if (!fs.existsSync(oldExe)) { console.log('SKIP 舊版 exe 真程序驗證：未提供 LEGACY_TERM_EXE'); return }
    const data = tempDir('terminal-legacy-')
    const config = connection(data, true)
    const runtime = path.join(config.root, 'runtime-legacy-fixture')
    const exe = path.join(runtime, 'VoiceInkTerminalHost.exe')
    fs.mkdirSync(runtime)
    fs.copyFileSync(oldExe, exe)
    fs.writeFileSync(path.join(runtime, 'ready'), 'native')
    const child = spawn(exe, [`--pipe=${config.pipe}`, `--root=${config.root}`], {
      cwd: runtime, detached: true, windowsHide: true, stdio: 'ignore'
    })
    let failed
    child.on('error', error => { failed = error })
    child.unref()
    let old = new HostClient(data, () => {})
    const sessionId = 't_legacy_upgrade'
    try {
      await waitFor(async () => {
        if (failed) throw failed
        return old.ensure(false)
      }, '舊宿主沒有開啟管道')
      const meta = { id: sessionId, shell: 'powershell', preset: 'shell', cwd: data, title: 'Legacy test' }
      const before = await old.request('open', { sessionId, meta, cols: 80, rows: 24 }, true)
      assert.ok(before.pid > 0)
      old.disconnect()
      old = new HostClient(data, () => {})
      const after = await old.request('open', { sessionId, meta, cols: 80, rows: 24 }, true)
      assert.equal(after.pid, before.pid, '新版不可重跑舊 shell')
      assert.equal(old.host.pid, child.pid, '新版必須連回原宿主')
      assert.equal(old.stale(), true, '既有升級提示必須認出舊版 runtime')
      stageRuntime(config.root)
      assert.ok(fs.existsSync(exe), '還在執行的舊名 exe 不可被清掉')
      await old.request('write', { sessionId, data: 'exit\r' })
      await waitFor(async () => (await old.request('list')).some(item => item.id === sessionId && item.state === 'exited'), '舊 shell 未結束')
      await old.request('forget', { sessionId })
      old.disconnect()
      await waitFor(() => child.exitCode === 0, '舊宿主關閉最後階段後沒有自行結束')
      stageRuntime(config.root)
      assert.equal(fs.existsSync(runtime), false, '已結束的舊名 runtime 要清掉')
      console.log('PASS 舊版 exe 接回原 shell PID、升級提示、鎖定保護、最後階段關閉後自行退出與清理')
    } finally {
      old.disconnect()
      if (child.pid && child.exitCode === null) {
        try { execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
        catch { /* 已自行結束 */ }
        child.kill()
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, '測試宿主未完全結束')
      }
      try { removeTree(data) } catch (error) { console.error('測試暫存清理失敗', error); process.exitCode = 1 }
    }
  }

  function legacyHookEnvironment() {
    const source = path.join(root, 'resources/probe/axondeck-probe.exe')
    if (!fs.existsSync(source)) throw new Error('請先 build:probe 才能驗證新版 hook')
    const data = tempDir('terminal-legacy-hook-')
    try {
      const exe = path.join(data, 'axondeck-claude-hook.exe')
      fs.copyFileSync(source, exe)
      const env = { ...process.env, VOICEINK_TERMINAL_ID: 't_legacy_hook', CLAUDE_JOB_DIR: '' }
      delete env.AXONDECK_TERMINAL_ID
      const result = spawnSync(exe, ['claude-hook'], { env, windowsHide: true, encoding: 'utf8',
        input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'legacy-session' }) })
      assert.equal(result.status, 0)
      assert.equal(result.stdout, '')
      const events = path.join(data, 'events')
      const files = fs.readdirSync(events)
      assert.equal(files.length, 1)
      const record = JSON.parse(fs.readFileSync(path.join(events, files[0]), 'utf8'))
      assert.equal(record.terminalId, 't_legacy_hook')
      console.log('PASS 新 Rust hook 讀取舊 shell 的分頁 ID，stdout 保持空白')
    } finally { removeTree(data) }
  }

  async function main() {
    const legacyConfig = connection(userData, true)
    const name = require('node:crypto').createHash('sha256').update(legacyConfig.root.toLowerCase()).digest('hex').slice(0, 24)
    assert.equal(legacyConfig.pipe, `\\\\.\\pipe\\voiceink-terminal-v1-${name}`, '改名後仍須接回舊管道，不能另起一顆孤兒宿主')
    await legacyHostContinuity()
    legacyHookEnvironment()
    // App 從 Claude 工作階段裡開起來時會繼承這些；宿主要擋掉，終端機裡的 Claude 才不會當自己是子工作階段
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    process.env.GIT_EDITOR = 'true'
    // 開 App 的那個終端機（Windows Terminal／Claude 的工具 shell）留下的；Rust 宿主改用登錄檔裡的使用者環境，一個都不會帶過去
    process.env.WT_SESSION = 'inherited'
    // PATH 被別的 whoami.exe／icacls.exe 佔走（Git Bash 的 MSYS 版）時也要建得起宿主資料夾
    const poisoned = tempDir('terminal-host-path-')
    const savedPath = process.env.PATH
    process.env.PATH = ''
    try { assert.ok(connection(poisoned, true)?.token, '找不到 whoami／icacls 就建不出宿主資料夾') }
    finally { process.env.PATH = savedPath; removeTree(poisoned) }
    console.log('PASS 建立宿主資料夾不靠 PATH 找 whoami／icacls')

    const snapshots = await Promise.all([
      client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true),
      client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)
    ])
    await waitFor(async () => {
      const states = await client.request('list')
      pid = states[0]?.pid
      return Number.isInteger(pid) && pid > 0
    }, 'ConPTY 沒有啟動 shell')
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.equal(snapshots[1].id, snapshots[0].id)
    assert.equal((await client.request('list')).length, 1, '同時開啟同一工作階段不可以生出兩顆 shell')
    assert.equal((await client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)).pid, pid)
    console.log('PASS 獨立 runtime 與真 ConPTY，同時開啟沿用同一個 PID')
    await rejected({ id: 1, op: 'list' })
    await rejected({ id: 1, op: 'auth', protocol: 1, token: '界'.repeat(64) })
    await rejected({ id: 1, op: 'auth', protocol: 1, token: '0'.repeat(64) })
    assert.equal((await client.request('list'))[0].pid, pid)
    console.log('PASS 未認證／錯誤通行證／多位元組封包被拒絕，宿主仍可用')
    await assert.rejects(client.request('unknown', { sessionId: id }))
    await assert.rejects(client.request('open', { sessionId: '../escape', meta }))
    await assert.rejects(client.request('write', { sessionId: id, data: {} }))
    console.log('PASS 操作、工作階段 id 與輸入型別驗證')

    await sleep(1500)
    await client.request('write', { sessionId: id, data: "& { Set-Content -LiteralPath 'env.txt' ($env:ELECTRON_RUN_AS_NODE + '|' + $env:ELECTRON_NO_ASAR + '|' + $env:CLAUDE_CODE_CHILD_SESSION + '|' + $env:GIT_EDITOR + '|' + $env:WT_SESSION); 1..24 | ForEach-Object { Add-Content -LiteralPath 'beat.txt' $_; Write-Output ('HOST_KEEP_' + $_); Start-Sleep -Milliseconds 200 } }\r" })
    // shell 正在 Add-Content 時讀會拿到 EBUSY，等下一輪再讀就好。
    let lastBeats = 0
    const beats = () => {
      try { lastBeats = fs.readFileSync(path.join(userData, 'beat.txt'), 'utf8').trim().split(/\r?\n/).length } catch { /* 檔案還沒建立或正被寫入 */ }
      return lastBeats
    }
    await waitFor(() => beats() >= 3, '沒有收到 shell 心跳')
    const before = beats()
    client.disconnect()
    await waitFor(() => beats() >= before + 3, 'App 斷線後 shell 沒有持續執行')
    client = new HostClient(userData, () => {})
    const reattached = await client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)
    assert.equal(reattached.pid, pid)
    assert.ok(reattached.buffer.includes('HOST_KEEP_'))
    assert.equal(fs.readFileSync(path.join(userData, 'env.txt'), 'utf8').trim(), native ? '||||' : '||||inherited', 'Node 宿主與 Claude 工作階段的環境變數不可污染 shell')
    console.log('PASS App 斷線期間繼續執行，重新接回同一個 PID 與輸出')
    await waitFor(() => beats() === 24, '心跳指令未完成')
    await client.request('write', { sessionId: id, data: 'exit\r' })
    await waitFor(async () => (await client.request('list')).some(item => item.id === id && item.state === 'exited'), '退出後沒有保留已結束狀態')
    client.disconnect()
    client = new HostClient(userData, () => {})
    const ended = await client.request('open', { sessionId: id, meta, cols: 100, rows: 30 }, true)
    assert.equal(ended.state, 'exited')
    assert.equal(ended.pid, pid)
    assert.ok(ended.buffer.includes('HOST_KEEP_'))
    console.log('PASS 已結束的終端機保留畫面，不會因重新接回而重跑')
    await client.request('forget', { sessionId: id })
    assert.equal((await client.request('list')).length, 0)
    console.log('PASS 明確關閉才移除工作階段')

    // 每次改版都會多一份 248MB 的執行環境；舊的沒人用就要清掉，還在跑的不准動。
    const hostRoot = connection(userData).root
    const stale = path.join(hostRoot, 'runtime-0000000000000000000stale')
    fs.mkdirSync(stale, { recursive: true })
    fs.writeFileSync(path.join(stale, 'AxonDeckTerminalHost.exe'), 'x')
    fs.writeFileSync(path.join(stale, 'ready'), '0.0.0')
    const legacyStale = path.join(hostRoot, 'runtime-legacy-unused')
    fs.mkdirSync(legacyStale)
    fs.writeFileSync(path.join(legacyStale, 'VoiceInkTerminalHost.exe'), 'x')
    fs.writeFileSync(path.join(legacyStale, 'ready'), 'native')
    const current = stageRuntime(hostRoot)
    assert.ok(fs.existsSync(current.exe), '目前使用的執行環境不可以被清掉')
    assert.equal(fs.existsSync(stale), false, '沒人使用的舊執行環境要清掉')
    assert.equal(fs.existsSync(legacyStale), false, '舊名 exe 所在的閒置 runtime 也要清掉')
    console.log('PASS 舊版執行環境會被清掉，目前這份留著')
  }

  main().catch(error => { console.error('FAIL', error); process.exitCode = 1 }).finally(async () => {
    try {
      client.disconnect()
      const cleanup = new HostClient(userData, () => {})
      await cleanup.request('forget', { sessionId: id })
      const hostPid = cleanup.host.pid
      cleanup.disconnect()
      if (hostPid) await waitFor(() => {
        try { process.kill(hostPid, 0); return false } catch { return true }
      }, '測試宿主未自行結束')
      removeTree(userData)
    } catch (error) { console.error('測試宿主清理失敗', error); process.exitCode = 1 }
    console.log(`Evidence: ${userData}`)
  })
}
