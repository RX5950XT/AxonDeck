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
  const args = [action, '--id', target.id, '--exact', '--silent', '--disable-interactivity', '--accept-source-agreements']
  if (action !== 'uninstall') args.push('--accept-package-agreements')
  if (target.source) args.push('--source', target.source)
  return args
}

module.exports = { failure, run, wingetPath, powershellPath, parseList, list, actionArgs }
