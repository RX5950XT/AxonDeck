'use strict'
// 真正的本機 CLI，只啟動畫面，不送出 AI 提問；只收本探針自己的程序。
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit'
  })
  child.on('exit', code => { process.exitCode = code || 0 })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
} else {
  const pty = require('@lydell/node-pty')
  const { PRESETS } = require('../src/main/terminal/store')
  const { shellEnvironment } = require('../src/main/terminal/pty')
  const { tempDir } = require('./lib/test-temp')
  const cwd = tempDir('native-scroll-cli-')
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  ;(async () => {
    for (const agent of ['claude', 'codex', 'grok', 'opencode', 'agy']) {
      const terminal = pty.spawn(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', PRESETS[agent].command], {
        cwd, cols: 110, rows: 30, env: shellEnvironment('', '', 't_probe_scroll', agent)
      })
      let output = '', exited = false
      terminal.onData(data => {
        output += data
        if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R')
      })
      terminal.onExit(() => { exited = true })
      try {
        for (let i = 0; i < 40 && !exited; i++) await delay(250)
        const alternate = /\x1b\[\?(?:\d+;)*(?:1049|1047|47)(?:;\d+)*h/.test(output)
        const badFlag = /unexpected argument|unknown flag|unknown option|unrecognized option/i.test(output)
        console.log(JSON.stringify({ agent, bytes: output.length, alternate, exited, badFlag }))
        assert(output.length > 100 && !exited && !badFlag, agent + ' 未進入互動畫面')
        assert.equal(alternate, agent === 'opencode', agent + ' 捲動模式不符')
      } finally {
        try { execFileSync('taskkill', ['/PID', String(terminal.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 已退出 */ }
        terminal.kill()
      }
    }
    console.log('PASS 五家真 CLI 以原生畫面啟動，未送出 AI 提問')
  })().catch(error => { console.error(error); process.exitCode = 1 })
}
