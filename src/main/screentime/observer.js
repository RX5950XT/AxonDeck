'use strict'

/**
 * 前景視窗觀測：常駐子程序每秒吐一列 JSON。優先用 axondeck-probe.exe（Rust），
 * 沒建置才退回 PowerShell；打包後 .ps1 在 asar 裡，powershell.exe 執行不了，路徑要換成 app.asar.unpacked。
 */

const { spawn } = require('child_process')
const path = require('path')
const { probeCommand } = require('../native-probe')

const RESTART_MIN_MS = 2000
const RESTART_MAX_MS = 60_000

function resolveScript(baseDir = __dirname) {
  const script = path.join(baseDir, 'observer.ps1')
  const asarSegment = `${path.sep}app.asar${path.sep}`
  return script.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
}

/**
 * @param {{ onTick: (info: { name: string, path: string, pid: number, idleMs: number }) => void, spawnFn?: typeof spawn }} deps
 */
function createObserver(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const onTick = deps.onTick || (() => {})
  /** @type {import('child_process').ChildProcess | null} */
  let child = null
  let buf = ''
  /** 呼叫端要它跑著（start 之後、stop 之前） */
  let wanted = false
  /** @type {NodeJS.Timeout | null} */
  let restartTimer = null
  let restartMs = RESTART_MIN_MS

  function start() {
    wanted = true
    if (child) return
    buf = ''
    try {
      const cmd = probeCommand('observer', resolveScript())
      child = spawnFn(cmd.file, cmd.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      child = null
      return
    }
    const proc = child
    const failed = () => { if (child === proc) stop() }
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => { if (child === proc) onData(chunk) })
    proc.stderr.resume()
    proc.stdin.on('error', failed)
    proc.on('error', failed)
    proc.on('exit', () => {
      if (child !== proc) return
      child = null
      // 沒人叫它停卻自己死了：不重啟的話使用時長會從此靜靜停掉，直到重開 App
      if (!wanted) return
      restartTimer = setTimeout(() => { restartTimer = null; if (wanted) start() }, restartMs)
      restartTimer.unref?.()
      restartMs = Math.min(restartMs * 2, RESTART_MAX_MS)
    })
  }

  function onData(chunk) {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line.startsWith('{')) {
        try {
          const row = JSON.parse(line)
          restartMs = RESTART_MIN_MS // 有在正常吐資料，下次意外結束從最短的等待重來
          onTick({
            name: String(row.name || row.Name || ''),
            path: String(row.path || row.Path || ''),
            pid: Number(row.pid || row.Pid) || 0,
            idleMs: Number(row.idleMs || row.IdleMs) || 0
          })
        } catch { /* 壞列丟掉 */ }
      }
      nl = buf.indexOf('\n')
    }
  }

  function stop() {
    wanted = false
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    const proc = child
    child = null
    if (!proc) return
    try { proc.stdin.end() } catch { /* 已關 */ }
    try { proc.kill() } catch { /* 已死 */ }
  }

  return {
    start,
    stop,
    get running() { return Boolean(child) }
  }
}

module.exports = { createObserver, resolveScript }
