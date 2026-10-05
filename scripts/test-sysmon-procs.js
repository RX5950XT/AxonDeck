'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const metrics = require('../src/main/sysmon/metrics')

// 未知值不可變成 0；群組只要少一個成員就不可假裝是完整總量。
const raw = metrics.parseTick(['T|1000', 'P|12|demo|1|1|200|100|2|0|0|3|4|C:\\demo.exe|42'])
assert.equal(raw.procs[0].exePath, 'C:\\demo.exe')
assert.equal(raw.procs[0].startedAt, 42)
assert.equal(metrics.diffSamples(null, raw, 1).processes[0].network, null)
const diskBefore = metrics.parseTick(['T|1000', 'D|0 C:|0|0|100|1000'])
const diskAfter = metrics.parseTick(['T|2000', 'D|0 C:|0|0|600|2000'])
assert.equal(metrics.diffSamples(diskBefore, diskAfter, 1).disks[0].busy, 50)
assert.equal(metrics.diffSamples(null, diskBefore, 1).disks[0].busy, null)
assert.equal(metrics.diffSamples(diskBefore, metrics.parseTick(['T|2000', 'D|0 C:|0|0||2000']), 1).disks[0].busy, null)
const p = { pid: 12, name: 'demo', network: 100, exePath: '', cpu: 0 }
assert.equal(metrics.mergeProcesses([p, { ...p, pid: 13, network: null }])[0].network, null)
assert.equal(metrics.mergeProcesses([p, { ...p, pid: 13, network: 200, exePath: 'C:\\demo.exe' }])[0].network, 300)
assert.equal(metrics.mergeProcesses([p, { ...p, pid: 13, exePath: 'C:\\demo.exe' }])[0].exePath, 'C:\\demo.exe')

const source = fs.readFileSync('src/renderer/scripts/sysmon-procs.js', 'utf8').replace(/^export /gm, '')
const context = vm.createContext({ btoa })
vm.runInContext(source + '\nthis.api = { normalizeOrder, moveColumn, processTotals, networkRate, safeIcon, sortProcessRows, createProcessTable };', context)
const { api } = context
assert.equal(api.normalizeOrder(['cpu', 'name', 'cpu', 'bad'])[0], 'name')
assert.equal(new Set(api.normalizeOrder(['cpu', 'cpu'])).size, 9)
assert.equal(api.moveColumn(['name', 'cpu', 'memory'], 'name', 'cpu').join(','), 'name,cpu,memory')
assert.equal(api.moveColumn(['name', 'cpu', 'memory'], 'memory', 'cpu').join(','), 'name,memory,cpu')
assert.equal(api.networkRate(null), '—')
assert.equal(api.networkRate(0), '0 KB/s')
assert.equal(api.networkRate(125000), '1.0 Mbps')
assert.equal(api.safeIcon('https://example.com/a.png'), '')
assert.equal(api.safeIcon('data:text/html;base64,AA=='), '')
assert.equal(api.safeIcon('data:image/png;base64,AA=='), 'data:image/png;base64,AA==')
const totals = api.processTotals({
  cpu: { total: 23 }, memory: { available: 750 }, totalMemory: 1000,
  disks: [{ name: '0 C:', busy: 12 }, { name: '1 D:', busy: 45 }],
  nets: [{ rx: 125000, tx: 0, linkSpeed: 1000000000 }],
  gpuAdapterUtil: { card: 33 }, gpu: { cards: [{ memoryTotal: 200, memoryUsed: 50 }] },
  processes: [{ count: 2, threads: 8 }]
})
assert.equal(totals.cpu, '23%')
assert.equal(totals.memory, '25%')
assert.equal(totals.diskTotal, '45%')
assert.equal(totals.network, '0.1%')
assert.equal(totals.gpu, '33%')
assert.equal(totals.gpuMemory, '25%')
assert.equal(totals.threads, '8')
assert.equal(api.processTotals({ nets: [{ rx: 100, tx: 0, linkSpeed: 0 }] }).network, '—')
assert.equal(api.processTotals({ countersReady: false, cpu: { total: 0 }, nets: [{ rx: 0, tx: 0, linkSpeed: 100 }] }).cpu, '—')
assert.equal(api.sortProcessRows([{ pid: 1, network: null }, { pid: 2, network: 0 }], 'network', 'asc')[0].pid, 2)
assert.equal(metrics.sortProcesses([{ pid: 1, network: null }, { pid: 2, network: 0 }], 'network', 'asc')[0].pid, 2)
console.log('PASS 處理程序路徑、未知值、群組、欄序、總占用與網路排序')

class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.listeners = {}; this.attrs = {}; this.clientHeight = 60
    const classes = new Set()
    this.classList = { add: (...keys) => keys.forEach((k) => classes.add(k)), remove: (...keys) => keys.forEach((k) => classes.delete(k)),
      toggle: (k, on) => on ? classes.add(k) : classes.delete(k), contains: (k) => classes.has(k) }
    this.style = { setProperty: (key, value) => { this.style[key] = value } }
  }
  appendChild(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    this.children.push(child); child.parent = this
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)) }
  addEventListener(name, fn) { this.listeners[name] = fn }
  setAttribute(name, value) { this.attrs[name] = value }
  getAttribute(name) { return this.attrs[name] }
  closest() { return this.parent }
  focus() {}
  get firstElementChild() { return this.children[0] }
  get lastElementChild() { return this.children.at(-1) }
  set src(value) { this.attrs.src = value }
  get src() { return this.attrs.src }
}
const elements = Object.fromEntries(['sysmonHead', 'sysmonBody', 'sysmonRows', 'sysmonSpacer', 'sysmonNetworkNote'].map((id) => [id, new Element()]))
new Element().appendChild(elements.sysmonHead)
let saved = '[]'
context.localStorage = { getItem: () => saved, setItem: (_, value) => { saved = value } }
context.document = { createElement: () => new Element() }
const state = { rows: Array.from({ length: 200 }, (_, i) => ({ pid: i + 1, name: `demo-${i}`, count: 2, pids: [i + 1, i + 500], cpu: 12, memory: 1024, diskRead: 0, diskWrite: 0, network: null, threads: 2 })), scrollTop: 0, sortKey: 'cpu', sortDir: 'desc', selectedPid: 1 }
let selected, sorted
const table = api.createProcessTable({ state, $: (id) => elements[id], onSelect: (id) => { selected = id }, onSort: (key) => { sorted = key }, fmtBytes: String, fmtRate: String, fmtPct: String })
table.renderHead(); table.renderRows()
assert.equal(elements.sysmonHead.children.length, 9)
assert.equal(elements.sysmonHead.children[0].dataset.key, 'name')
assert.equal(elements.sysmonHead.children[0].draggable, undefined)
assert.equal(elements.sysmonRows.children.length, 18, '200 列仍只畫可見節點')
const row = elements.sysmonRows.children[0]
assert.equal(row.classList.contains('is-selected'), true)
row.listeners.click(); assert.equal(selected, 1)
assert.equal(row.children.find((cell) => cell.dataset.key === 'pid').textContent, '×2')
assert.equal(row.children.find((cell) => cell.dataset.key === 'network').textContent, '—')
const cpu = elements.sysmonHead.children.find((btn) => btn.dataset.key === 'cpu')
cpu.listeners.click(); assert.equal(sorted, 'cpu')
const net = elements.sysmonHead.children.find((btn) => btn.dataset.key === 'network')
const event = { dataTransfer: { setData() {} }, preventDefault() {} }
net.listeners.dragstart(event); cpu.listeners.dragover(event); cpu.listeners.drop(event)
assert.equal(JSON.parse(saved)[2], 'network')
assert.equal(elements.sysmonHead.children[2].dataset.key, 'network')
assert.equal(row.children[2].dataset.key, 'network')
sorted = null; cpu.listeners.click(); assert.equal(sorted, null, '拖曳後的 click 不觸發排序')
net.listeners.keydown({ altKey: true, key: 'ArrowRight', preventDefault() {} })
assert.equal(row.children[3].dataset.key, 'network')
state.scrollTop = 300; table.renderRows()
assert.equal(elements.sysmonRows.children[0], row, '捲動重用原本的列')
assert.equal(elements.sysmonHead.children[0].dataset.key, 'name')
context.localStorage = { getItem() { throw new Error('disabled') }, setItem() { throw new Error('disabled') } }
assert.doesNotThrow(() => api.createProcessTable({ state, $: () => null }))
console.log('PASS 虛擬列、圖示節點、選取、群組 PID、拖曳／鍵盤欄序、保存與排序事件')
