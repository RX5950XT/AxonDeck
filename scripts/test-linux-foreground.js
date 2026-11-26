#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const linux = require('../src/main/terminal/foreground-linux')
const foreground = require('../src/main/terminal/foreground')

const wm = `
0x02a00001  0 100 host AxonDeck
0x02a00002  0 200 host Terminal
`.trim()

assert.deepEqual(linux.parseWmctrlList(wm), [
  { id: '0x02a00001', pid: 100, title: 'AxonDeck', cls: '' },
  { id: '0x02a00002', pid: 200, title: 'Terminal', cls: '' }
])

const before = linux.parseWmctrlList(wm)
const after = linux.parseWmctrlList(wm + '\n0x02a00003  0 300 host Visual Studio Code')
const hits = linux.pickNewWindows(before, after, foreground.REUSE_WINDOW)
assert.equal(hits.length, 1)
assert.equal(hits[0].id, '0x02a00003')

const reused = linux.pickNewWindows(
  [{ id: '0x1', pid: 1, title: 'Untitled - notepad', cls: 'notepad' }],
  [{ id: '0x1', pid: 1, title: 'notes.txt - notepad', cls: 'notepad' }],
  foreground.REUSE_WINDOW
)
assert.equal(reused.length, 1)

const ignoredTitle = linux.pickNewWindows(
  [{ id: '0x1', pid: 1, title: 'Tab A', cls: 'firefox' }],
  [{ id: '0x1', pid: 1, title: 'Tab B', cls: 'firefox' }],
  foreground.REUSE_WINDOW
)
assert.equal(ignoredTitle.length, 0)

;(async () => {
  let raised = []
  let calls = 0
  const ok = await linux.startWaiter({
    backend: 'wmctrl',
    reuse: foreground.REUSE_WINDOW,
    timeoutMs: 800,
    pollMs: 20,
    wait: true,
    run: async (cmd, args) => {
      calls++
      if (cmd === 'wmctrl' && args[0] === '-lp') {
        return calls < 3 ? wm : wm + '\n0x02a00009  0 900 host Code'
      }
      if (cmd === 'wmctrl' && args[0] === '-i' && args[1] === '-a') {
        raised.push(args[2])
        return ''
      }
      return ''
    }
  })
  assert.equal(ok, true)
  assert.deepEqual(raised, ['0x02a00009'])

  const backend = await linux.createBackend({
    env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' },
    hasCommand: (name) => name === 'gdbus',
    run: async () => ''
  })
  assert.equal(backend.backend, 'kwin-script')

  const gnome = await linux.createBackend({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' },
    hasCommand: (name) => name === 'gdbus',
    run: async () => ''
  })
  assert.equal(gnome.backend, 'gnome-window-calls')

  const x11 = await linux.createBackend({
    env: { DISPLAY: ':13', XDG_SESSION_TYPE: 'x11', PATH: '/usr/bin' },
    hasCommand: (name) => name === 'wmctrl',
    run: async () => wm
  })
  assert.equal(x11.backend, 'wmctrl')

  assert.equal(typeof foreground.raiseChildWindowLinux, 'function')
  const src = fs.readFileSync(path.join(__dirname, '../src/main/terminal/foreground.js'), 'utf8')
  assert.match(src, /process\.platform === 'linux'/)
  assert.match(src, /foreground-linux/)
  console.log('PASS Linux 抬窗：新視窗／重用標題、wmctrl 與 KDE／GNOME 後端選擇')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
