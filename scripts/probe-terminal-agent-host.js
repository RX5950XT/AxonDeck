'use strict'

// 真的走兩種宿主與 ConPTY；目前目錄的假 CLI 只把收到的 argv 寫檔，不碰登入或 API。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit'
  })
  child.on('exit', code => { process.exitCode = code || 0 })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
} else {
  const { tempDir } = require('./lib/test-temp')
  const { HostClient } = require('../src/main/terminal/host-client')
  const { runtimeName } = require('../src/main/terminal/host-runtime')
  const userData = tempDir('agent-host-')
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const expected = {
    claude: `--resume ${uuid}`, codex: `resume --no-daemon ${uuid}`,
    grok: `--resume ${uuid}`, agy: `--conversation ${uuid}`, opencode: '--session ses_123456789'
  }
  const metas = Object.keys(expected).map(preset => ({
    id: `t_${preset}_resume`, shell: 'cmd', preset, cwd: userData,
    agentSessionId: preset === 'opencode' ? 'ses_123456789' : uuid,
    agentHome: ['claude', 'codex'].includes(preset) ? path.join(userData, `${preset}-runtime-home`) : ''
  }))
  let client = new HostClient(userData, () => {})
  let hostPid = 0
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const calls = agent => {
    try { return fs.readFileSync(path.join(userData, `${agent}-args.txt`), 'utf8').trim().split(/\r?\n/) }
    catch { return [] }
  }
  async function waitFor(fn, label) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
    throw new Error(label)
  }
  async function open(meta) {
    const snapshot = await client.request('open', { sessionId: meta.id, meta, cols: 100, rows: 25 }, true)
    hostPid = client.host.pid
    return snapshot
  }
  async function main() {
    for (const agent of Object.keys(expected)) {
      const homeVar = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : agent === 'codex' ? 'CODEX_HOME' : ''
      const homeLine = homeVar ? `echo %${homeVar}%>${agent}-home.txt\r\n` : ''
      fs.writeFileSync(path.join(userData, `${agent}.cmd`), `@echo off\r\necho %*>>${agent}-args.txt\r\n${homeLine}echo DUMMY_${agent} %*\r\n`)
    }
    for (const meta of metas) await open(meta)
    await waitFor(() => Object.keys(expected).every(agent => calls(agent).length === 1), '五個 CLI 沒收到接回指令')
    for (const [agent, args] of Object.entries(expected)) assert.equal(calls(agent)[0], args)
    for (const meta of metas.filter(t => t.agentHome)) {
      assert.equal(fs.readFileSync(path.join(userData, `${meta.preset}-home.txt`), 'utf8').trim(), meta.agentHome)
    }
    console.log(`PASS ${runtimeName().native ? 'native' : 'Electron fallback'} 五家固定 resume argv、Claude/Codex 自訂 home 真的送進 ConPTY`)
    const before = new Map((await client.request('list')).map(item => [item.id, item.pid]))
    client.disconnect()
    client = new HostClient(userData, () => {})
    for (const meta of metas) assert.equal((await open(meta)).pid, before.get(meta.id))
    await sleep(700)
    for (const agent of Object.keys(expected)) assert.equal(calls(agent).length, 1)
    console.log('PASS App 斷線重接五個原 shell，同 PID、不重送 resume')
    assert.equal(await client.restart(), true)
    for (const meta of metas) await open(meta)
    await waitFor(() => Object.keys(expected).every(agent => calls(agent).length === 2), '宿主消失後沒有按指定 ID 接回')
    for (const [agent, args] of Object.entries(expected)) assert.equal(calls(agent)[1], args)
    console.log('PASS 宿主消失後五家依指定 ID 接回，沒有改接最後一筆對話')
  }
  main().catch(error => { console.error('FAIL', error); process.exitCode = 1 }).finally(async () => {
    try {
      for (const meta of metas) await client.request('forget', { sessionId: meta.id })
    } catch { /* 失敗時仍只收這支探針自己的宿主 */ }
    const ownPid = client.host.pid || hostPid
    client.disconnect()
    if (ownPid) { try { process.kill(ownPid) } catch { /* 已自行結束 */ } }
    await sleep(300)
  })
}
