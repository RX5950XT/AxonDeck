#!/usr/bin/env node
'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const linux = require('../src/main/linux-associations')
const launch = require('../src/main/script-launch')
const store = require('../src/main/workspace/store')
const Module = require('module')

assert.equal(linux.mimeOf('mp4'), 'video/mp4')
assert.equal(linux.mimeOf('.PNG'), 'image/png')
assert.ok(linux.mimeOf('weirdext').startsWith('application/x-extension-'))
const desktop = linux.desktopEntry({ exec: '"/opt/Axon Deck/axondeck"', mimes: ['video/mp4', 'text/plain'] })
assert.match(desktop, /^\[Desktop Entry\]/m)
assert.match(desktop, /Exec="\/opt\/Axon Deck\/axondeck" %U/)
assert.match(desktop, /MimeType=video\/mp4;text\/plain;/)

const merged = linux.mergeMimeapps('[Default Applications]\nvideo/mp4=vlc.desktop\n', 'axondeck.desktop', ['video/mp4', 'text/plain'])
assert.match(merged.text, /text\/plain=axondeck\.desktop/)
assert.doesNotMatch(merged.text, /video\/mp4=axondeck/)
assert.deepEqual(merged.added, ['text/plain'])

const home = tempDir('assoc-home-')
const userData = tempDir('assoc-ud-')
try {
  const result = linux.install({
    isPackaged: true,
    isPreview: false,
    userDataPath: userData,
    home,
    execPath: '/tmp/AxonDeck.AppImage',
    exts: ['mp4', 'txt'],
    write: true,
    spawnSyncFn: () => ({ status: 1, stdout: '' })
  })
  assert.equal(result.installed, true)
  const desktopFile = fs.readFileSync(path.join(home, '.local/share/applications/axondeck.desktop'), 'utf8')
  assert.match(desktopFile, /Exec=\/tmp\/AxonDeck\.AppImage %U/)
  const mimeapps = fs.readFileSync(path.join(home, '.config/mimeapps.list'), 'utf8')
  assert.match(mimeapps, /video\/mp4=axondeck\.desktop/)
  const again = linux.install({ isPackaged: true, userDataPath: userData, home, write: true })
  assert.equal(again.reason, 'already')
  assert.equal(linux.install({ isPackaged: false }).reason, 'unpackaged')
} finally {
  removeTree(home)
  removeTree(userData)
}

if (process.platform !== 'win32') {
  assert.equal(store.normalizeSetupScript('setup.sh'), 'setup.sh')
  assert.equal(store.normalizeSetupScript('app.desktop'), 'app.desktop')
  assert.equal(store.normalizeSetupScript('setup.bat'), '')
  assert.equal(store.normalizeSetupScript('../x.sh'), '')
} else {
  assert.equal(store.normalizeSetupScript('setup.bat'), 'setup.bat')
  assert.equal(store.normalizeSetupScript('setup.sh'), '')
}

function shortcutAndCleanup() {
  const home = tempDir('assoc-shortcut-')
  const userData = tempDir('assoc-shortcut-ud-')
  try {
    const desktopDir = path.join(home, 'Desktop')
    fs.mkdirSync(desktopDir, { recursive: true })
    const env = { HOME: home }
    const put = linux.installDesktopShortcut({
      home, env, execPath: '/opt/AxonDeck/axondeck', write: true
    })
    assert.equal(put.installed, true)
    assert.equal(put.dest, path.join(desktopDir, 'axondeck.desktop'))
    const text = fs.readFileSync(put.dest, 'utf8')
    assert.match(text, /X-AxonDeck-Integration=1/)
    assert.match(text, /Exec=\/opt\/AxonDeck\/axondeck %U/)

    const other = path.join(home, '.config/mimeapps.list')
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(other, '[Default Applications]\nvideo/mp4=vlc.desktop\ntext/plain=axondeck.desktop\n')
    fs.mkdirSync(path.join(home, '.local/share/applications'), { recursive: true })
    fs.writeFileSync(path.join(home, '.local/share/applications/axondeck.desktop'), text)

    const stranger = path.join(desktopDir, 'notes.desktop')
    fs.writeFileSync(stranger, '[Desktop Entry]\nName=Notes\n')
    const out = linux.removeUserIntegration({ home, env, userDataPath: userData })
    assert.equal(out.removed, true)
    assert.equal(fs.existsSync(put.dest), false)
    assert.equal(fs.existsSync(path.join(home, '.local/share/applications/axondeck.desktop')), false)
    assert.equal(fs.existsSync(stranger), true)
    const mime = fs.readFileSync(other, 'utf8')
    assert.match(mime, /video\/mp4=vlc\.desktop/)
    assert.doesNotMatch(mime, /axondeck\.desktop/)
    console.log('PASS 桌面捷徑與卸載清理（不刪別人的檔）')
  } finally {
    removeTree(home)
    removeTree(userData)
  }
}

shortcutAndCleanup()

async function main() {
  if (process.platform !== 'win32') {
    const root = tempDir('script-desktop2-')
    const file = path.join(root, 'app.desktop')
    fs.writeFileSync(file, '[Desktop Entry]\nType=Application\nName=Demo\nExec=true\n')
    const load = Module._load
    Module._load = function (name, ...args) {
      return name === 'electron' ? { app: { isPackaged: true, getPath: () => root } } : load.call(this, name, ...args)
    }
    try {
      const command = await launch.terminalCommand(file, 'w_parent', 't1')
      assert.match(command, /gio launch/)
      assert.doesNotMatch(command, /powershell/i)
    } finally {
      Module._load = load
      removeTree(root)
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  const desktop = pkg.build.linux.desktop || {}
  const mime = desktop.MimeType || (desktop.entry && desktop.entry.MimeType) || ''
  assert.ok(mime.includes('video/mp4'))
  assert.ok(mime.includes('text/plain'))
  console.log('test-linux-associations: all passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
