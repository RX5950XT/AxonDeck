'use strict'

/**
 * 生成後的音訊整理（參考 voicebox 的 trim_tts_output／normalize_audio／has_tts_runaway）。
 * 輸入輸出都是 24kHz 單聲道 s16le PCM Buffer。
 */

const RATE = 24000
const FRAME = RATE / 50 // 20ms 一格算音量
const SILENT = 32768 * 10 ** (-40 / 20) // -40 dBFS 以下算安靜
const TARGET_RMS = 32768 * 10 ** (-20 / 20)
const PEAK = 32768 * 0.85
const FADE = RATE / 100 // 10ms 淡入淡出，接縫不會「啪」一聲
const KEEP = 5 // 頭尾各留 100ms 靜音，字尾氣音不被切掉

function samples(pcm) {
  const out = new Float32Array(pcm.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2)
  return out
}

function frameRms(audio) {
  const count = Math.floor(audio.length / FRAME)
  const rms = new Float32Array(count)
  for (let f = 0; f < count; f++) {
    let sum = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += audio[i] * audio[i]
    rms[f] = Math.sqrt(sum / FRAME)
  }
  return rms
}

function loudFrames(audio) { return Array.from(frameRms(audio), (rms) => rms >= SILENT) }

function toPcm(audio) {
  const out = Buffer.alloc(audio.length * 2)
  for (let i = 0; i < audio.length; i++) out.writeInt16LE(Math.round(Math.max(-32768, Math.min(32767, audio[i]))), i * 2)
  return out
}

/** 講完話後安靜超過 2 秒又冒出聲音：模型沒停在句尾、開始亂念（漏 EOS）。 */
function hasRunaway(pcm) {
  let spoke = false, quiet = 0
  for (const loud of loudFrames(samples(pcm))) {
    if (loud) { if (spoke && quiet >= 100) return true; spoke = true; quiet = 0 } else if (spoke) quiet++
  }
  return false
}

/** 去掉頭尾多餘靜音、各句音量拉到一致（-20 dBFS RMS，峰值不超過 0.85）、頭尾淡入淡出。 */
function polish(pcm) {
  const audio = samples(pcm)
  const loud = loudFrames(audio)
  const first = loud.indexOf(true)
  if (first < 0) return pcm
  const last = loud.lastIndexOf(true)
  const start = Math.max(0, first - KEEP) * FRAME
  const end = Math.min(audio.length, (last + 1 + KEEP) * FRAME)
  const cut = audio.subarray(start, end)
  let sum = 0, peak = 0
  for (const value of cut) { sum += value * value; peak = Math.max(peak, Math.abs(value)) }
  const gain = Math.min(TARGET_RMS / Math.sqrt(sum / cut.length), PEAK / peak)
  const fade = Math.min(FADE, cut.length >> 1)
  return toPcm(cut.map((value, i) => value * gain * Math.min(1, i / fade, (cut.length - 1 - i) / fade)))
}

/**
 * 克隆用的參考錄音先整理（參考 voicebox 的 preprocess_reference_audio）：去直流偏移、
 * 剪掉比最大音量低 40 dB 的頭尾、頭尾補回最多 100ms 靜音、峰值超過 0.95 就壓下來。不放大、不修破音。
 */
function cleanReference(pcm) {
  const audio = samples(pcm)
  if (!audio.length) return pcm
  const mean = audio.reduce((sum, value) => sum + value, 0) / audio.length
  for (let i = 0; i < audio.length; i++) audio[i] -= mean
  const rms = frameRms(audio)
  const floor = rms.reduce((max, value) => Math.max(max, value), 0) * 10 ** (-40 / 20)
  const first = rms.findIndex((value) => value > floor)
  if (first < 0) return toPcm(audio)
  const last = rms.findLastIndex((value) => value > floor)
  const pad = FRAME * 5
  const start = Math.max(0, first * FRAME - pad)
  const end = Math.min(audio.length, (last + 1) * FRAME + pad)
  const cut = audio.subarray(start, end)
  let peak = 0
  for (const value of cut) peak = Math.max(peak, Math.abs(value))
  const gain = peak > 32768 * 0.95 ? 32768 * 0.95 / peak : 1
  return toPcm(cut.map((value) => value * gain))
}

module.exports = { polish, hasRunaway, cleanReference }
