'use strict'
// 專案腳本開瀏覽器改道：`node scripts/test-script-launch.js`
const assert = require('node:assert/strict')
const { urlArg, rewriteBatch, projectIdOf } = require('../src/main/script-launch')

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

console.log('test-script-launch: 通過')
