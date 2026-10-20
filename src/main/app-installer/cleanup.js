'use strict'

const path = require('path')
const fs = require('../raw-fs')
const { run, powershellPath, failure } = require('./winget')
const { commandFile, missingUninstaller } = require('./inventory')

const quote = (value) => `'${String(value).replace(/['\u2018-\u201b]/g, '$&$&')}'`

function cleanupScript(target, backup) {
  if (!/^HKEY_(?:LOCAL_MACHINE|CURRENT_USER)\\Software\\(?:WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^\\\r\n]+$/i.test(target.registryPath || '')) {
    throw failure('INVALID', '無效的安裝紀錄。')
  }
  const file = commandFile(target.quietUninstall || target.uninstall)
  if (!/^[a-z]:\\/i.test(file)) throw failure('INVALID', '無法確認解除安裝程式。')
  return `$ErrorActionPreference='Stop'
$key=${quote(`Registry::${target.registryPath}`)}
$p=Get-ItemProperty -LiteralPath $key
if ([string]$p.DisplayName -cne ${quote(target.name)} -or [string]$p.DisplayVersion -cne ${quote(target.registryVersion)} -or [string]$p.UninstallString -cne ${quote(target.uninstall)} -or [string]$p.QuietUninstallString -cne ${quote(target.quietUninstall)}) { throw 'STALE' }
if (!(Test-Path -LiteralPath ${quote(path.parse(file).root)}) -or (Test-Path -LiteralPath ${quote(file)})) { throw 'NOT_MISSING' }
if (@(Get-ChildItem -LiteralPath $key).Count -ne 0) { throw 'HAS_CHILDREN' }
$reg=Join-Path $env:SystemRoot 'System32\\reg.exe'
& $reg export ${quote(target.registryPath)} ${quote(backup)} /y | Out-Null
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath ${quote(backup)})) { throw 'BACKUP_FAILED' }
Remove-Item -LiteralPath $key -ErrorAction Stop`
}

async function cleanupRecord(target, cacheDir, execute = run) {
  if (!target.missingUninstaller || !await missingUninstaller(target)) throw failure('STALE', '安裝紀錄已變更，請重新整理。')
  const dir = path.join(cacheDir, 'registry-backups')
  await fs.promises.mkdir(dir, { recursive: true })
  const backup = path.join(dir, `${Date.now()}-${require('crypto').randomUUID()}.reg`)
  const script = cleanupScript(target, backup)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
  // 只提升清理這一筆紀錄的子程序；拒絕 UAC 時保留原紀錄。
  const outer = target.scope === 'machine'
    ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${quote(powershellPath())} -ArgumentList ${quote(args.join(' '))} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`]
    : args
  const result = await execute(powershellPath(), outer, { timeout: 0 })
  if (result.code !== 0) throw failure('CLEANUP_FAILED', '紀錄未清除：可能未授權、備份失敗或紀錄已變更。請重新整理後確認。')
  return result
}

module.exports = { cleanupRecord, cleanupScript }
