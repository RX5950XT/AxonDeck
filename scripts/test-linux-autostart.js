#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const linux = require('../src/main/linux-autostart')

const dir = tempDir('linux-autostart-')
try {
  const home = path.join(dir, 'home')
  const appimage = path.join(dir, 'AxonDeck.AppImage')
  fs.mkdirSync(home)
  fs.writeFileSync(appimage, '#!/bin/sh\n', { mode: 0o755 })
  const env = { HOME: home, APPIMAGE: appimage }

  assert.equal(linux.isEnabled({ env }), false)
  const on = linux.setEnabled(true, { env, args: ['--hidden'] })
  assert.equal(on.openAtLogin, true)
  assert.equal(on.supported, true)
  assert.equal(linux.isEnabled({ env }), true)
  const file = linux.desktopPath(env)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /Type=Application/)
  assert.match(text, /X-AxonDeck-Autostart=1/)
  assert.match(text, /--hidden/)
  assert.match(text, /AxonDeck\.AppImage/)
  assert.doesNotMatch(text, /\/tmp\/\.mount_/)

  const unpacked = '/opt/AxonDeck/axondeck'
  const envDeb = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'cfg') }
  linux.setEnabled(true, { env: envDeb, execPath: unpacked })
  const debText = fs.readFileSync(linux.desktopPath(envDeb), 'utf8')
  assert.match(debText, /\/opt\/AxonDeck\/axondeck/)
  assert.equal(linux.desktopPath(envDeb), path.join(home, 'cfg', 'autostart', 'axondeck.desktop'))

  const off = linux.setEnabled(false, { env: envDeb })
  assert.equal(off.openAtLogin, false)
  assert.equal(fs.existsSync(linux.desktopPath(envDeb)), false)

  // 不刪別人的 autostart 檔
  const stranger = path.join(linux.autostartDir(env), 'other.desktop')
  fs.writeFileSync(stranger, '[Desktop Entry]\nName=Other\n')
  linux.remove({ env })
  assert.equal(fs.existsSync(linux.desktopPath(env)), false)
  assert.equal(fs.existsSync(stranger), true)

  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.match(source, /require\('\.\/linux-autostart'\)/)
  assert.match(source, /process\.platform === 'linux'/)
  console.log('PASS Linux XDG Autostart 寫入、AppImage 路徑、關閉只刪自己的檔')
} finally {
  removeTree(dir)
}
