'use strict'

const assert = require('node:assert/strict')
const net = require('node:net')
const { createSensorBridge } = require('../src/main/sysmon/sensors')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeTask(onConnect) {
  const clients = []
  return {
    clients,
    run(pipe) {
      return new Promise((resolve) => {
        const client = net.connect(pipe, () => {
          clients.push(client)
          if (onConnect) onConnect(client)
          resolve(true)
        })
        client.on('error', () => {})
      })
    }
  }
}

/** 真管道、假 helper；不提權、不碰硬體。 */
async function main() {
  {
    let client
    const bridge = createSensorBridge({ resolveExe: () => __filename, task: {
      run: (pipe) => new Promise((resolve) => {
        client = net.connect(pipe, () => resolve(true))
        client.on('error', () => {})
      })
    } })
    try {
      const first = bridge.enable()
      const second = bridge.enable()
      assert.equal(first, second, '同時啟動必須等待同一次連線')
      await sleep(80)
      assert.equal(bridge.status().state, 'starting', '只有連線、還沒讀數不能說已啟動')
      client.write('{"h":[],"c":[]}\n')
      assert.equal((await first).state, 'on')
      assert.equal(bridge.status().available, true)
      client.on('data', () => client.write('{"reset":1}\n'))
      await bridge.stop()
      assert.equal(bridge.status().state, 'off')
      console.log('PASS 共用啟動、首筆讀數、停止交還')
    } finally {
      client?.destroy()
      await bridge.stop()
    }
  }

  {
    const task = fakeTask((client) => { client.write('{"h":[],"c":[]}\n') })
    const bridge = createSensorBridge({
      resolveExe: () => __filename,
      reconnectDelayMs: 25,
      task,
      onLost: () => { bridge.enable({ elevate: false }).catch(() => undefined) }
    })
    try {
      await bridge.enable({ elevate: false })
      assert.equal(bridge.status().state, 'on')
      for (let i = 0; i < 6; i += 1) {
        const current = task.clients.at(-1)
        assert.ok(current, `第 ${i + 1} 次有連線`)
        current.destroy()
        const before = task.clients.length
        const deadline = Date.now() + 1500
        while (task.clients.length === before && Date.now() < deadline) await sleep(20)
        assert.ok(task.clients.length > before, `斷第 ${i + 1} 次仍會重拉（目前 ${task.clients.length}）`)
      }
      assert.equal(bridge.status().state, 'on')
      console.log('PASS 斷線超過 5 次仍會重拉')
    } finally {
      for (const c of task.clients) try { c.destroy() } catch { /* 已斷 */ }
      await bridge.stop()
    }
  }

  {
    const task = fakeTask((client) => { client.write('{"h":[],"c":[]}\n') })
    const bridge = createSensorBridge({
      resolveExe: () => __filename,
      staleMs: 80,
      healthMs: 20,
      reconnectDelayMs: 25,
      task,
      onLost: () => { bridge.enable({ elevate: false }).catch(() => undefined) }
    })
    try {
      await bridge.enable({ elevate: false })
      assert.equal(bridge.status().state, 'on')
      const first = task.clients.length
      const deadline = Date.now() + 1500
      while (task.clients.length === first && Date.now() < deadline) await sleep(20)
      assert.ok(task.clients.length > first, `卡住沒回報也要重拉（${task.clients.length}）`)
      console.log('PASS 卡住沒回報會重拉')
    } finally {
      for (const c of task.clients) try { c.destroy() } catch { /* 已斷 */ }
      await bridge.stop()
    }
  }

  {
    // 重拉時排程工作偶爾觸發失敗（schtasks 逾時）：不能停在「關」，要繼續重試
    const inner = fakeTask((client) => { client.write('{"h":[],"c":[]}\n') })
    let failNext = 0
    const task = { clients: inner.clients, run: (pipe) => (failNext-- > 0 ? Promise.resolve(false) : inner.run(pipe)) }
    const bridge = createSensorBridge({
      resolveExe: () => __filename,
      reconnectDelayMs: 25,
      task,
      onLost: () => { bridge.enable({ elevate: false }).catch(() => undefined) }
    })
    try {
      await bridge.enable({ elevate: false })
      assert.equal(bridge.status().state, 'on')
      failNext = 2
      const before = task.clients.length
      task.clients.at(-1).destroy()
      const deadline = Date.now() + 2000
      while ((bridge.status().state !== 'on' || task.clients.length === before) && Date.now() < deadline) await sleep(20)
      assert.equal(bridge.status().state, 'on', `排程工作失敗後仍要重試到接回（${bridge.status().state}）`)
      console.log('PASS 重拉時排程工作失敗會繼續重試')
    } finally {
      for (const c of task.clients) try { c.destroy() } catch { /* 已斷 */ }
      await bridge.stop()
    }
  }

  {
    // 跑過一陣子後重拉遇到一次驅動錯誤（上一顆還沒放開）：不是真的被系統擋，要繼續重試
    let driverNext = 0
    const task = fakeTask((client) => {
      if (driverNext-- > 0) { client.end('{"error":"driver"}\n'); return }
      client.write('{"h":[],"c":[]}\n')
    })
    const bridge = createSensorBridge({
      resolveExe: () => __filename,
      reconnectDelayMs: 25,
      task,
      onLost: () => { bridge.enable({ elevate: false }).catch(() => undefined) }
    })
    try {
      await bridge.enable({ elevate: false })
      driverNext = 1
      task.clients.at(-1).destroy()
      const deadline = Date.now() + 2000
      while ((bridge.status().state !== 'on' || task.clients.length < 3) && Date.now() < deadline) await sleep(20)
      assert.equal(bridge.status().state, 'on', `重拉遇到一次驅動錯誤仍要接回（${bridge.status().state}）`)
      console.log('PASS 重拉時的一次性驅動錯誤會繼續重試')
    } finally {
      for (const c of task.clients) try { c.destroy() } catch { /* 已斷 */ }
      await bridge.stop()
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
