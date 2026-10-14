'use strict'

/**
 * 使用時長的 Linux 前景視窗觀測（observer-linux.js）＋服務狀態接線。全部假指令，不碰真的桌面。
 * 真的 X11 桌面驗證另見 scripts/probe-screentime-x11.js。
 *
 * 用法：node scripts/test-screentime-linux.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const obs = require('../src/main/screentime/observer-linux')
const { tempDir } = require('./lib/test-temp')

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`) }
}

/** 假 PATH：只放指定的指令 */
function fakePath(names) {
  const dir = tempDir('st-bin-')
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n')
    fs.chmodSync(path.join(dir, name), 0o755)
  }
  return dir
}

/** 假 execFile：依指令與參數回輸出；回 null 表示失敗 */
function fakeExec(replies, calls = []) {
  return (cmd, args, opts, cb) => {
    calls.push([cmd, ...args].join(' '))
    const out = replies(cmd, args)
    queueMicrotask(() => out === null ? cb(new Error('fail')) : cb(null, out, ''))
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  await check('解析 xprop／GVariant／sway tree', () => {
    assert.equal(obs.parseActiveWindow('_NET_ACTIVE_WINDOW: window id # 0x2a00007'), '0x2a00007')
    assert.equal(obs.parseActiveWindow('_NET_ACTIVE_WINDOW: window id # 0x0, 0x8b48c54'), '')
    assert.equal(obs.parseWmPid('_NET_WM_PID = 4321'), 4321)
    assert.equal(obs.parseWmPid('_NET_WM_PID:  not found.'), 0)
    assert.equal(obs.parseWindowCalls(`('[{"pid":11,"focus":false},{"pid":22,"focus":true,"wm_class":"it\\'s"}]',)`), 22)
    assert.equal(obs.parseWindowCalls("Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownObject"), null)
    assert.equal(obs.parseGnomeEval("(true, '987')"), 987)
    assert.equal(obs.parseGnomeEval("(false, '')"), null)
    assert.equal(obs.findSwayFocused({ nodes: [{ nodes: [{ pid: 5, focused: false }, { pid: 6, focused: true }] }] }), 6)
  })

  const detect = (env, replies = () => null) => obs.createLinuxObserver({ env, execFileFn: fakeExec(replies) }).detect()
  await check('偵測：X11 有 xprop → x11；沒 xprop → 說明要裝 x11-utils', async () => {
    assert.equal((await detect({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', PATH: fakePath(['xprop']) })).backend, 'x11')
    const no = await detect({ DISPLAY: ':0', PATH: fakePath([]) })
    assert.equal(no.supported, false)
    assert.match(no.note, /x11-utils/)
  })
  await check('偵測：沒有圖形工作階段 → supported:false', async () => {
    const no = await detect({ PATH: fakePath(['xprop']) })
    assert.equal(no.supported, false)
    assert.match(no.note, /DISPLAY/)
  })
  await check('偵測：Wayland Hyprland／Sway／KDE（kdotool）', async () => {
    assert.equal((await detect({ XDG_SESSION_TYPE: 'wayland', HYPRLAND_INSTANCE_SIGNATURE: 'x', PATH: fakePath(['hyprctl']) })).backend, 'hyprland')
    assert.equal((await detect({ WAYLAND_DISPLAY: 'wayland-0', SWAYSOCK: '/run/s', PATH: fakePath(['swaymsg']) })).backend, 'sway')
    assert.equal((await detect({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', PATH: fakePath(['kdotool']) })).backend, 'kdotool')
    const kde = await detect({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', PATH: fakePath([]) })
    assert.equal(kde.supported, false)
    assert.match(kde.note, /kdotool/)
  })
  await check('偵測：GNOME Wayland → Window Calls、Eval、都沒有就說明原因', async () => {
    const env = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', PATH: fakePath(['gdbus']) }
    const windowCalls = (cmd, args) => args.includes('org.gnome.Shell.Extensions.Windows.List') ? `('[{"pid":7,"focus":true}]',)` : null
    assert.equal((await detect(env, windowCalls)).backend, 'gnome-window-calls')
    const evalOnly = (cmd, args) => args.includes('org.gnome.Shell.Eval') ? "(true, '7')" : null
    assert.equal((await detect(env, evalOnly)).backend, 'gnome-eval')
    const locked = await detect(env, (cmd, args) => args.includes('org.gnome.Shell.Eval') ? "(false, '')" : null)
    assert.equal(locked.supported, false)
    assert.match(locked.note, /Window Calls/)
  })
  await check('偵測：其他 Wayland 桌面 → supported:false 列出支援清單', async () => {
    const other = await detect({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'weston', PATH: fakePath(['xprop', 'gdbus']) })
    assert.equal(other.supported, false)
    assert.match(other.note, /weston/)
  })

  await check('X11 輪詢：前景 PID → /proc 名稱，視窗 PID 有快取、stop 後不再 tick', async () => {
    const calls = []
    let active = '0x100'
    const ticks = []
    const o = obs.createLinuxObserver({
      env: { DISPLAY: ':0', PATH: fakePath(['xprop']) },
      intervalMs: 20,
      idleMs: () => 1500,
      readInfo: async (pid) => ({ name: pid === 11 ? 'code' : 'firefox', path: pid === 11 ? '/usr/share/code/code' : '/usr/lib/firefox/firefox' }),
      execFileFn: fakeExec((cmd, args) => {
        if (args.includes('-root')) return `_NET_ACTIVE_WINDOW: window id # ${active}`
        return args[1] === '0x100' ? '_NET_WM_PID = 11' : '_NET_WM_PID = 22'
      }, calls),
      onTick: (info) => ticks.push(info)
    })
    o.start()
    await wait(90)
    active = '0x200'
    await wait(90)
    o.stop()
    const count = ticks.length
    await wait(60)
    assert.ok(o.running === false && ticks.length === count, 'stop 後還在 tick')
    assert.ok(ticks.some((t) => t.name === 'code' && t.pid === 11 && t.idleMs === 1500))
    assert.ok(ticks.some((t) => t.name === 'firefox' && t.path === '/usr/lib/firefox/firefox'))
    assert.equal(calls.filter((c) => c.includes('-id 0x100')).length, 1, '同一視窗只查一次 PID')
  })

  await check('processInfo：讀自己的 /proc；桌面殼層名稱回空字串', async () => {
    const self = await obs.processInfo(process.pid)
    assert.equal(self.path, fs.realpathSync(process.execPath))
    assert.equal(self.name, path.basename(self.path))
    const fsp = { readlink: async () => '/usr/bin/gnome-shell', readFile: async () => '' }
    assert.deepEqual(await obs.processInfo(1234, fsp), { name: '', path: '/usr/bin/gnome-shell' })
    assert.deepEqual(await obs.processInfo(0), { name: '', path: '' })
  })

  await check('服務狀態：Linux 不支援時回 supported:false＋原因；支援時 recording 跟著 observer', async () => {
    const { createScreentimeService } = require('../src/main/screentime/index')
    const make = (support, running) => () => ({ start() {}, stop() {}, get running() { return running }, get support() { return support } })
    const off = createScreentimeService({ userDataPath: tempDir('st-ud-'), platform: 'linux',
      linuxObserver: make({ supported: false, backend: '', note: 'GNOME（Wayland）不開放查詢前景視窗' }, false) }).status()
    assert.equal(off.supported, false)
    assert.match(off.note, /GNOME/)
    assert.equal(off.recording, false)
    const on = createScreentimeService({ userDataPath: tempDir('st-ud-'), platform: 'linux',
      linuxObserver: make({ supported: true, backend: 'x11', note: '' }, true) }).status()
    assert.equal(on.supported, true)
    assert.equal(on.recording, true)
    assert.equal(on.observerBackend, 'x11')
    const win = createScreentimeService({ userDataPath: tempDir('st-ud-'), platform: 'win32' }).status()
    assert.equal(win.supported, true)
    assert.equal(win.observerBackend, '')
  })

  if (failed) { console.log(`\n${failed} 項失敗`); process.exit(1) }
  console.log('\n全部通過')
}

main().catch((error) => { console.error(error); process.exit(1) })
