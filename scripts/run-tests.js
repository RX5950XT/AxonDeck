'use strict'

/**
 * 一次跑完 scripts/ 底下所有單元測試（`test-*.js`，純 node、不開視窗、不打真上游）。
 *
 *     node scripts/run-tests.js            # 全部
 *     node scripts/run-tests.js ccswitch   # 檔名含 ccswitch 的
 *
 * 一支一個子程序、各自逾時；最後列出失敗清單，有失敗就 exit 1。
 * e2e-*／probe-*／bench-* 要打包版、真硬體或真上游，不在這裡跑（見 AGENTS.md「驗證方式」）。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const TIMEOUT_MS = 180_000
const filter = process.argv[2] || ''
const files = fs.readdirSync(__dirname)
  .filter((name) => /^test-.+\.js$/.test(name) && name.includes(filter))
  .sort()

/** 檔頭寫「用法：npx electron …」的要在 Electron 裡跑（original-fs、app 之類） */
const needsElectron = (name) => /npx electron scripts\//.test(fs.readFileSync(path.join(__dirname, name), 'utf8').slice(0, 2000))
let electronExe = ''
const runnerFor = (name) => {
  if (!needsElectron(name)) return process.execPath
  if (!electronExe) electronExe = require('electron')
  return electronExe
}

const failed = []
for (const name of files) {
  const started = Date.now()
  const result = spawnSync(runnerFor(name), [path.join(__dirname, name)], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const ok = result.status === 0 && !result.error
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${seconds}s`)
  if (!ok) {
    failed.push(name)
    const tail = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-8).join('\n')
    console.log(result.error?.code === 'ETIMEDOUT' ? '      逾時' : tail.replace(/^/gm, '      '))
  }
}

console.log(`\n${files.length - failed.length}/${files.length} 支通過`)
if (failed.length) {
  console.log(`失敗：${failed.join('、')}`)
  process.exitCode = 1
}
