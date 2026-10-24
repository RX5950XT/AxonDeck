'use strict'
// 專案腳本開瀏覽器改道：`node scripts/test-script-launch.js`
const assert = require('node:assert/strict')
const { urlArg, rewriteBatch, projectIdOf, terminalCommand, serverUrl, noteTerminal, setOpenUrl, openScriptUrl } = require('../src/main/script-launch')

assert.equal(urlArg(['AxonDeck.exe', '--axondeck-start', '', 'http://127.0.0.1:8188']), 'http://127.0.0.1:8188')
assert.equal(urlArg(['x.exe', '/b', '/wait', 'C:\\a\\setup.exe']), '', '不是網址')
assert.equal(urlArg(['x.exe', 'https://a.example/?q=1&b=2']), 'https://a.example/?q=1&b=2', 'BROWSER 叫的')
assert.equal(urlArg(['x.exe', '--axondeck-start', '/b', '/wait', 'cmd', '/c', 'echo', 'http://x']), '', '參數裡剛好有網址不算')
assert.equal(urlArg(['x.exe', '--axondeck-start', 'My Title', 'https://a.example/']), 'https://a.example/', '有標題')
assert.equal(urlArg(['x.exe', '--axondeck-start', '/max', 'https://a.example/']), 'https://a.example/', '開關後直接是網址')

const file = 'D:\\Work\\Miroxen\\start.bat'
const src = [
  '@echo off',
  'cd /d "%~dp0"',
  'set "URL=http://127.0.0.1:8188"',
  'echo start the server at %URL%',
  'rem start "" %URL%',
  'start "" %URL%',
  'if errorlevel 1 (start "" "%~f0") else start "" %URL%',
  'echo %~nx0 %0 & start /b /wait setup.exe'
].join('\n')
const out = rewriteBatch(src, file).split('\r\n')
assert.equal(out[1], 'cd /d "D:\\Work\\Miroxen\\"', '%~dp0 指回原腳本的資料夾')
assert.equal(out[3], 'echo start the server at %URL%', 'echo 裡的 start 不動')
assert.equal(out[4], 'rem start "" %URL%', '註解不動')
const ROUTE = (args) => `(%AXONDECK_START% ${args} || start ${args})`
assert.equal(out[5], ROUTE('"" %URL%'))
assert.equal(out[6], `if errorlevel 1 (start "" "D:\\Work\\Miroxen\\start.bat") else ${ROUTE('"" %URL%')}`, '括號裡沒網址的不動、else 後面的改')
assert.equal(out[7], 'echo start.bat "D:\\Work\\Miroxen\\start.bat" & start /b /wait setup.exe', '沒網址沒變數的 start 不改')
assert.equal(rewriteBatch('(start "" "http://a/?x=1&y=2") & echo ok', file),
  `(${ROUTE('"" "http://a/?x=1&y=2"')}) & echo ok`, '引號裡的 & 不是指令結尾、括號收在 ) 前')
assert.equal(rewriteBatch('for %%u in (a) do start "" !URL! >nul', file), `for %%u in (a) do ${ROUTE('"" !URL! >nul')}`)
assert.equal(rewriteBatch(src, 'D:\\工作\\a.bat'), null, '非 ASCII 路徑不改寫')
assert.equal(rewriteBatch(src, 'D:\\100%\\a.bat'), null, '% 會被 cmd 吃掉')

const projects = [{ id: 'w_a', path: 'D:\\Work' }, { id: 'w_b', path: 'D:\\Work\\Miroxen' }, { id: 'w_c', path: 'D:\\Workspace' }]
assert.equal(projectIdOf(projects, 'd:\\work\\miroxen\\start.bat'), 'w_b', '最長的根目錄、不分大小寫')
assert.equal(projectIdOf(projects, 'D:\\Work\\x.bat'), 'w_a')
assert.equal(projectIdOf(projects, 'D:\\Workspaces\\x.bat'), '', 'D:\\Workspace 不能吃到 D:\\Workspaces')

assert.equal(rewriteBatch('cd /d "%~dp0" & echo %~nx0', 'D:\\工作\\100%\\a.cmd', true),
  'cd /d "%AXONDECK_SELF_D%%AXONDECK_SELF_P%" & echo %AXONDECK_SELF_N%%AXONDECK_SELF_X%')
assert.equal(serverUrl('\x1b[32mLocal: http://localhost:5173/test?a=1&b=2\x1b[0m'), 'http://localhost:5173/test?a=1&b=2')
assert.equal(serverUrl('http://0.0.0.0:8000'), 'http://127.0.0.1:8000/')
assert.equal(serverUrl('http://[::]:8000/'), 'http://[::1]:8000/')
for (const unsafe of ['http://localhost.evil:80/', 'http://127.0.0.1:8000.evil/', 'http://localhost:99999/', 'file:///tmp/x', 'https://example.com:8000/']) {
  assert.equal(serverUrl(unsafe), '', unsafe)
}

async function checkTerminal() {
  const fs = require('node:fs')
  const path = require('node:path')
  const http = require('node:http')
  const Module = require('node:module')
  const { tempDir } = require('./lib/test-temp')
  const root = tempDir('script-command-')
  const file = path.join(root, "中文 it's.cmd")
  fs.writeFileSync(file, '@echo off\r\necho %~dp0\r\n', 'latin1')
  const load = Module._load
  Module._load = function (name, ...args) {
    return name === 'electron' ? { app: { isPackaged: true, getPath: () => root } } : load.call(this, name, ...args)
  }
  let command
  try { command = await terminalCommand(file, 'w_parent', 't_selfcheck') } finally { Module._load = load }
  assert.ok(!/EncodedCommand/.test(command), '終端機不顯示 base64')
  const wrapper = /-File '([^']+\.ps1)'$/.exec(command)?.[1]
  const source = fs.readFileSync(wrapper, 'utf8').replace(/^﻿/, '').trimEnd()
  fs.rmSync(wrapper)
  assert.ok(source.includes("$env:AXONDECK_PROJECT='w_parent'"))
  assert.ok(source.includes("$env:AXONDECK_SCRIPT_RUN='t_selfcheck'"))
  assert.ok(source.includes(file.replace(/'/g, "''")), '中文與單引號完整保留')
  assert.ok(source.includes('function Start-Process'), 'PowerShell 開網址也改道')
  assert.equal(fs.readFileSync(file, 'latin1'), '@echo off\r\necho %~dp0\r\n', '不改原檔')
  const temp = /& '([^']+\.cmd)'$/.exec(source)?.[1]
  assert.ok(temp)
  assert.match(fs.readFileSync(temp, 'latin1'), /%AXONDECK_SELF_D%%AXONDECK_SELF_P%/)
  fs.rmSync(temp)
  await assert.rejects(() => terminalCommand(path.join(root, 'hello.js'), 'w_parent', 't_selfcheck'), /不支援/)
  const server = http.createServer((_req, res) => res.end('ready'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const opened = []
  setOpenUrl((href, project) => opened.push({ href, project }))
  noteTerminal('terminal:data', { id: 't_other', data: `${url}\n` })
  noteTerminal('terminal:data', { id: 't_selfcheck', data: 'Local: htt' })
  noteTerminal('terminal:data', { id: 't_selfcheck', data: `${url.slice(3)}\r\n` })
  await openScriptUrl(url, 'w_wrong', 't_selfcheck')
  const deadline = Date.now() + 2000
  while (!opened.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(opened, [{ href: url, project: 'w_parent' }], '輸出分塊、點擊時專案、重複網址只開一次')
  noteTerminal('terminal:status', { id: 't_selfcheck', state: 'exited' })
  await new Promise((resolve) => server.close(resolve))
  console.log('test-script-launch: 通過（含真實本機服務）')
}
checkTerminal().catch((error) => { console.error(error); process.exitCode = 1 })
