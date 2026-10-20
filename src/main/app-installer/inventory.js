'use strict'

const fs = require('../raw-fs')
const path = require('path')
const { run, powershellPath, failure } = require('./winget')

// 以原始安裝紀錄補 WinGet 的顯示清單；不把套件 ID 當成單一安裝實例。
const SCRIPT = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$items = @()
foreach ($root in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (!(Test-Path -LiteralPath $root)) { continue }
  foreach ($key in Get-ChildItem -LiteralPath $root) {
    $p = Get-ItemProperty -LiteralPath $key.PSPath
    if (!$p.DisplayName -or $p.SystemComponent -eq 1) { continue }
    $items += @{kind='registry';name=[string]$p.DisplayName;version=[string]$p.DisplayVersion;productCode=$key.PSChildName;registryPath=$key.Name;scope=$(if($root.StartsWith('HKCU:')){'user'}else{'machine'});architecture=$(if($root.Contains('WOW6432Node')){'x86'}else{'x64'});uninstall=[string]$p.UninstallString;quietUninstall=[string]$p.QuietUninstallString;icon=[string]$p.DisplayIcon;location=[string]$p.InstallLocation}
  }
}
$null = [Windows.Management.Deployment.PackageManager,Windows.Management.Deployment,ContentType=WindowsRuntime]
foreach ($p in (New-Object Windows.Management.Deployment.PackageManager).FindPackagesForUser('')) {
  $items += @{kind='msix';name=[string]$p.DisplayName;version=[string]$p.Id.Version.Major+'.'+$p.Id.Version.Minor+'.'+$p.Id.Version.Build+'.'+$p.Id.Version.Revision;packageFullName=[string]$p.Id.FullName;architecture=([string]$p.Id.Architecture).ToLowerInvariant();scope='user';framework=[bool]$p.IsFramework;signature=[string]$p.SignatureKind}
}
ConvertTo-Json -InputObject @($items) -Depth 3 -Compress`

function commandFile(command) {
  const text = String(command || '').replace(/%([^%]+)%/g, (all, key) => process.env[key] || all).trim()
  return text.match(/^"([^"]+\.exe)"/i)?.[1] || text.match(/^([a-z]:\\.*?\.exe)(?=\s|$)/i)?.[1] || ''
}

async function missingUninstaller(entry) {
  const file = commandFile(entry.quietUninstall || entry.uninstall)
  if (!file || !/^[a-z]:\\/i.test(file) || /\\msiexec\.exe$/i.test(file)) return false
  try { await fs.promises.stat(file); return false } catch (error) {
    if (error.code !== 'ENOENT') return false
    try { await fs.promises.stat(path.parse(file).root); return true } catch { return false }
  }
}

async function readInventory() {
  const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { timeout: 60000 })
  if (result.code !== 0) throw failure('SCAN_FAILED', '無法讀取完整安裝紀錄，請重新整理。')
  let entries
  try { entries = JSON.parse(result.output) } catch { throw failure('SCAN_FAILED', '安裝紀錄格式無法讀取。') }
  if (!Array.isArray(entries) || entries.some((x) => !x || !['registry', 'msix'].includes(x.kind) || typeof x.name !== 'string')) throw failure('SCAN_FAILED', '安裝紀錄格式無法讀取。')
  return Promise.all(entries.map(async (entry) => ({ ...entry, missingUninstaller: entry.kind === 'registry' && await missingUninstaller(entry) })))
}

function candidates(row, entries) {
  if (row.id.startsWith('MSIX\\')) return entries.filter((x) => x.packageFullName === row.id.slice(5))
  if (row.id.startsWith('ARP\\')) {
    const [, scope, architecture, ...key] = row.id.split('\\')
    return entries.filter((x) => x.productCode === key.join('\\') && x.scope === scope.toLowerCase() && x.architecture === architecture.toLowerCase())
  }
  const name = row.name.replace(/…$/, '').toLowerCase()
  const named = entries.filter((x) => x.name.toLowerCase() === name || (row.name.endsWith('…') && x.name.toLowerCase().startsWith(name)))
  const versioned = named.filter((x) => x.version === row.version || x.name.includes(row.version))
  return versioned.length ? versioned : named
}

function mergeInventory(rows, entries) {
  const result = [], used = new Set()
  for (const row of rows) {
    let matches = candidates(row, entries)
    const sameRows = rows.filter((x) => x.id === row.id && x.name === row.name && x.version === row.version)
    const group = rows.filter((x) => x.id === row.id && x.name === row.name)
    const packages = entries.filter((x) => x.kind === 'msix' && x.name === row.name)
    // WinGet 會把 MSIX 原始版本映射成行銷版本；整組完整對上時直接保留系統的版本與身分。
    const packageGroup = packages.length === group.length && packages.length > 0 && matches.every((x) => x.kind === 'msix') && group.every((x) => !x.available)
    if (packageGroup) matches = packages
    // 只有一一對應或同一組完全相同的列才展開，禁止用模糊名稱猜解除安裝目標。
    if (packageGroup || matches.length === 1 || (matches.length > 1 && matches.length === sameRows.length)) {
      for (const entry of matches) {
        const identity = entry.registryPath || entry.packageFullName
        if (used.has(identity)) continue
        used.add(identity)
        result.push({ ...row, ...entry, name: entry.name || row.name, version: entry.kind === 'msix' ? entry.version : row.version,
          registryVersion: entry.version, identity, truncated: false })
      }
    } else result.push({ ...row, identity: `${row.id}\0${row.version}\0${row.name}\0${result.filter((x) => x.id === row.id && x.name === row.name && x.version === row.version).length}` })
  }
  return visibleRows(result)
}

// 比照 Windows「已安裝的應用程式」：共用執行環境（x86／x64、多版本並存）由系統依需要保留與回收；
// 和傳統安裝同名的自簽 MSIX 是它的身分套件（Edge、Google App），解除安裝要走傳統那筆，不另列。
function visibleRows(rows) {
  const registry = new Set(rows.filter((x) => x.kind === 'registry').map((x) => x.name.toLowerCase()))
  return rows.filter((x) => !x.framework && !(x.kind === 'msix' && x.signature === 'Developer' && registry.has(x.name.toLowerCase())))
}

module.exports = { readInventory, mergeInventory, commandFile, missingUninstaller }
