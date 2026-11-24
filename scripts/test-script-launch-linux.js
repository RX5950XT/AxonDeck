#!/usr/bin/env node
'use strict'

/**
 * Linux：專案腳本「在終端機執行」產生的是 bash 指令（export＋cd＋bash），不是 PowerShell；
 * 實際丟給 bash 跑一次，確認環境變數、工作目錄、單引號與中文路徑都對。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('node:module')
const { execFileSync } = require('child_process')
const { tempDir, removeTree } = require('./lib/test-temp')
const launch = require('../src/main/script-launch')

async function main() {
  assert.equal(launch.shellAssign('K', "a'b", 'win32'), "$env:K='a''b'", 'Windows 維持 PowerShell 寫法')
  assert.equal(launch.shellAssign('K', "a'b", 'linux'), "export K='a'\\''b'")
  if (process.platform === 'win32') {
    console.log('test-script-launch-linux: skipped on Windows')
    return
  }
  const root = tempDir('script-linux-')
  const dir = path.join(root, "中文 it's")
  fs.mkdirSync(dir)
  const file = path.join(dir, 'dev.sh')
  fs.writeFileSync(file, 'echo "P=$AXONDECK_PROJECT R=$AXONDECK_SCRIPT_RUN D=$(pwd) E=${ELECTRON_RUN_AS_NODE:-none}"\n')
  const load = Module._load
  Module._load = function (name, ...args) {
    return name === 'electron' ? { app: { isPackaged: true, getPath: () => root } } : load.call(this, name, ...args)
  }
  try {
    const command = await launch.terminalCommand(file, 'w_parent', 't_selfcheck')
    assert.doesNotMatch(command, /powershell|\$env:|EncodedCommand/i, '不送 PowerShell 指令到 bash')
    const out = execFileSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim()
    assert.equal(out, `P=w_parent R=t_selfcheck D=${dir} E=none`)
    for (const ext of ['cmd', 'bat', 'ps1']) {
      const other = path.join(dir, `x.${ext}`)
      fs.writeFileSync(other, '')
      await assert.rejects(() => launch.terminalCommand(other, 'w_parent', 't'), (error) => /\.sh/.test(error.userMessage))
    }
  } finally {
    Module._load = load
    removeTree(root)
  }
  console.log('test-script-launch-linux: all passed')
  process.exit(0)
}

main().catch((error) => { console.error(error); process.exit(1) })
