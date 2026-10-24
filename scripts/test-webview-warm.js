// 瀏覽器分頁：最近切走的透明疊放、更舊的藏起來、1 小時沒看的休眠（出聲的、正在看的不收）
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert/strict')

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/webview-warm.js'), 'utf8')
  .replace(/^export /gm, '')
const ctx = vm.createContext({ Date, setInterval: () => 1 })
vm.runInContext(`${source}\nthis.api = { showGuest, sleepIdle, SLEEP_AFTER_MS }`, ctx)
const { showGuest, sleepIdle, SLEEP_AFTER_MS } = ctx.api

const node = (name, sound = false) => {
  const classes = new Set()
  return {
    name, hidden: false, inert: false, isConnected: true,
    classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    isCurrentlyAudible: () => sound,
    remove() { this.isConnected = false; frame.nodes = frame.nodes.filter((n) => n !== this) }
  }
}
const frame = { isConnected: true, nodes: [], querySelectorAll() { return this.nodes } }
const [a, b, c, d, music] = ['a', 'b', 'c', 'd', 'music'].map((n) => node(n, n === 'music'))
frame.nodes = [a, b, c, d, music]
const state = (n) => (n.hidden ? 'hidden' : n.classList.contains('webview-warm') ? 'warm' : 'shown')

for (const n of [music, a, b, c]) showGuest(frame, n)
showGuest(frame, d)
assert.deepEqual(frame.nodes.map(state), ['hidden', 'warm', 'warm', 'shown', 'hidden'], '目前那顆以外只留最近 2 顆疊放')
assert.equal(b.inert, true, '疊放的拿不到焦點')
assert.equal(d.inert, false)

assert.equal(sleepIdle(Date.now()), 0, '剛看過的不收')
assert.equal(sleepIdle(Date.now() + SLEEP_AFTER_MS + 1), 3, '超過 1 小時沒看的背景分頁收掉')
assert.deepEqual(frame.nodes.map((n) => n.name), ['d', 'music'], '正在看的、正在出聲的留著')
showGuest(frame, music)
assert.deepEqual(frame.nodes.map(state), ['warm', 'shown'], '收掉的不再算進疊放名單')
console.log('test-webview-warm: 7 passed')
