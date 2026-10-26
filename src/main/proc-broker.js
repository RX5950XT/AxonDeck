'use strict'

/**
 * main 這邊的入口：把 spawn 丟給 utilityProcess（見 proc-broker-child.js 為什麼）。
 * 沒有 Electron（node 跑的測試）或 broker 起不來時，退回在本程序開。
 */

const path = require('node:path')
const { runLocal } = require('./proc-broker-child')

let broker = null
let nextId = 0
/** @type {Map<number, (result: any) => void>} */
const pending = new Map()

function failAll() {
  for (const resolve of pending.values()) resolve({ code: -1, stdout: '', stderr: '', error: 'SPAWN' })
  pending.clear()
}

function getBroker() {
  if (broker) return broker
  let utilityProcess
  try {
    ;({ utilityProcess } = require('electron'))
  } catch {
    return null
  }
  if (!utilityProcess?.fork) return null
  try {
    const child = utilityProcess.fork(path.join(__dirname, 'proc-broker-child.js'), [], { serviceName: 'AxonDeck Process Broker' })
    child.on('message', ({ id, result } = {}) => {
      const resolve = pending.get(id)
      if (!resolve) return
      pending.delete(id)
      resolve(result)
    })
    // 掛掉就讓等著的人失敗，下一次呼叫再開一個新的
    child.on('exit', () => {
      if (broker === child) broker = null
      failAll()
    })
    broker = child
  } catch {
    return null
  }
  return broker
}

/**
 * @param {{ file: string, args: string[], cwd?: string, env?: Record<string, string>, input?: string, maxChars?: number, timeoutMs: number }} req
 *   env 只放要「加在 process.env 上」的那幾個
 * @returns {Promise<{ code: number, stdout: string, stderr: string, truncated?: boolean, error?: 'SPAWN' | 'TIMEOUT' }>}
 */
function runProcess(req) {
  const child = getBroker()
  if (!child) return runLocal(req)
  return new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    try {
      child.postMessage({ id, req })
    } catch {
      pending.delete(id)
      resolve(runLocal(req))
    }
  })
}

/**
 * `child_process.execFile` 的替身（只支援文字輸出、callback 形式），換掉跑完就結束的那種指令用。
 * 錯誤的樣子跟 execFile 一樣：非 0 結束 `error.code` 是結束碼、逾時 `killed`、超量 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`。
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, timeout?: number, maxBuffer?: number }} options
 * @param {(error: any, stdout: string, stderr: string) => void} callback
 */
function execFile(file, args, options, callback) {
  const opts = options || {}
  void runProcess({
    file,
    args,
    cwd: opts.cwd,
    env: opts.env,
    replaceEnv: !!opts.env,
    maxChars: opts.maxBuffer || 1024 * 1024,
    timeoutMs: opts.timeout > 0 ? opts.timeout : 10 * 60 * 1000
  }).then((res) => {
    let error = null
    if (res.error === 'SPAWN') error = Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
    else if (res.error === 'TIMEOUT') error = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM', code: null })
    else if (res.truncated) error = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    else if (res.code !== 0) error = Object.assign(new Error(`Command failed: ${file}`), { code: res.code })
    callback(error, res.stdout, res.stderr)
  })
}

/** promisify(execFile) 的替身：成功回 `{ stdout, stderr }`，失敗丟上面那種錯誤（附 stdout／stderr）。 */
function execFileAsync(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

module.exports = { runProcess, execFile, execFileAsync }
