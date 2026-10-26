'use strict'
// 生成後整理：裁頭尾靜音、音量一致、淡入、偵測講完又亂念
const assert = require('node:assert/strict')
const { polish, hasRunaway } = require('../src/main/breeze-tts/audio-clean')
const R = 24000
const pcm = (parts) => { const b = Buffer.alloc(parts.reduce((n, [s]) => n + s * R, 0) * 2); let o = 0
  for (const [sec, amp] of parts) { for (let i = 0; i < sec * R; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 10)), (o + i) * 2); o += sec * R } return b }
const speech = pcm([[0.5, 0], [1, 2000], [0.8, 0]])
const out = polish(speech)
assert(out.length / 2 / R < 1.25 && out.length / 2 / R > 1.1, 'edges trimmed')
assert.equal(out.readInt16LE(0), 0, 'fade in')
let sum = 0; for (let i = 0; i < out.length; i += 2) sum += out.readInt16LE(i) ** 2
const db = 20 * Math.log10(Math.sqrt(sum / (out.length / 2)) / 32768)
assert(db > -22 && db < -19, 'normalized ' + db)
assert.equal(polish(pcm([[1, 0]])).length, R * 2, 'silence untouched')
assert.equal(hasRunaway(speech), false)
assert.equal(hasRunaway(pcm([[1, 2000], [2.5, 0], [0.5, 2000]])), true)
assert.equal(hasRunaway(pcm([[1, 2000], [1, 0], [0.5, 2000]])), false)
console.log('PASS Breeze 音訊整理：裁靜音、音量一致、淡入、亂念偵測')

// 參考音：去直流、剪頭尾（留 100ms）、峰值壓到 0.95、不放大小聲錄音
const { cleanReference } = require('../src/main/breeze-tts/audio-clean')
const offset = Buffer.alloc(R * 2 * 3)
for (let i = 0; i < R * 3; i++) offset.writeInt16LE(Math.round(1000 + (i >= R && i < 2 * R ? 31700 * Math.sin(i / 10) : 0)), i * 2)
const ref = cleanReference(offset)
const len = ref.length / 2 / R
assert(len > 1.15 && len < 1.25, 'reference edges trimmed ' + len)
let mean = 0, top = 0
for (let i = 0; i < ref.length; i += 2) { const v = ref.readInt16LE(i); mean += v; top = Math.max(top, Math.abs(v)) }
assert(Math.abs(mean / (ref.length / 2)) < 50, 'dc removed')
assert(top <= 32768 * 0.95 + 1, 'peak capped')
const quiet = cleanReference(pcm([[1, 500]]))
let quietTop = 0; for (let i = 0; i < quiet.length; i += 2) quietTop = Math.max(quietTop, Math.abs(quiet.readInt16LE(i)))
assert(quietTop <= 501, 'quiet reference not boosted')
console.log('PASS Breeze 參考音整理：去直流、剪頭尾、壓峰值')
