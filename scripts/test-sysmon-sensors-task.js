'use strict'

/**
 * 感測器排程工作改名後的舊資料清理。
 * 不呼叫 schtasks、不提權：spawn 換成假的，只檢查那一次 UAC 裡的腳本。
 *
 * 用法：node scripts/test-sysmon-sensors-task.js
 */

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { tempDir } = require('./lib/test-temp')
const taskMod = require('../src/main/sysmon/sensors-task')

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** @returns {{ calls: { file: string, args: string[] }[], spawnFn: Function }} */
function fakeSpawn() {
  const calls = []
  function spawnFn(file, args) {
    calls.push({ file, args })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.kill = () => {}
    // 第一次是提權安裝；之後的查詢回「沒有這份工作」，避免空輸出被當成已安裝
    const code = calls.length === 1 ? 0 : 3
    process.nextTick(() => child.emit('close', code))
    return child
  }
  return { calls, spawnFn }
}

function elevatedScript(command) {
  const match = String(command).match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/)
  if (!match) return ''
  return Buffer.from(match[1], 'base64').toString('utf16le')
}

async function main() {
  console.log('\n[感測器排程工作改名]')
  ok('新工作名', taskMod.TASK_NAME === 'AxonDeck Sensors', String(taskMod.TASK_NAME))
  ok('舊工作名留成常數', taskMod.LEGACY_TASK_NAME === 'VoiceInk Sensors', String(taskMod.LEGACY_TASK_NAME))
  ok('舊目錄名留成常數', taskMod.LEGACY_DIR_NAME === 'VoiceInk Sensors', String(taskMod.LEGACY_DIR_NAME))
  ok('舊程序名留成常數', taskMod.LEGACY_PROCESS_NAME === 'VoiceInkSensors', String(taskMod.LEGACY_PROCESS_NAME))

  const root = process.env.ProgramW6432 || process.env.ProgramFiles || ''
  ok('測得到 64 位元 Program Files', root.length > 0)
  const legacyDir = root ? path.join(root, 'VoiceInk Sensors') : ''
  const newExe = root ? path.join(root, 'AxonDeck Sensors', 'AxonDeckSensors.exe') : ''

  const dir = tempDir('sensors-task-')
  const exe = path.join(dir, 'AxonDeckSensors.exe')
  fs.writeFileSync(exe, 'not-a-real-exe')

  const devCalls = fakeSpawn()
  const dev = taskMod.createSensorTask({
    spawnFn: devCalls.spawnFn, packaged: false, userDataPath: dir
  })
  let devCode = ''
  try {
    await dev.install(exe)
  } catch (err) {
    devCode = err && err.code
  }
  ok('開發版不提權、也不去刪舊工作', devCode === 'SYSMON_TASK_DEV' && devCalls.calls.length === 0, devCode)

  const { calls, spawnFn } = fakeSpawn()
  const task = taskMod.createSensorTask({ spawnFn, packaged: true, userDataPath: dir })
  let installed
  let installError = ''
  try {
    installed = await task.install(exe)
  } catch (err) {
    installError = err && (err.code || err.message)
  }
  ok('假的提權回 0 時安裝不丟錯', !installError, installError)
  ok('安裝後查詢走第二個行程，不是再提權一次', calls.length === 2, `calls=${calls.length}`)

  const outer = calls[0] ? String(calls[0].args[calls[0].args.length - 1]) : ''
  ok('整個安裝只跳一次 UAC', outer.split('-Verb RunAs').length - 1 === 1, outer.slice(0, 80))
  const script = elevatedScript(outer)
  ok('內層腳本解得開', script.includes('Register-ScheduledTask'), script.slice(0, 80))
  ok('內層不再自己提權', !script.includes('-Verb RunAs') && !script.includes('Start-Process'))

  const registerAt = script.indexOf("Register-ScheduledTask -TaskName 'AxonDeck Sensors'")
  const legacyAt = script.indexOf("Unregister-ScheduledTask -TaskName 'VoiceInk Sensors'")
  ok('註冊的是新工作名', registerAt >= 0)
  ok('同一段腳本會卸除舊工作', legacyAt >= 0)
  ok('舊工作排在新工作註冊之後', registerAt >= 0 && legacyAt > registerAt,
    `register=${registerAt} legacy=${legacyAt}`)
  ok('複製目的地是新目錄', newExe.length > 0 && script.includes(newExe))
  ok('舊目錄路徑在腳本裡', legacyDir.length > 0 && script.includes(legacyDir))
  ok('舊目錄是 reparse 就不要刪', script.includes('ReparsePoint') && script.includes('$legacy'))
  ok('舊目錄用 Remove-Item 且失敗不當錯誤',
    script.includes('Remove-Item -LiteralPath $legacy -Recurse -Force -ErrorAction SilentlyContinue'))
  ok('卸除舊工作失敗不當錯誤',
    script.includes("Unregister-ScheduledTask -TaskName 'VoiceInk Sensors' -Confirm:$false -ErrorAction SilentlyContinue"))
  ok('刪目錄前先停掉還在跑的舊 exe',
    script.includes("Get-Process -Name 'VoiceInkSensors' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"))
  const silentAt = script.lastIndexOf("$ErrorActionPreference='SilentlyContinue'")
  ok('清舊資料時改成略過錯誤', silentAt > registerAt && silentAt < legacyAt,
    `silent=${silentAt} register=${registerAt} legacy=${legacyAt}`)
  ok('查詢結果不會把沒裝當成已安裝', installed && installed.installed === false, JSON.stringify(installed))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
