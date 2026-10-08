'use strict'

/**
 * Linux 熱鍵：走 uiohook、不炸；Wayland 限制可文件化偵測。
 * 無 GUI：用假 uiohook，不真的掛全域 hook。
 */

const assert = require('node:assert/strict')
const hotkey = require('../src/main/dictation/hotkey')

async function main() {
  const wayland = hotkey.detectDisplayServer({
    XDG_SESSION_TYPE: 'wayland',
    WAYLAND_DISPLAY: 'wayland-0'
  })
  assert.equal(wayland.display, 'wayland')
  assert.match(wayland.note, /Wayland/)
  assert.match(wayland.note, /X11/)
  assert.equal(hotkey.hotkeyLimitations({
    XDG_SESSION_TYPE: 'wayland',
    WAYLAND_DISPLAY: 'wayland-0'
  }).canGlobalHook, false)

  const x11 = hotkey.detectDisplayServer({
    XDG_SESSION_TYPE: 'x11',
    DISPLAY: ':0'
  })
  assert.equal(x11.display, 'x11')
  assert.match(x11.note, /X11/)
  assert.match(x11.note, /Wayland/)
  assert.equal(hotkey.hotkeyLimitations({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }).canGlobalHook, true)

  // 假 uiohook：start／stop 不應 throw
  const listeners = { keydown: null, keyup: null }
  let started = false
  const fakeHook = {
    on(ev, fn) { listeners[ev] = fn },
    off(ev, fn) { if (listeners[ev] === fn) listeners[ev] = null },
    start() { started = true },
    stop() { started = false },
    keyTap() { throw new Error('Linux 不應中和 Alt') }
  }
  const actions = []
  hotkey.stop()
  const r = await hotkey.start({
    onAction: (a) => actions.push(a),
    native: true, // Linux 仍應跳過 native
    load: () => ({ uIOhook: fakeHook })
  })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'uiohook')
  assert.equal(started, true)
  assert.equal(hotkey.currentMode(), 'uiohook')

  listeners.keydown?.({ keycode: hotkey.RIGHT_ALT })
  assert.deepEqual(actions, ['start'])
  listeners.keyup?.({ keycode: hotkey.RIGHT_ALT })
  // 短按不 stop
  assert.equal(hotkey.isRecording(), true)

  hotkey.stop()
  assert.equal(started, false)
  assert.equal(hotkey.isRunning(), false)

  // start() 失敗要回錯誤碼，不往外炸
  const bad = await hotkey.start({
    load: () => ({
      uIOhook: {
        on() {},
        off() {},
        start() { throw new Error('no display') },
        stop() {},
        keyTap() {}
      }
    })
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'HOOK_START_FAILED')

  console.log('PASS: Linux 熱鍵 uiohook／Wayland 限制／失敗不炸')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
