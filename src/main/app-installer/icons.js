'use strict'

const fs = require('../raw-fs')
const path = require('path')
const { run, powershellPath } = require('./winget')

const ICON_SCRIPT = String.raw`[Console]::OutputEncoding=[Text.Encoding]::UTF8
$keys = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { 'R',$_.DisplayName,$_.PSChildName,$_.DisplayIcon,$_.InstallLocation,$_.UninstallString -join [char]9 }
Get-ItemProperty 'HKLM:\Software\Classes\Installer\Products\*','HKCU:\Software\Classes\Installer\Products\*' -ErrorAction SilentlyContinue | Where-Object { $_.ProductName -and $_.ProductIcon } | ForEach-Object { 'R',$_.ProductName,'',$_.ProductIcon,'','' -join [char]9 }
try {
  $null = [Windows.Management.Deployment.PackageManager, Windows.Management.Deployment, ContentType = WindowsRuntime]
  foreach ($p in (New-Object Windows.Management.Deployment.PackageManager).FindPackagesForUser('')) {
    $name = ''; $logo = ''
    try { $name = $p.DisplayName } catch {}
    try { $logo = $p.Logo.LocalPath } catch {}
    'A',$name,$p.Id.FullName,$logo -join [char]9
  }
} catch {}`

function iconLocation(raw) {
  const expanded = String(raw || '').replace(/%([^%]+)%/g, (_, key) => process.env[key] || '')
  const match = expanded.trim().match(/^(?:"([^"]+)"|(.+?))(?:,\s*(-?\d+))?$/)
  return { file: (match?.[1] || match?.[2] || '').trim(), index: Number(match?.[3] || 0) }
}
const supported = (file) => /^[a-z]:\\.+\.(?:exe|ico|dll|png)$/i.test(file)
const genericFile = (file) => /^(?:unins.*\.exe)$/.test(path.basename(file).toLowerCase()) || /^(?:msiexec|rundll32|cmd|powershell|pwsh|conhost|shell32|imageres)\.(?:exe|dll)$/i.test(path.basename(file))
const keyOf = ({ file, index }) => index ? `${file},${index}` : file

async function existing(raw) {
  const candidate = iconLocation(raw)
  if (!supported(candidate.file) || genericFile(candidate.file)) return ''
  try { return (await fs.promises.stat(candidate.file)).isFile() ? keyOf(candidate) : '' } catch { return '' }
}

async function mainExe(location, name) {
  if (!/^[a-z]:\\/i.test(location)) return []
  const word = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const queue = [{ dir: location, depth: 0 }], found = []
  let visited = 0
  while (queue.length && visited++ < 40) {
    const { dir, depth } = queue.shift()
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.slice(0, 300)) {
      if (entry.isDirectory() && depth < 4 && !/^(?:node_modules|resources|locales|cache|\.git)$/i.test(entry.name)) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      if (entry.isFile() && /\.exe$/i.test(entry.name) && !/unins|setup|update|crash|helper|report|service|host|redist/i.test(entry.name)) {
        const base = entry.name.slice(0, -4).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
        found.push({ file: path.join(dir, entry.name), score: word.startsWith(base) || base.startsWith(word) ? 0 : 1, depth })
      }
    }
  }
  return found.filter((item) => item.score === 0 || found.length === 1).sort((a, b) => a.depth - b.depth).slice(0, 6).map((item) => item.file)
}

async function packageLogo(file) {
  if (!/^[a-z]:\\.+\.png$/i.test(file)) return ''
  if (await existing(file)) return file
  let files
  try { files = await fs.promises.readdir(path.dirname(file)) } catch { return '' }
  const base = path.basename(file, path.extname(file)).toLowerCase()
  const variants = files.filter((name) => name.toLowerCase().startsWith(`${base}.`) && /\.png$/i.test(name) && !/contrast/i.test(name))
  const pick = variants.find((name) => /scale-200|targetsize-48\b/i.test(name)) || variants.find((name) => /scale-100|targetsize-32\b/i.test(name)) || variants[0]
  return pick ? path.join(path.dirname(file), pick) : ''
}

async function startMenuLinks() {
  const roots = [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
  const links = [], queue = roots.map((dir) => ({ dir, depth: 0 }))
  while (queue.length) {
    const { dir, depth } = queue.shift()
    let items
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const item of items) {
      if (item.isDirectory() && depth < 3) queue.push({ dir: path.join(dir, item.name), depth: depth + 1 })
      else if (/\.lnk$/i.test(item.name) && !/uninstall|解除安裝|readme|documentation|website|help/i.test(item.name)) {
        links.push({ name: item.name.slice(0, -4).toLowerCase(), folder: path.basename(dir).toLowerCase(), file: path.join(dir, item.name) })
      }
    }
  }
  return links
}

function linkFor(links, name) {
  const lower = name.toLowerCase().replace(/[…\u2026]$/, '').replace(/\s+(?:version\s+)?v?\d+(?:\.\d+).*$/, '').trim(), short = lower.split(/\s+/).slice(0, 2).join(' ')
  if (short.length < 3) return []
  return links.filter((link) => link.name === lower || link.name.startsWith(short) ||
    (link.folder.startsWith(short) && link.name.startsWith(short.split(' ')[0]))).map((link) => link.file)
}

async function shortcutIcons(file) {
  try {
    const link = require('electron').shell.readShortcutLink(file)
    return [await existing(keyOf({ file: link.icon || '', index: link.iconIndex || 0 })), await existing(link.target)].filter(Boolean)
  } catch { return [] }
}

async function parseIcons(text, links = []) {
  const byName = new Map(), byKey = new Map(), packages = new Map(), executables = new Map()
  for (const line of text.split(/\r?\n/)) {
    const [kind, name = '', key = '', icon = '', location = ''] = line.split('\t').map((part) => part.trim())
    if (kind === 'A') {
      const logo = await packageLogo(icon)
      if (logo) { packages.set(key.toLowerCase(), [logo]); if (name && !/^ms-resource:/i.test(name)) byName.set(name, [logo]) }
    } else if (kind === 'R' && name) {
      const candidates = [await existing(icon)].filter(Boolean)
      executables.set(name, [...(executables.get(name) || []), ...await mainExe(location, name)])
      byName.set(name, [...(byName.get(name) || []), ...candidates])
      if (key) byKey.set(key.toLowerCase(), [...(byKey.get(key.toLowerCase()) || []), ...candidates])
    }
  }
  const resolvedLinks = new Map()
  for (const link of links) resolvedLinks.set(link.file, await shortcutIcons(link.file))
  return (row) => {
    const id = String(row.id || ''), name = String(row.name || '')
    const key = String(row.productCode || (/^ARP\\/i.test(id) ? id.split('\\').pop() : '')).toLowerCase()
    const packageKey = String(row.packageFullName || (/^MSIX\\/i.test(id) ? id.slice(5) : '')).toLowerCase()
    const prefix = name.replace(/[…\u2026]$/, '').trim()
    const names = [...byName.keys()].filter((item) => prefix.length >= 4 && /[…\u2026]$/.test(name) && item.startsWith(prefix))
    return [...new Set([...(row.icon ? [keyOf(iconLocation(row.icon))] : []), ...(packages.get(packageKey) || []), ...(byKey.get(key) || []), ...(byName.get(name) || []),
      ...names.flatMap((item) => byName.get(item)), ...linkFor(links, name).flatMap((file) => resolvedLinks.get(file) || []),
      ...(executables.get(name) || [])])]
  }
}

let genericImages
function sameIcon(a, b) {
  if (!a || !b || a.isEmpty() || b.isEmpty()) return false
  const left = a.resize({ width: 32, height: 32 }).toBitmap(), right = b.resize({ width: 32, height: 32 }).toBitmap()
  return left.length === right.length && left.every((value, i) =>
    (i % 4 !== 3 && left[i - i % 4 + 3] === 0 && right[i - i % 4 + 3] === 0) || Math.abs(value - right[i]) <= 4)
}
async function readIcon(raw) {
  if (!await existing(raw)) return null
  const { app, nativeImage } = require('electron'), shell = require('../explorer/shell')
  const { file, index } = iconLocation(raw)
  let image
  if (/\.(?:png|ico)$/i.test(file)) {
    image = nativeImage.createFromPath(file)
    if (image.isEmpty() && /\.ico$/i.test(file)) {
      const url = await shell.extractIconOf(file, index)
      if (url) image = nativeImage.createFromDataURL(url)
    }
  }
  else {
    const url = await shell.extractIconOf(file, index)
    image = url ? nativeImage.createFromDataURL(url) : null
  }
  if (!image || image.isEmpty() || !image.toBitmap().some((value, i) => i % 4 === 3 && value > 0)) return null
  genericImages ||= Promise.all([
    shell.genericIconOf().then((url) => nativeImage.createFromDataURL(url)),
    app.getFileIcon(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe'), { size: 'large' }),
    app.getFileIcon('.axondeck-missing-generic.exe', { size: 'large' }),
  ].map((result) => result.catch(() => null)))
  return (await genericImages).some((generic) => sameIcon(image, generic)) ? null : image
}
async function displayIcons() {
  const [result, links] = await Promise.all([run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', ICON_SCRIPT], { timeout: 60000 }), startMenuLinks()])
  return parseIcons(result.output, links)
}
module.exports = { displayIcons, parseIcons, readIcon, iconLocation, mainExe, sameIcon }
