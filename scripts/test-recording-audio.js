const assert = require('assert/strict')
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const code = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/recording-audio.js'), 'utf8')

function fixture({ micFails = false, noAudio = false, resumeFails = false } = {}) {
  const calls = [], contexts = []
  const track = (kind) => ({ kind, stopped: false, stop() { this.stopped = true } })
  class Stream {
    constructor(tracks) { this.tracks = tracks }
    getTracks() { return this.tracks }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio') }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video') }
  }
  const mic = new Stream([track('audio')])
  const display = new Stream([...(noAudio ? [] : [track('audio')]), track('video')])
  class Context {
    constructor() { contexts.push(this); this.gains = []; this.sources = []; this.state = 'suspended' }
    createMediaStreamDestination() { return this.destination = { stream: new Stream([track('audio')]) } }
    createGain() {
      const node = { gain: {}, connect: (dest) => { node.destination = dest; return dest } }
      this.gains.push(node); return node
    }
    createMediaStreamSource(stream) {
      const node = { stream, connect: (gain) => { node.gain = gain; return gain } }
      this.sources.push(node); return node
    }
    async resume() { if (resumeFails) throw new Error('resume failed'); this.state = 'running' }
    async close() { this.state = 'closed' }
  }
  const context = {
    MediaStream: Stream, AudioContext: Context,
    navigator: { mediaDevices: {
      getDisplayMedia: async (opts) => { calls.push(['system', opts]); return display },
      getUserMedia: async (opts) => { calls.push(['mic', opts]); if (micFails) throw new Error('mic denied'); return mic }
    } }
  }
  vm.runInNewContext(code.replace('export async function', 'async function'), context)
  return { open: context.openRecordingAudio, calls, contexts, mic, display }
}

async function main() {
  for (const source of ['mic', 'system', 'both']) {
    const f = fixture(), capture = await f.open(source)
    assert.equal(capture.stream.getAudioTracks().length, 1)
    assert.equal(capture.stream.getVideoTracks().length, 0)
    assert.deepEqual(f.calls.map((c) => c[0]), source === 'both' ? ['system', 'mic'] : [source])
    if (source !== 'mic') assert.equal(f.display.getVideoTracks()[0].stopped, true)
    if (source === 'both') {
      const ctx = f.contexts[0]
      assert.equal(ctx.state, 'running')
      assert.equal(ctx.sources.length, 2)
      assert.ok(ctx.gains.every((g) => g.gain.value === 0.5 && g.destination === ctx.destination))
    }
    await capture.close()
    assert.ok(capture.tracks.every((t) => t.stopped))
    if (source === 'both') assert.equal(f.contexts[0].state, 'closed')
    console.log(`PASS ${source}: 正確音軌、混音與釋放`)
  }
  const micDenied = fixture({ micFails: true })
  await assert.rejects(micDenied.open('both'), /mic denied/)
  assert.ok(micDenied.display.getTracks().every((t) => t.stopped))
  console.log('PASS 混音麥克風拒絕時釋放系統擷取')
  const noAudio = fixture({ noAudio: true })
  await assert.rejects(noAudio.open('system'), /無法取得系統音訊/)
  assert.ok(noAudio.display.getTracks().every((t) => t.stopped))
  console.log('PASS 系統沒有音訊時釋放畫面擷取')
  const suspended = fixture({ resumeFails: true })
  await assert.rejects(suspended.open('both'), /resume failed/)
  assert.equal(suspended.contexts[0].state, 'closed')
  assert.ok([...suspended.mic.getTracks(), ...suspended.display.getTracks(), ...suspended.contexts[0].destination.stream.getTracks()].every((t) => t.stopped))
  console.log('PASS 混音啟動失敗時釋放所有軌道與 context')
  const invalid = fixture()
  await assert.rejects(invalid.open('unknown'), /無效/)
  assert.equal(invalid.calls.length, 0)
  console.log('PASS 無效音源不開裝置')
  const captions = fixture()
  const constraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  const capture = await captions.open('both', constraints)
  assert.equal(captions.calls[1][1].audio, constraints)
  await capture.close()
  console.log('PASS 字幕混音保留麥克風降噪條件')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
