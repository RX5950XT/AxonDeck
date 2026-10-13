'use strict'

const path = require('path')
const { spawn } = require('child_process')

function failure(code, userMessage) {
  return Object.assign(new Error(userMessage), { code, userMessage })
}

function run(file, args, { onOutput, timeout = 120000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', tooLarge = false, timedOut = false
    const timer = timeout ? setTimeout(() => { timedOut = true; child.kill() }, timeout) : null
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      if (output.length + text.length > 8 * 1024 * 1024) { tooLarge = true; child.kill(); return }
      output += text
      onOutput?.(text)
    })
    // 不把外部工具的原始錯誤或路徑送進 UI。
    child.stderr.resume()
    child.on('error', () => { clearTimeout(timer); reject(failure('TOOL_UNAVAILABLE', '無法啟動安裝工具，請重新整理後再試。')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut || tooLarge) reject(failure('SCAN_FAILED', '查詢逾時或資料過大，請稍後重新整理。'))
      else resolve({ code: code === null ? -1 : code >>> 0, output })
    })
  })
}

// 管線模式下 WinGet 不輸出進度；改用虛擬終端，讀它給工作列的 OSC 9;4 百分比。
// stallMs：下載階段（驗證雜湊之前）這麼久都沒有進度就放棄；安裝階段可能很久沒輸出，不計時。
function runPty(file, args, { onProgress, stallMs = 0 } = {}) {
  let pty
  try { pty = require('@lydell/node-pty') } catch { return run(file, args, { timeout: 0 }) }
  return new Promise((resolve, reject) => {
    let child, tail = '', last = '', changedAt = Date.now(), downloaded = false, stalled = false
    try { child = pty.spawn(file, args, { cols: 120, rows: 30, env: process.env }) }
    catch { reject(failure('TOOL_UNAVAILABLE', '無法啟動安裝工具，請重新整理後再試。')); return }
    const timer = stallMs ? setInterval(() => {
      if (downloaded || Date.now() - changedAt < stallMs) return
      stalled = true
      clearInterval(timer)
      child.kill()
    }, Math.min(30000, stallMs)) : null
    child.onData((text) => {
      tail = (tail + text).slice(-4096)
      const plain = tail.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      const percent = [...tail.matchAll(/\x1b\]9;4;(\d);(\d{1,3})/g)].at(-1)
      const size = [...plain.matchAll(/([\d.]+ [KMG]B) \/ ([\d.]+ [KMG]B)/g)].at(-1)
      const progress = { percent: percent && percent[1] === '1' ? Math.min(100, Number(percent[2])) : null, size: size ? `${size[1]} / ${size[2]}` : '' }
      if (/雜湊|installer hash|套件安裝|package install/i.test(plain)) downloaded = true
      const key = `${progress.percent}|${progress.size}`
      if (key !== last) { last = key; changedAt = Date.now() }
      onProgress?.(progress)
    })
    child.onExit(({ exitCode }) => { clearInterval(timer); resolve({ code: exitCode >>> 0, output: '', stalled }) })
  })
}

const wingetPath = () => path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe')
const powershellPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function cellWidth(char) {
  const c = char.codePointAt(0)
  if (/\p{Mark}/u.test(char) || c === 0x200d || c === 0xfe0f) return 0
  return c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe6f) ||
    (c >= 0xff01 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300) ? 2 : 1
}

function cells(text) {
  return [...text].flatMap((char) => cellWidth(char) === 2 ? [char, ''] : cellWidth(char) ? [char] : [])
}

function parseList(text) {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').split('\n')
  const separator = lines.findIndex((line) => /^-{10,}\s*$/.test(line))
  if (separator < 1) throw failure('FORMAT_CHANGED', '無法讀取 WinGet 清單，請確認 WinGet 可用後重新整理。')
  const header = lines[separator - 1]
  const columns = [...header.matchAll(/\S+(?: \S+)*?(?=\s{2,}|$)/g)].map((m) => cells(header.slice(0, m.index)).length)
  if (columns.length < 3 || columns.length > 5) throw failure('FORMAT_CHANGED', 'WinGet 清單格式不支援。')
  return lines.slice(separator + 1).flatMap((line) => {
    const row = cells(line)
    const values = columns.map((start, i) => row.slice(start, columns[i + 1]).join('').trim())
    const [name, id, version] = values
    if (!name || !id || !version) return []
    const tail = values.slice(3)
    const source = ['winget', 'msstore'].includes(tail.at(-1)) ? tail.at(-1) : ''
    const available = columns.length === 5 ? values[3] : ''
    return [{ name, id, version, available, source, truncated: /[…\u2026]/.test(id) }]
  })
}

async function list() {
  const result = await run(wingetPath(), ['list', '--accept-source-agreements', '--disable-interactivity'])
  if (result.code !== 0) throw failure('SCAN_FAILED', '無法取得已安裝清單，請確認網路與 WinGet 後重新整理。')
  return parseList(result.output)
}

function actionArgs(action, target) {
  if (!['install', 'upgrade', 'uninstall'].includes(action)) throw failure('INVALID', '不支援的操作。')
  const selector = action === 'uninstall' && target.productCode ? ['--product-code', target.productCode] : ['--id', target.id]
  const args = [action, ...selector, '--exact', '--silent', '--disable-interactivity', '--accept-source-agreements']
  if (action === 'uninstall' && target.version && !/^(Unknown|<)/i.test(target.version)) args.push('--version', target.version)
  if (target.scope) args.push('--scope', target.scope)
  if (action === 'upgrade' && /^(x86|x64|arm64)$/.test(target.architecture)) args.push('--architecture', target.architecture)
  if (action !== 'uninstall') args.push('--accept-package-agreements')
  if (target.source) args.push('--source', target.source)
  return args
}

module.exports = { failure, run, runPty, wingetPath, powershellPath, parseList, list, actionArgs }
