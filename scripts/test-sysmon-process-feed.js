'use strict'

const assert = require('node:assert/strict')
const { createProcessIcons } = require('../src/main/sysmon/process-icons')
const { readProcessNetwork, processNetworkRate } = require('../src/main/sysmon/process-network')
const net = require('node:net')
const { createSensorBridge } = require('../src/main/sysmon/sensors')
const sample = { available: true, from: 1000, t: 2000, pids: { 12: 400 } }
assert.equal(readProcessNetwork({ ...sample, available: false }, 2000), null)
assert.equal(readProcessNetwork(sample, 9000), null)
assert.equal(readProcessNetwork({ ...sample, pids: { 12: null } }, 2000), null)
assert.equal(processNetworkRate(readProcessNetwork(sample, 2000), { pid: 12, startedAt: 500 }), 400)
assert.equal(processNetworkRate(readProcessNetwork(sample, 2000), { pid: 13, startedAt: 500 }), 0)
assert.equal(processNetworkRate(readProcessNetwork(sample, 2000), { pid: 12, startedAt: 1500 }), null)
assert.equal(processNetworkRate(null, { pid: 12, startedAt: 500 }), null)

async function main() {
  let calls = 0
  let active = 0
  let peak = 0
  const releases = []
  const cache = createProcessIcons({ concurrency: 2, getFileIcon: async () => {
    calls++; active++; peak = Math.max(peak, active)
    await new Promise((resolve) => releases.push(resolve))
    active--
    return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' }
  } })
  assert.equal(cache.read('C:\\one.exe'), '')
  cache.read('c:\\ONE.exe')
  cache.read('\\\\?\\C:\\one.exe')
  cache.read('C:\\two.exe')
  cache.read('C:\\three.exe')
  cache.read('\\\\server\\share\\a.exe')
  await new Promise(setImmediate)
  assert.equal(calls, 2)
  assert.equal(peak, 2)
  releases.splice(0).forEach((resolve) => resolve())
  await new Promise(setImmediate)
  assert.equal(calls, 3)
  releases.splice(0).forEach((resolve) => resolve())
  await new Promise(setImmediate)
  assert.equal(cache.read('C:\\one.exe'), 'data:image/png;base64,AA==')
  assert.equal(calls, 3)
  let failedCalls = 0
  const bad = createProcessIcons({ getFileIcon: async () => { failedCalls++; throw new Error('unreadable') } })
  bad.read('C:\\denied.exe')
  await new Promise(setImmediate)
  assert.equal(bad.read('C:\\denied.exe'), '')
  assert.equal(failedCalls, 1)
  let client
  const now = Date.now()
  const bridge = createSensorBridge({ resolveExe: () => __filename, task: {
    run: (pipe) => new Promise((resolve) => {
      client = net.connect(pipe, () => {
        client.write(JSON.stringify({ h: [], network: { available: true, from: now - 1000, t: now, pids: { 12: 400 } } }) + '\n')
        resolve(true)
      })
      client.on('data', () => client.write('{"reset":1}\n'))
      client.on('error', () => {})
    })
  } })
  try {
    await bridge.enable({ elevate: false })
    assert.equal(bridge.read().processNetwork.pids[12], 400, '真管道讀入 sidecar 網路欄')
    client.write('{"h":[],"network":{"available":false,"code":5}}\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(bridge.read().processNetwork, null, '收集失敗不能沿用上輪的數字')
  } finally {
    await bridge.stop()
    client?.destroy()
  }
  console.log('PASS 圖示非同步、併發上限、去重與失敗快取；網路時效／PID 重用／未知值')
}
main().catch((err) => { console.error(err); process.exitCode = 1 })
