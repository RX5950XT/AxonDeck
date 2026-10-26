'use strict'

/**
 * 代開子程序（跑在 utilityProcess 裡，也可直接 require 在本程序跑）。
 *
 * Windows 的 CreateProcess 偶爾要 200ms 以上（防毒在掃新程序），而 Node 的 spawn 是同步的：
 * 在 main 開，整個 App 就跟著頓那麼久；Git 面板一次連開好幾個 git 會疊到快一秒。
 * 搬到這裡開，main 只等訊息。
 */

const { spawn } = require('node:child_process')

/**
 * @param {{ file: string, args: string[], cwd?: string, env?: Record<string, string>, replaceEnv?: boolean, input?: string, maxChars?: number, timeoutMs: number }} req
 * @returns {Promise<{ code: number, stdout: string, stderr: string, truncated?: boolean, error?: 'SPAWN' | 'TIMEOUT' }>}
 */
function runLocal(req) {
  return new Promise((resolve) => {
    const maxChars = Number.isFinite(req.maxChars) ? req.maxChars : Infinity
    let child
    try {
      child = spawn(req.file, req.args, {
        cwd: req.cwd,
        shell: false,
        windowsHide: true,
        // replaceEnv：照 execFile 的語意整份換掉（呼叫端可能刻意拿掉某些變數）
        env: req.replaceEnv ? req.env : { ...process.env, ...(req.env || {}) }
      })
    } catch {
      resolve({ code: -1, stdout: '', stderr: '', error: 'SPAWN' })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const kill = () => {
      try {
        child.kill()
      } catch {
        // 已經死了就算了
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish({ code: -1, stdout, stderr, error: 'TIMEOUT' })
    }, req.timeoutMs)
    if (typeof req.input === 'string') {
      // 對面先結束時 stdin 會 EPIPE，沒接住整個 process 會掛掉
      child.stdin.on('error', () => {})
      child.stdin.end(req.input)
    }
    // setEncoding 會把切在兩個 chunk 之間的中文字接回來，逐塊 toString 會變亂碼
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (done) return
      stdout += chunk
      if (stdout.length <= maxChars) return
      kill()
      finish({ code: 0, stdout: stdout.slice(0, maxChars), stderr, truncated: true })
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1 << 20) stderr += chunk
    })
    child.on('error', () => finish({ code: -1, stdout, stderr, error: 'SPAWN' }))
    child.on('close', (code) => finish({ code: code === null ? -1 : code, stdout, stderr }))
  })
}

if (process.parentPort) {
  process.parentPort.on('message', async ({ data }) => {
    const { id, req } = data || {}
    let result
    try {
      result = await runLocal(req)
    } catch {
      result = { code: -1, stdout: '', stderr: '', error: 'SPAWN' }
    }
    process.parentPort.postMessage({ id, result })
  })
}

module.exports = { runLocal }
