#!/usr/bin/env node
'use strict'

/**
 * v1.64.0 把專案搜尋、終端機認對話、Ctrl+G 抬窗、大資料夾與裝置清單改走 Windows 原生
 * （axondeck-probe.exe／殼層 sidecar）。Linux 沒有這些執行檔，必須照舊走 JS／/proc／gvfs：
 * - 大資料夾（> NATIVE_MIN_ENTRIES 項）listNative 回 null，listDir 照樣列齊、點開頭的畫淡
 * - 專案內容搜尋沒有 exe 時走 JS 逐檔比對
 * - 終端機認對話用 /proc 程序表（看得到自己）
 * - Ctrl+G 抬窗在 Linux 不做事（回 false，不 spawn PowerShell）
 * - 裝置清單走 mtp-linux（gvfs），不碰殼層 sidecar
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

async function bigFolder() {
  const { NATIVE_MIN_ENTRIES, listNative } = require('../src/main/explorer/list-native')
  const explorerFs = require('../src/main/explorer/fs')
  const dir = tempDir('native-fallback-dir-')
  try {
    const count = NATIVE_MIN_ENTRIES + 50
    for (let i = 0; i < count; i += 1) fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x')
    fs.writeFileSync(path.join(dir, '.hidden-rc'), 'x')
    fs.mkdirSync(path.join(dir, '.config'))
    assert.equal(await listNative(dir), null, 'Linux 沒有 axondeck-probe.exe：交回 JS 版')
    const listed = await explorerFs.listDir(dir, { showHidden: true, limit: 2000 })
    assert.equal(listed.total, count + 2, '大資料夾全部列出（含點開頭的）')
    const dot = listed.entries.find((entry) => entry.name === '.hidden-rc')
    const conf = listed.entries.find((entry) => entry.name === '.config')
    assert.equal(dot.hidden, true, 'Linux 點開頭的檔案標成隱藏（畫淡）')
    assert.equal(conf.hidden, true, 'Linux 點開頭的資料夾標成隱藏（畫淡）')
    assert.equal(listed.entries.find((entry) => entry.name === 'f0001.txt').hidden, false)
    assert.equal(explorerFs.isDotHidden('.git', 'win32'), false, 'Windows 不看點開頭')
    assert.equal(explorerFs.isDotHidden('.git', 'linux'), true)
  } finally {
    removeTree(dir)
  }
}

async function projectSearch() {
  const search = require('../src/main/workspace/search')
  const dir = tempDir('native-fallback-search-')
  try {
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const one = 1\nconst needleValue = 2\n')
    fs.writeFileSync(path.join(dir, 'Candy Circuit.wav'), '')
    const content = await search.search(dir, 'needleValue', false)
    assert.equal(content.hits.length, 1, '內容搜尋走 JS 版也找得到')
    assert.equal(content.hits[0].rel, 'src/a.js')
    assert.equal(content.hits[0].line, 2)
    const names = await search.search(dir, 'Candy', false, 'name')
    assert.ok(names.hits.some((hit) => hit.rel === 'Candy Circuit.wav'), '檔名搜尋照舊')
  } finally {
    removeTree(dir)
  }
}

async function terminalProcesses() {
  const agent = require('../src/main/terminal/agent-processes')
  const rows = await agent.linuxProcessSnapshot()
  assert.ok(rows.some((row) => row.ProcessId === process.pid && row.ParentProcessId === process.ppid), '/proc 程序表看得到自己')
}

function ctrlG() {
  const foreground = require('../src/main/terminal/foreground')
  assert.equal(foreground.raiseChildWindow(), false, 'Linux 不抬窗（沒有 PowerShell／raise-window）')
}

function devices() {
  // mtp 分支：Linux 分派搬進 mtp.js（非 Windows 時改用 mtp-linux 的 createLinuxMtp），不再問殼層 sidecar
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'explorer', 'mtp.js'), 'utf8')
  assert.match(src, /require\('\.\/mtp-linux'\)\.createLinuxMtp\(/, 'Linux 裝置清單走 mtp-linux')
  assert.match(src, /isLinux \? linuxMtp\(\) : windowsMtp/, 'Linux 用 mtp-linux，其餘照舊殼層版')
}

async function main() {
  if (process.platform === 'win32') {
    console.log('test-linux-native-fallbacks: skipped on Windows')
    return
  }
  await bigFolder()
  await projectSearch()
  await terminalProcesses()
  ctrlG()
  devices()
  console.log('test-linux-native-fallbacks: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
