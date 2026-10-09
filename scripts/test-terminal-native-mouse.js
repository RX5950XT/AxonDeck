'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/scripts/term-mouse.js'), 'utf8').replace(/^export /gm, '')
const { blockMouseReporting } = vm.runInNewContext(source + '\n;({ blockMouseReporting })')
function setup(nativeMouse) {
  const handlers = []
  let wheel
  const term = { write() {}, parser: { registerCsiHandler: (id, fn) => handlers.push({ id, fn }) },
    attachCustomWheelEventHandler: fn => { wheel = fn }, buffer: { active: { type: 'alternate' } } }
  blockMouseReporting(term, nativeMouse)
  return { handlers, wheel: event => wheel(event) }
}
const native = setup(true)
assert.equal(native.handlers.some(({ id, fn }) => id.final === 'h' && fn([1002, 1006])), false,
  '原生全螢幕須讓 xterm 處理 mouse tracking，否則 CLI 捲軸不能拖曳')
assert.equal(native.wheel({ ctrlKey: false }), true, '原生滾輪交給 CLI，不能另送重複 SGR')
assert.equal(native.wheel({ ctrlKey: true }), false, 'Ctrl+滾輪只改 AxonDeck 字級')
const local = setup(false)
assert.equal(local.handlers.some(({ id, fn }) => id.final === 'h' && fn([1002])), false,
  '一般終端機也不攔截滑鼠模式，點選與滾輪交給 CLI')
assert.equal(local.wheel({ ctrlKey: false }), true, '沒按 Ctrl 的滾輪仍由 xterm 處理')
assert.equal(local.wheel({ ctrlKey: true }), false, 'Ctrl+滾輪只改 AxonDeck 字級')
console.log('PASS 終端機不攔截滑鼠，Ctrl+滾輪仍只改字級')
