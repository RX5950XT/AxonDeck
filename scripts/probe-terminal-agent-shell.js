'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const { commandForShell } = require('../src/main/terminal/agent-resume')
const dir = tempDir('agent-shell-')
const home = path.join(dir, "runtime's % & (home)")
fs.mkdirSync(home)
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const info = { agent: 'codex', sessionId: id, home }
fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\necho "%CODEX_HOME%">"%~dp0seen-home.txt"\r\necho %*>"%~dp0seen-args.txt"\r\n')
const env = { ...process.env, CODEX_HOME: 'PARENT_HOME', PATH: `${dir};${process.env.PATH || process.env.Path}` }
delete env.Path
const read = file => fs.readFileSync(path.join(dir, file), 'utf8').trim()
for (const shell of ['powershell', 'cmd']) {
  const command = commandForShell(shell, info)
  const exe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', shell === 'cmd' ? 'cmd.exe' : 'WindowsPowerShell/v1.0/powershell.exe')
  const args = shell === 'cmd' ? ['/d', '/s', '/c', `${command} & echo VI_AFTER:%CODEX_HOME%`]
    : ['-NoLogo', '-NoProfile', '-Command', `${command}; Write-Output ('VI_AFTER:' + $env:CODEX_HOME)`]
  const result = execFileSync(exe, args, { env, cwd: dir, windowsHide: true, encoding: 'utf8', timeout: 15000 })
  assert.equal(read('seen-home.txt'), `"${home}"`)
  assert.equal(read('seen-args.txt'), `resume --no-daemon --no-alt-screen ${id}`)
  assert.ok(result.includes('VI_AFTER:PARENT_HOME'), '接續後必須恢復原 shell 的 home')
  console.log(`PASS ${shell} 接續只暫時換可信 home，單引號／百分號／&／空白／括號不會變成指令`)
}
