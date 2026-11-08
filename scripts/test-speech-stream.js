'use strict'
// 邊生成邊播放的排程：用假的 AudioContext 控制時間，檢查緩衝、跟不上時加長緩衝、句間停頓、重做倒回、生成完不切掉
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const RATE = 24000
class FakeContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.nodes = []; FakeContext.last = this }
  async resume() { this.state = 'running' }
  async suspend() { this.state = 'suspended' }
  async close() {}
  get destination() { return {} }
  createBuffer(_channels, length, rate) {
    const data = new Float32Array(length)
    return { duration: length / rate, getChannelData: () => data }
  }
  createBufferSource() {
    const node = { connect() {}, start: (at) => { node.at = at; this.nodes.push(node) }, stop() { node.stopped = true } }
    return node
  }
  /** 時間往前走，播完的節點觸發 onended */
  advance(seconds) {
    this.currentTime += seconds
    for (const node of this.nodes) {
      if (!node.ended && !node.stopped && node.at + node.buffer.duration <= this.currentTime) { node.ended = true; node.onended?.() }
    }
  }
}

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/speech-stream.js'), 'utf8').replace(/^export /gm, '')
const context = { AudioContext: FakeContext, atob, Float32Array, Uint8Array, DataView, Math, Infinity }
const { createStream } = vm.runInNewContext(`${source}\n;({ createStream })`, context)
const pcm = (seconds, value = 1000) => {
  const buffer = Buffer.alloc(Math.round(seconds * RATE) * 2)
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i)
  return buffer.toString('base64')
}

async function setup() {
  const states = []
  const stream = createStream({ onChange: (on) => states.push(on) })
  await stream.begin()
  return { stream, states }
}

;(async () => {
  // 1. 先攢夠一小段才開播，之後接續不留縫
  {
    const { stream, states } = await setup()
    const ctx = FakeContext.last
    stream.sentence()
    stream.push(pcm(0.1), RATE)
    assert.equal(ctx.nodes.length, 0, '0.1 秒還不夠，先不播')
    stream.push(pcm(0.3), RATE)
    assert.equal(ctx.nodes.length, 2, '攢到 0.35 秒以上一起排')
    assert.ok(Math.abs(ctx.nodes[1].at - (ctx.nodes[0].at + 0.1)) < 1e-9, '兩段頭尾相接')
    ctx.advance(0.1)
    stream.push(pcm(0.2), RATE)
    assert.equal(ctx.nodes.length, 3, '還在播就直接接上')
    assert.ok(Math.abs(ctx.nodes[2].at - (ctx.nodes[1].at + 0.3)) < 1e-9)

    // 2. 同一句播空了：下次多攢一點（0.35 → 0.56）
    ctx.advance(2)
    stream.push(pcm(0.4), RATE)
    assert.equal(ctx.nodes.length, 3, '生成跟不上，0.4 秒不夠新的緩衝')
    stream.push(pcm(0.2), RATE)
    assert.equal(ctx.nodes.length, 5, '攢到 0.56 秒以上再播')

    // 3. 句尾補停頓，生成結束不切掉已排的聲音
    stream.endSentence(0.5)
    const gap = ctx.nodes.at(-1)
    assert.ok(Math.abs(gap.buffer.duration - 0.5) < 1e-6, '句間 0.5 秒靜音')
    stream.end()
    assert.ok(ctx.nodes.every((node) => !node.stopped), '生成完不停掉排好的聲音')
    assert.equal(states.at(-1), true, '還在播就維持串流狀態')
    ctx.advance(5)
    assert.equal(states.at(-1), false, '全部播完才結束')
  }
  // 4. 換句之間的等待不加長緩衝
  {
    const { stream } = await setup()
    const ctx = FakeContext.last
    stream.sentence(); stream.push(pcm(0.5), RATE); stream.endSentence(0)
    ctx.advance(3)
    stream.sentence(); stream.push(pcm(0.36), RATE)
    assert.equal(ctx.nodes.length, 2, '新的一句照原本 0.35 秒開播')
  }
  // 5. 重做這句：倒回這句開頭，前一句不受影響
  {
    const { stream } = await setup()
    const ctx = FakeContext.last
    stream.sentence(); stream.push(pcm(1), RATE); stream.endSentence(0)
    stream.sentence(); stream.push(pcm(1), RATE)
    const bad = ctx.nodes[1]
    stream.rewind()
    assert.ok(bad.stopped && !ctx.nodes[0].stopped, '只丟掉重做那句')
    stream.push(pcm(0.5), RATE)
    assert.ok(Math.abs(ctx.nodes[2].at - bad.at) < 1e-9, '重做的聲音排在原本那句的位置')
  }
  // 6. 停止：全部停掉並清空；暫停／繼續
  {
    const { stream, states } = await setup()
    const ctx = FakeContext.last
    stream.sentence(); stream.push(pcm(1), RATE)
    await stream.toggle()
    assert.equal(stream.paused, true)
    await stream.toggle()
    assert.equal(stream.paused, false)
    stream.stop()
    assert.ok(ctx.nodes.every((node) => node.stopped))
    assert.equal(states.at(-1), false)
    stream.push(pcm(1), RATE)
    assert.equal(ctx.nodes.length, 1, '停止後收到的片段不再播')
  }
  console.log('test-speech-stream: OK')
})().catch((error) => { console.error(error); process.exit(1) })
