'use strict'
// app-resources.summarize：Electron 程序按頁分組、子程序依掛在誰底下歸組、CPU 換成整機 %
const assert = require('assert')
const { summarize } = require('../src/main/app-resources')

const result = summarize({
  rootPid: 10,
  cores: 4,
  appName: 'AxonDeck',
  pageLabels: new Map([['chat', 'SI']]),
  metrics: [
    { pid: 10, type: 'Browser', cpu: { percentCPUUsage: 8 }, memory: { workingSetSize: 1024 } },
    { pid: 11, type: 'GPU', cpu: { percentCPUUsage: 4 }, memory: { workingSetSize: 2048 } },
    { pid: 12, type: 'Utility', serviceName: 'network.mojom.NetworkService', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 512 } },
    { pid: 13, type: 'Tab', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 4096 } },
    { pid: 14, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 1024 } }
  ],
  contents: [
    { pid: 13, type: 'window', url: 'file:///app/index.html?page=chat' },
    { pid: 14, type: 'webview', url: 'https://web.telegram.org/a/' }
  ],
  processes: [
    { pid: 10, parentPid: 1, name: 'AxonDeck', cpu: 9, memory: 9 },
    { pid: 20, parentPid: 10, name: 'llama-server', cpu: 5, memory: 1000 },
    { pid: 21, parentPid: 20, name: 'conhost', cpu: 1, memory: 10 },
    { pid: 30, parentPid: 999, name: 'axondeck-term', cpu: 1, memory: 100 },
    { pid: 31, parentPid: 30, name: 'pwsh', cpu: 2, memory: 200 },
    { pid: 40, parentPid: 1, name: 'explorer', cpu: 3, memory: 5000 },
    { pid: 50, parentPid: 10, name: 'AxonDeck', cpu: 0, memory: 30 }
  ]
})
const by = new Map(result.groups.map((g) => [g.label, g]))
assert.strictEqual(by.get('主程序').cpu, 2)
assert.strictEqual(by.get('主程序').memory, 1024 * 1024)
assert.ok(by.has('GPU 程序') && by.has('網路服務'))
assert.strictEqual(by.get('SI').memory, 4096 * 1024)
assert.ok(by.has('網頁 · web.telegram.org'))
assert.deepStrictEqual([by.get('本機模型').count, by.get('本機模型').memory], [2, 1010])
assert.deepStrictEqual([by.get('終端機').count, by.get('終端機').cpu], [2, 3])
assert.ok(!by.has('explorer'), '不是我們的程序不算')
assert.strictEqual(by.get('內建背景工作').memory, 30)
assert.strictEqual(result.total.count, 10)
assert.strictEqual(result.groups[0].label, 'SI')
console.log('test-app-resources: ok')

// 對不到 webContents 的 renderer、擴充功能頁 → 同一組
const bg = summarize({
  rootPid: 1, cores: 1, processes: [],
  metrics: [
    { pid: 2, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 1 } },
    { pid: 3, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 1 } }
  ],
  contents: [{ pid: 3, type: 'remote', url: 'chrome-extension://abc/offscreen.html' }]
})
assert.deepStrictEqual(bg.groups.map((g) => [g.label, g.count]), [['擴充功能與背景工作', 2]])
console.log('test-app-resources: background ok')

// pid 重用：比父程序還早開的不算我們的
const reuse = summarize({
  rootPid: 1, cores: 1, contents: [],
  metrics: [{ pid: 1, type: 'Browser', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 1 } }],
  processes: [
    { pid: 1, parentPid: 0, name: 'AxonDeck', startedAt: 100, cpu: 0, memory: 0 },
    { pid: 2, parentPid: 1, name: 'grep', startedAt: 50, cpu: 0, memory: 5 },
    { pid: 3, parentPid: 1, name: 'llama-server', startedAt: 150, cpu: 0, memory: 7 }
  ]
})
assert.deepStrictEqual(reuse.groups.map((g) => g.label).sort(), ['主程序', '本機模型'])
console.log('test-app-resources: pid reuse ok')
