'use strict'

const fs = require('fs')
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
  const args = [action, '--id', target.id, '--exact', '--silent', '--disable-interactivity', '--accept-source-agreements']
  if (action !== 'uninstall') args.push('--accept-package-agreements')
  if (target.source) args.push('--source', target.source)
  return args
}

// 已安裝程式的圖示：登錄檔 DisplayIcon／MSI ProductIcon／安裝資料夾主程式／移除程式，
// Store／MSIX 套件用套件 logo；都沒有就用 Windows Installer 的通用圖示。
const ICON_SCRIPT = String.raw`[Console]::OutputEncoding=[Text.Encoding]::UTF8
$keys = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { 'R',$_.DisplayName,$_.PSChildName,$_.DisplayIcon,$_.InstallLocation,$_.UninstallString -join [char]9 }
Get-ItemProperty 'HKLM:\Software\Classes\Installer\Products\*' -ErrorAction SilentlyContinue | Where-Object { $_.ProductName -and $_.ProductIcon } | ForEach-Object { 'R',$_.ProductName,'',$_.ProductIcon,'','' -join [char]9 }
try {
  $null = [Windows.Management.Deployment.PackageManager, Windows.Management.Deployment, ContentType = WindowsRuntime]
  foreach ($p in (New-Object Windows.Management.Deployment.PackageManager).FindPackagesForUser('')) {
    $name = ''; $logo = ''
    try { $name = $p.DisplayName } catch {}
    try { $logo = $p.Logo.LocalPath } catch {}
    'A',$name,$p.Id.FullName,$logo -join [char]9
  }
} catch {}`
const GENERIC_ICON = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe')

const fileOf = (raw) => (raw || '').trim().replace(/^"([^"]+)".*$/, '$1').replace(/,\s*-?\d+$/, '')
const isIconFile = (file) => /^[a-z]:\\.+\.(?:exe|ico|dll)$/i.test(file)

// 沒有 DisplayIcon（常見於 MSI）時，從安裝資料夾挑名稱最像的主程式。
function mainExe(location, name) {
  if (!/^[a-z]:\\/i.test(location)) return ''
  const word = name.toLowerCase().split(/\s+/)[0]
  for (const dir of [location, path.join(location, 'bin')]) {
    let files
    try { files = fs.readdirSync(dir).filter((file) => /\.exe$/i.test(file) && !/unins|setup|update|crash|helper/i.test(file)) } catch { continue }
    const pick = files.find((file) => file.toLowerCase().startsWith(word)) || (files.length === 1 ? files[0] : '')
    if (pick) return path.join(dir, pick)
  }
  return ''
}

// 套件 logo 常只寫基本名，實際檔案帶 scale-100／targetsize-48 等後綴
function packageLogo(file) {
  if (!/^[a-z]:\\.+\.png$/i.test(file)) return ''
  if (fs.existsSync(file)) return file
  const dir = path.dirname(file), base = path.basename(file, '.png').toLowerCase()
  let files
  try { files = fs.readdirSync(dir) } catch { return '' }
  const variants = files.filter((name) => name.toLowerCase().startsWith(`${base}.`) && name.toLowerCase().endsWith('.png') && !/contrast|altform-unplated_contrast/i.test(name))
  const pick = variants.find((name) => /scale-200|targetsize-48\b/i.test(name)) || variants.find((name) => /scale-100|targetsize-32\b/i.test(name)) || variants[0]
  return pick ? path.join(dir, pick) : ''
}

// 開始功能表捷徑（.lnk 的圖示就是目標程式的圖示），補 MSI 沒寫圖示的工具，例如 Node.js
function startMenuLinks() {
  const roots = [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
  const links = []
  const walk = (dir, depth) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (item.isDirectory() && depth < 2) walk(path.join(dir, item.name), depth + 1)
      else if (/\.lnk$/i.test(item.name) && !/uninstall|解除安裝|readme|documentation|website|help/i.test(item.name)) {
        links.push({ name: item.name.slice(0, -4).toLowerCase(), folder: path.basename(dir).toLowerCase(), file: path.join(dir, item.name) })
      }
    }
  }
  for (const root of roots) walk(root, 0)
  return links
}

function linkFor(links, name) {
  const lower = name.toLowerCase().replace(/[…\u2026]$/, '').trim()
  const short = lower.split(/\s+/).slice(0, 2).join(' ')
  if (short.length < 3) return ''
  return (links.find((link) => link.name === lower) || links.find((link) => link.name.startsWith(short)) ||
    links.find((link) => link.folder.startsWith(short) && link.name.startsWith(short.split(' ')[0])))?.file || ''
}

function registryIcon(entry) {
  const icon = fileOf(entry.icon)
  if (isIconFile(icon)) return icon
  const exe = mainExe(entry.location, entry.name)
  if (exe) return exe
  const uninstaller = fileOf(entry.uninstall)
  return isIconFile(uninstaller) && !/msiexec/i.test(uninstaller) ? uninstaller : ''
}

function parseIcons(text) {
  const byName = new Map(), byKey = new Map(), packages = new Map(), packageNames = new Map(), names = []
  for (const line of text.split(/\r?\n/)) {
    const [kind, name = '', key = '', icon = '', location = '', uninstall = ''] = line.split('\t').map((part) => part.trim())
    if (kind === 'A') {
      const logo = packageLogo(icon)
      if (!logo) continue
      packages.set(key.toLowerCase(), logo)
      if (name && !/^ms-resource:/i.test(name) && !packageNames.has(name)) packageNames.set(name, logo)
      continue
    }
    if (kind !== 'R' || !name) continue
    const file = registryIcon({ name, icon, location, uninstall })
    if (key && file) byKey.set(key.toLowerCase(), file)
    if (!file || byName.has(name)) continue
    byName.set(name, file)
    names.push(name)
  }
  const links = startMenuLinks()
  return (row) => {
    const id = String(row.id || '')
    const name = String(row.name || '')
    const key = /^ARP\\/i.test(id) ? id.split('\\').pop().toLowerCase() : ''
    const prefix = String(row.name || '').replace(/[…\u2026]$/, '').trim()
    return (/^MSIX\\/i.test(id) && packages.get(id.slice(5).toLowerCase())) || (key && byKey.get(key)) || byName.get(name) || packageNames.get(name) ||
      (prefix.length >= 4 && byName.get(names.find((item) => item.startsWith(prefix)))) || linkFor(links, name) || GENERIC_ICON
  }
}

async function displayIcons() {
  const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', ICON_SCRIPT], { timeout: 60000 })
  return parseIcons(result.output)
}

module.exports = { failure, run, runPty, displayIcons, parseIcons, wingetPath, powershellPath, parseList, list, actionArgs }
