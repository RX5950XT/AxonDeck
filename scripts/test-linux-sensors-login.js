#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const login = require('../src/main/sysmon/linux-login')

const dir = tempDir('linux-sensors-login-')
;(async () => {
  try {
    const home = path.join(dir, 'home')
    const appimage = path.join(dir, 'AxonDeck.AppImage')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(appimage, '#!/bin/sh\n', { mode: 0o755 })
    const env = { HOME: home, APPIMAGE: appimage, PATH: '/bin' }

    const preview = await login.install({ env, argv: ['node', 'app', '--user-data-dir=/tmp/x'], execPath: appimage, hasSystemctl: true })
    assert.equal(preview.installed, false)
    assert.equal(preview.preview, true)
    assert.equal(fs.existsSync(login.unitPath(env)), false)

    const ctl = []
    const installed = await login.install({
      env,
      argv: ['node', 'app'],
      execPath: appimage,
      hasSystemctl: true,
      execFileFn: (cmd, args, opts, cb) => {
        ctl.push([cmd, ...args])
        cb(null, '', '')
      }
    })
    assert.equal(installed.installed, true)
    assert.equal(installed.kind, 'systemd')
    const text = fs.readFileSync(login.unitPath(env), 'utf8')
    assert.match(text, /AxonDeck fan and performance settings at login/)
    assert.match(text, /--hidden/)
    assert.match(text, /AxonDeck\.AppImage/)
    assert.ok(ctl.some((row) => row.includes('enable')))
    assert.equal(fs.existsSync(login.desktopPath(env)), false)

    const st = login.status({ env, argv: ['node', 'app'] })
    assert.equal(st.installed, true)
    assert.equal(st.kind, 'systemd')

    // systemctl 失敗時改 XDG，且不刪別人的 autostart
    const env2 = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'cfg'), PATH: '/bin' }
    const stranger = path.join(env2.XDG_CONFIG_HOME, 'autostart', 'other.desktop')
    fs.mkdirSync(path.dirname(stranger), { recursive: true })
    fs.writeFileSync(stranger, '[Desktop Entry]\nName=Other\n')
    const xdg = await login.install({
      env: env2,
      argv: ['node', 'app'],
      execPath: '/opt/AxonDeck/axondeck',
      hasSystemctl: false
    })
    assert.equal(xdg.kind, 'xdg')
    const desk = fs.readFileSync(login.desktopPath(env2), 'utf8')
    assert.match(desk, /X-AxonDeck-Sensors=1/)
    assert.match(desk, /\/opt\/AxonDeck\/axondeck/)
    assert.equal(fs.existsSync(stranger), true)

    await login.remove({ env: env2, execFileFn: (cmd, args, opts, cb) => cb(null, '', '') })
    assert.equal(fs.existsSync(login.desktopPath(env2)), false)
    assert.equal(fs.existsSync(stranger), true)

    const idx = fs.readFileSync(path.join(__dirname, '../src/main/sysmon/index.js'), 'utf8')
    assert.match(idx, /linux-login/)
    assert.match(idx, /ensureLoginUnit/)
    console.log('PASS Linux 風扇登入單元：systemd user、XDG 退路、預覽不寫入、只刪自己的檔')
  } finally {
    removeTree(dir)
  }
})().catch((err) => {
  removeTree(dir)
  console.error(err)
  process.exit(1)
})
