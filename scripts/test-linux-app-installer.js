#!/usr/bin/env node
'use strict'

const assert = require('assert/strict')
const { sourceFor, catalogLinux, LINUX_SOURCES } = require('../src/main/app-installer/linux-catalog')
const backend = require('../src/main/app-installer/linux-backend')
const { createLinuxInstaller } = require('../src/main/app-installer/linux')
const { CATALOG } = require('../src/main/app-installer/catalog')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

assert.ok(LINUX_SOURCES.steam.apt)
assert.equal(sourceFor(CATALOG.find((e) => e.key === 'steam'), 'apt', true).package, 'steam-installer')
assert.equal(sourceFor(CATALOG.find((e) => e.key === 'steam'), 'apt', true).channel, 'apt')
assert.equal(sourceFor(CATALOG.find((e) => e.key === 'bambu'), 'apt', true).channel, 'flatpak')
assert.equal(sourceFor(CATALOG.find((e) => e.key === 'line'), 'apt', true).package, '')
assert.match(sourceFor(CATALOG.find((e) => e.key === 'line'), 'apt', true).note, /LINE/)
assert.equal(catalogLinux('apt', true).filter((e) => e.linux.package).length >= 5, true)

const detected = backend.detect({
  hasCommand: (name) => ['apt-get', 'apt', 'flatpak', 'pkexec'].includes(name)
})
assert.deepEqual({ native: detected.native, flatpak: detected.flatpak, graphical: detected.graphical }, {
  native: 'apt', flatpak: true, graphical: 'pkexec'
})

const [exe, args] = backend.nativeArgs('apt', 'install', 'steam-installer')
assert.deepEqual([exe, args], ['apt-get', ['install', '-y', '--', 'steam-installer']])
assert.throws(() => backend.nativeArgs('apt', 'install', 'steam; rm -rf /'), (e) => e.userMessage.includes('套件名稱無效'))

const pk = backend.privilegeCommand('apt-get', args, { detect: detected })
assert.equal(pk.exe, 'pkexec')
assert.deepEqual(pk.args[0], 'apt-get')
assert.equal(pk.visibleSudo, false)
backend.assertNotSilentSudo(pk.exe, pk.args)

const term = backend.privilegeCommand('apt-get', args, {
  detect: { native: 'apt', flatpak: false, graphical: '', terminal: 'x-terminal-emulator' }
})
assert.equal(term.exe, 'x-terminal-emulator')
assert.ok(term.args.includes('sudo'))
assert.ok(term.visibleSudo)
assert.ok(!term.args.includes('-n'))
assert.throws(() => backend.assertNotSilentSudo('sudo', ['-n', 'apt-get', 'install', 'x']), (e) => /靜默 sudo/.test(e.userMessage))

const fp = backend.privilegeCommand('flatpak', ['install', '-y', '--user', 'flathub', 'com.valvesoftware.Steam'], {
  detect: detected
})
assert.equal(fp.exe, 'flatpak')
assert.equal(fp.elevated, false)

assert.deepEqual(backend.parseDpkg('discord\t0.0.1\nsteam-installer\t1:1.0\n').map((r) => r.id), ['discord', 'steam-installer'])
assert.equal(backend.parseFlatpak('com.discordapp.Discord\t0.0.1\tDiscord\n')[0].id, 'com.discordapp.Discord')

const calls = []
const installer = createLinuxInstaller({
  detect: detected,
  list: async () => backend.parseDpkg('discord\t0.0.1\n'),
  search: async (q) => [{ id: 'vlc', name: 'vlc', description: 'media', source: 'apt' }].filter((r) => r.id.includes(q)),
  runCommand: async (exe, args) => { calls.push([exe, ...args]); return { code: 0, stdout: '', stderr: '' } },
  spawnCommand: async (exe, args) => { calls.push(['spawn', exe, ...args]); return { code: 0, started: true } }
})

const empty = installer.snapshot()
assert.equal(empty.unsupported, false)
assert.equal(empty.backend.native, 'apt')
assert.ok(empty.catalog.find((row) => row.key === 'steam').canInstall)
assert.equal(empty.catalog.find((row) => row.key === 'line').canInstall, false)


function desktopInventory() {
  const hidden = backend.parseDesktopFile('[Desktop Entry]\nType=Application\nName=HiddenApp\nExec=true\nNoDisplay=true\n', 'hidden.desktop')
  assert.equal(hidden, null)
  const app = backend.parseDesktopFile('[Desktop Entry]\nName=Example App\nExec=/usr/bin/example\nIcon=example\n', '/usr/share/applications/example.desktop')
  assert.equal(app.id, 'example')
  assert.equal(app.name, 'Example App')
  assert.equal(app.source, 'desktop')
  const root = tempDir('desktop-apps-')
  try {
    const apps = path.join(root, 'share/applications')
    fs.mkdirSync(apps, { recursive: true })
    fs.writeFileSync(path.join(apps, 'example.desktop'), '[Desktop Entry]\nName=Example App\nExec=/usr/bin/example\n')
    fs.writeFileSync(path.join(apps, 'skip.desktop'), '[Desktop Entry]\nName=Skip\nExec=true\nHidden=true\n')
    const rows = backend.listDesktopApps({ home: root, env: { HOME: root, XDG_DATA_HOME: path.join(root, 'share'), XDG_DATA_DIRS: '' } })
    assert.deepEqual(rows.map((r) => r.id), ['example'])
  } finally {
    removeTree(root)
  }
}

async function main() {
  desktopInventory()

  const snap = await installer.refresh()
  assert.equal(snap.installed.length, 1)
  assert.equal(snap.installed[0].name, 'discord')
  const job = installer.start({ action: 'install', key: 'steam' })
  assert.equal(job.action, 'install')
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(calls.some((c) => c[0] === 'pkexec' && c.includes('apt-get') && c.includes('steam-installer')))
  assert.ok(!calls.some((c) => c.includes('-n') && c.includes('sudo')))
  try {
    installer.start({ action: 'install', key: 'line' })
    assert.fail('line should be rejected')
  } catch (error) {
    assert.match(error.userMessage, /LINE|來源/)
  }
  console.log('test-linux-app-installer: all passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
