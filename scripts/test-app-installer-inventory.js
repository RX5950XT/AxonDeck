'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const { mergeInventory, commandFile, missingUninstaller } = require('../src/main/app-installer/inventory')
const { cleanupRecord, cleanupScript } = require('../src/main/app-installer/cleanup')
const { actionArgs, run, powershellPath } = require('../src/main/app-installer/winget')
const { createInstaller } = require('../src/main/app-installer')

async function main() {
  const rows = [1, 2].map(() => ({ id: 'Microsoft.DirectX', name: 'DirectX', version: '9' }))
  const records = ['x64', 'x86'].map((architecture) => ({ kind: 'msix', name: 'DirectX', version: '9', architecture, scope: 'user', packageFullName: `DirectX_9_${architecture}__test`, framework: true }))
  const merged = mergeInventory(rows, records)
  assert.equal(merged.length, 2)
  assert.notEqual(merged[0].identity, merged[1].identity)
  assert.deepEqual(merged.map((x) => x.architecture), ['x64', 'x86'])
  assert.equal(mergeInventory(rows.slice(0, 1), records)[0].packageFullName, undefined, 'ambiguous names never guess a target')
  const edgeRows = [{ name: 'Edge', id: 'Microsoft.Edge', version: '2' }, { name: 'Edge', id: 'MSIX\\Edge_1_x64__test', version: '1' }]
  assert.equal(mergeInventory(edgeRows, [{ name: 'Edge', kind: 'registry', version: '2', registryPath: 'edge-registry' },
    { name: 'Edge', kind: 'msix', version: '1', packageFullName: 'Edge_1_x64__test' }]).length, 2, 'desktop and packaged apps remain separate')
  const sdk = { kind: 'registry', name: '.NET SDK 8.0.425 (x64)', version: '8.4.2526', productCode: '{SDK}', registryPath: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SDK', scope: 'machine', architecture: 'x64' }
  const sdkRows = mergeInventory([{ name: sdk.name, id: 'SDK.8', version: '8.0.425' }], [sdk])
  assert.equal(sdkRows[0].productCode, '{SDK}')
  const args = actionArgs('uninstall', sdkRows[0])
  assert.equal(args[args.indexOf('--product-code') + 1], '{SDK}')
  assert.equal(args[args.indexOf('--version') + 1], '8.0.425')
  assert.ok(!args.includes('--all'))
  assert.ok(!actionArgs('upgrade', sdkRows[0]).includes('--version'), 'upgrade must not pin old version')

  let live = rows, entries = records, called = []
  const service = createInstaller({ cacheDir: 'unused', list: async () => live, records: async () => entries,
    resolveSource: async () => ({}), iconPaths: async () => () => [], runCommand: async (_file, args) => {
      called.push(args); live = rows.slice(1); entries = records.slice(1); return { code: 0 }
    } })
  await service.refresh()
  const installed = service.snapshot().installed
  assert.ok(installed.every((x) => x.canUninstall))
  assert.equal(new Set(installed.map((x) => x.key)).size, 2)
  service.start({ action: 'uninstall', key: installed[0].key })
  for (let i = 0; service.busy() && i < 100; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.snapshot().jobs.at(-1).phase, 'done')
  assert.ok(called[0].at(-1).includes("'DirectX_9_x64__test'"))
  assert.equal(service.snapshot().installed[0].architecture, 'x86')

  const dir = tempDir('installer-inventory-'), absent = path.join(dir, 'missing.exe')
  const stale = { ...sdk, name: "QA O'Brien", registryVersion: '1', uninstall: `"${absent}" /uninstall`, quietUninstall: '', missingUninstaller: true }
  assert.equal(commandFile(stale.uninstall), absent)
  assert.equal(await missingUninstaller(stale), true)
  const script = cleanupScript(stale, path.join(dir, 'backup.reg'))
  assert.ok(script.includes("QA O''Brien"))
  assert.throws(() => cleanupScript({ ...stale, registryPath: 'HKEY_LOCAL_MACHINE\\Software' }, 'x'), /無效/)
  assert.throws(() => cleanupScript({ ...stale, registryPath: `${sdk.registryPath}\\child` }, 'x'), /無效/)
  await assert.rejects(cleanupRecord(stale, dir, async () => ({ code: 1 })), /未清除/)
  fs.writeFileSync(absent, 'restored')
  await assert.rejects(cleanupRecord(stale, dir, async () => { throw new Error('must not run') }), /變更/)
  if (process.platform === 'win32') await registryFixture(dir)
  console.log('PASS installer inventory: per-install identity, MSIX architecture, exact removal, ambiguity guard, cleanup validation and recovery')
}

async function registryFixture(dir) {
  const key = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AxonDeck-QA-${require('crypto').randomUUID()}`
  const ps = (script) => run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
  const quote = (text) => `'${text.replace(/'/g, "''")}'`
  const target = { name: 'AxonDeck QA fixture', registryPath: key, registryVersion: '1', scope: 'user',
    uninstall: `"${path.join(dir, 'qa-missing.exe')}"`, quietUninstall: '', missingUninstaller: true }
  const root = quote(`Registry::${key}`)
  try {
    assert.equal((await ps(`$ErrorActionPreference='Stop'; New-Item -Path ${root} -Force | Out-Null; Set-ItemProperty -LiteralPath ${root} -Name DisplayName -Value 'AxonDeck QA fixture'; Set-ItemProperty -LiteralPath ${root} -Name DisplayVersion -Value 'changed'; Set-ItemProperty -LiteralPath ${root} -Name UninstallString -Value ${quote(target.uninstall)}`)).code, 0)
    await assert.rejects(cleanupRecord(target, dir), /未清除/, 'changed registry must be preserved')
    assert.equal((await ps(`if (!(Test-Path -LiteralPath ${root})) { exit 1 }; Set-ItemProperty -LiteralPath ${root} -Name DisplayVersion -Value '1'`)).code, 0)
    await cleanupRecord(target, dir)
    assert.equal((await ps(`if (Test-Path -LiteralPath ${root}) { exit 1 }`)).code, 0)
    const backups = fs.readdirSync(path.join(dir, 'registry-backups')).filter((file) => file.endsWith('.reg'))
    assert.equal(backups.length, 1)
    assert.ok(fs.readFileSync(path.join(dir, 'registry-backups', backups[0])).toString('utf16le').includes('AxonDeck QA fixture'))
  } finally {
    await ps(`if (Test-Path -LiteralPath ${root}) { Remove-Item -LiteralPath ${root} -ErrorAction Stop }`)
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
