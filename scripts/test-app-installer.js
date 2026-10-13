'use strict'

const assert = require('assert/strict')
const { parseList, actionArgs } = require('../src/main/app-installer/winget')
const { createInstaller } = require('../src/main/app-installer')
const { newerVersion } = require('../src/main/app-installer/catalog')

const turn = () => new Promise((resolve) => setImmediate(resolve))
async function settle(service) {
  for (let i = 0; i < 100 && service.busy(); i++) await turn()
  assert.equal(service.busy(), false)
  return service.snapshot().jobs.at(-1)
}
async function main() {
  const header = 'Name                Id                  Version     Available   Source'
  const parsed = parseList(`${header}\n${'-'.repeat(70)}\n中文 App            Vendor.App          1.0         2.0         winget\nOther               ARP\\User\\X64\\X      3.0                     \n`)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0], { name: '中文 App', id: 'Vendor.App', version: '1.0', available: '2.0', source: 'winget', truncated: false })
  assert.equal(parsed[1].id, 'ARP\\User\\X64\\X')
  assert.equal(parsed[1].available, '')
  assert.throws(() => parseList('network error'), /WinGet/)
  const noUpdates = parseList('Name                Id                  Version     Source\n-----------------------------------------------------------\nSteam               Valve.Steam         1.0         winget\n')
  assert.equal(noUpdates[0].available, '')
  assert.equal(noUpdates[0].source, 'winget')
  assert.equal(newerVersion('02.08.2', '02.07.1'), true)
  assert.equal(newerVersion('1.2', '1.2.0'), false)
  assert.equal(newerVersion('1.2', 'Unknown'), false)
  const args = actionArgs('uninstall', { id: 'ARP\\User\\X64\\space name;evil', source: '' })
  assert.equal(args[2], 'ARP\\User\\X64\\space name;evil')
  assert.ok(args.includes('--silent'))
  assert.ok(!args.includes('--all'))
  assert.ok(!args.includes('--accept-package-agreements'))

  let rows = [{ name: 'Steam', id: 'Valve.Steam', version: '1.0', available: '2.0', source: 'winget' }]
  let calls = [], release, failScan = false
  const service = createInstaller({ cacheDir: 'unused', list: async () => {
    if (failScan) throw new Error('private diagnostic')
    return rows
  }, resolveSource: async () => ({ version: '1.0' }), run: async (_file, options) => {
    calls.push(options)
    await new Promise((resolve) => { release = resolve })
    return { code: 0 }
  }, install: async () => { throw new Error('private token') } })
  assert.throws(() => service.start({ action: 'install', key: 'epic' }), /查詢/)
  await service.refresh()
  const steam = service.snapshot().installed[0]
  assert.equal(steam.canUpgrade, true)
  assert.throws(() => service.start({ action: 'install', key: 'steam' }), /已安裝/)
  assert.throws(() => service.start({ action: 'install', key: '--override' }), /來源/)
  assert.throws(() => service.start({ action: 'uninstall', key: 'Valve.Steam' }), /清單/)
  service.start({ action: 'upgrade', key: steam.key })
  assert.equal(service.busy(), true)
  assert.throws(() => service.start({ action: 'uninstall', key: steam.key }), /進行中/)
  rows = [{ ...rows[0], version: '2.0', available: '' }]
  release()
  assert.equal((await settle(service)).phase, 'done')
  assert.equal(calls[0][0], 'upgrade')
  assert.equal(service.snapshot().installed[0].version, '2.0')
  service.start({ action: 'uninstall', key: service.snapshot().installed[0].key })
  rows = []
  release()
  assert.equal((await settle(service)).phase, 'done')
  assert.equal(service.snapshot().installed.length, 0)
  service.start({ action: 'install', key: 'freecad-tw' })
  const failed = await settle(service)
  assert.equal(failed.phase, 'failed')
  assert.ok(!failed.message.includes('private'))
  failScan = true
  await assert.rejects(service.refresh())
  assert.ok(!service.snapshot().scanError.includes('private'))
  failScan = false
  rows = [1, 2].map((version) => ({ name: 'Library', id: 'Same.Id', version: String(version) }))
  await service.refresh()
  assert.equal(service.snapshot().installed[0].canUninstall, false)
  assert.throws(() => service.start({ action: 'uninstall', key: service.snapshot().installed[0].key }), /無法/)
  let pack = ['A', 'B', 'C'].map((id) => ({ name: id, id: `X.${id}`, version: '1', available: id === 'C' ? '' : '2' }))
  const upgraded = []
  const batch = createInstaller({ cacheDir: 'unused', list: async () => pack, resolveSource: async () => ({}), run: async (_file, args) => {
    const id = args[args.indexOf('--id') + 1]
    upgraded.push(id)
    pack = pack.map((row) => row.id === id ? { ...row, version: '2', available: '' } : row)
    return { code: 0 }
  } })
  assert.throws(() => batch.upgradeAll(), /查詢/)
  await batch.refresh()
  assert.equal(batch.upgradeAll().count, 2)
  assert.throws(() => batch.start({ action: 'uninstall', key: batch.snapshot().installed[2].key }), /進行中/)
  while (batch.busy()) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(upgraded, ['X.A', 'X.B'])
  assert.ok(batch.snapshot().jobs.every((job) => job.phase === 'done'))
  assert.throws(() => batch.upgradeAll(), /沒有/)
  console.log('PASS app-installer: multilingual parsing, arguments, source allowlist, job lock, refresh, failure hygiene, duplicate guard, upgrade all')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
