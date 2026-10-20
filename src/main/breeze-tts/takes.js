'use strict'

/**
 * 語音版本（take）：每次生成都留一份 WAV＋分句範圍，可以切換比較、匯出，也能只重做其中一句。
 * 存在 userData/breeze-tts/takes：index.json（新到舊）＋ <id>.wav（24kHz 單聲道 16-bit）。
 */

const path = require('path')
const { randomUUID } = require('crypto')
const fs = require('../raw-fs').promises
const { fail, text, wavHeader } = require('./protocol')

const RATE = 24000
const MAX_TAKES = 50
const MAX_TAKE_SECONDS = 2 * 60 * 60
const MAX_GAP_SECONDS = 10
const ID = /^[0-9a-f-]{36}$/

function seconds(value, max, label) {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw fail('INVALID_INPUT', `${label}超出範圍`)
  return value
}

/**
 * 把各句 PCM 排成一條音軌。placement=cue 依字幕時間放（前一句還沒講完就往後推），
 * 其他依序接、每句後面留 gap 秒靜音。回傳整段 PCM 與每句在裡面的位置。
 */
function compose(parts, placement) {
  const chunks = []
  const segments = []
  let cursor = 0
  for (const part of parts) {
    const length = part.pcm.length / 2
    const start = placement === 'cue' ? Math.max(Math.round(part.at * RATE), cursor) : cursor
    if (start > cursor) chunks.push(Buffer.alloc((start - cursor) * 2))
    chunks.push(part.pcm)
    segments.push({ text: part.text, speaker: part.speaker, at: part.at, gap: part.gap, offset: start, length })
    cursor = start + length
    if (placement !== 'cue' && part.gap) {
      const gap = Math.round(part.gap * RATE)
      chunks.push(Buffer.alloc(gap * 2))
      cursor += gap
    }
    if (cursor > MAX_TAKE_SECONDS * RATE) throw fail('AUDIO_TOO_LARGE', '合併後超過 2 小時，請分批生成')
  }
  return { pcm: Buffer.concat(chunks), segments }
}

function createTakes({ root }) {
  const dir = () => path.join(root(), 'breeze-tts', 'takes')
  const file = (id) => path.join(dir(), `${id}.wav`)
  let queue = Promise.resolve()
  // index.json 的讀改寫要排隊，兩個寫入同時進來不能互蓋
  const serial = (task) => { const run = queue.then(task, task); queue = run.catch(() => {}); return run }

  async function readIndex() {
    try {
      const list = JSON.parse(await fs.readFile(path.join(dir(), 'index.json'), 'utf8'))
      return Array.isArray(list) ? list.filter((take) => take && ID.test(take.id) && Array.isArray(take.segments)) : []
    } catch (error) {
      if (error.code === 'ENOENT') return []
      console.error('[breeze-tts] 版本清單讀取失敗:', error.message)
      // 檔案被鎖（防毒掃描）時回空清單，下一次存檔就會把所有版本從清單蓋掉；只有壞檔才另存備份重來
      if (!(error instanceof SyntaxError)) throw error
      await fs.rename(path.join(dir(), 'index.json'), path.join(dir(), 'index.json.bad')).catch(() => {})
      return []
    }
  }

  async function writeIndex(list) {
    await fs.mkdir(dir(), { recursive: true })
    const target = path.join(dir(), 'index.json')
    await fs.writeFile(`${target}.tmp`, JSON.stringify(list))
    await fs.rename(`${target}.tmp`, target)
  }

  async function readTake(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('INVALID_INPUT', '版本代碼不符')
    const take = (await readIndex()).find((item) => item.id === id)
    if (!take) throw fail('TAKE_MISSING', '找不到這個版本，可能已被刪除')
    let bytes
    try { bytes = await fs.readFile(file(id)) } catch { throw fail('TAKE_MISSING', '這個版本的音檔不見了') }
    return { take, bytes }
  }

  /** 某一句在版本裡的 PCM（重做其他句時沿用）。 */
  async function segmentPcm(id, index) {
    const { take, bytes } = await readTake(id)
    const segment = take.segments[index]
    if (!Number.isInteger(index) || !segment) throw fail('INVALID_INPUT', '找不到這一句')
    const start = 44 + segment.offset * 2
    return bytes.subarray(start, start + segment.length * 2)
  }

  /**
   * parts 已由呼叫端換成 PCM：[{ pcm, text, speaker, at, gap }]。
   * 寫入新版本、超過上限刪掉最舊的。
   */
  function save({ parts, placement, title, mode, voice }) {
    if (!Array.isArray(parts) || !parts.length || parts.length > 2000) throw fail('INVALID_INPUT', '沒有可以合併的語音')
    const clean = parts.map((part) => ({ pcm: part.pcm, text: text(part.text ?? '', '句子', 10000),
      speaker: text(part.speaker ?? '', '角色', 120), at: seconds(part.at, MAX_TAKE_SECONDS, '字幕時間'),
      gap: seconds(part.gap, MAX_GAP_SECONDS, '句間停頓') }))
    const { pcm, segments } = compose(clean, placement === 'cue' ? 'cue' : 'sequence')
    if (!pcm.length) throw fail('INVALID_AUDIO', '生成音訊不完整')
    const take = { id: randomUUID(), createdAt: Date.now(), duration: pcm.length / 2 / RATE,
      title: text(title ?? '', '標題', 200).slice(0, 80), mode: text(mode ?? '', '模式', 32),
      voice: text(voice ?? '', '聲音', 120), placement: placement === 'cue' ? 'cue' : 'sequence', segments }
    return serial(async () => {
      await fs.mkdir(dir(), { recursive: true })
      await fs.writeFile(file(take.id), Buffer.concat([wavHeader(pcm.length, RATE), pcm]))
      const list = [take, ...(await readIndex())]
      for (const old of list.splice(MAX_TAKES)) await fs.unlink(file(old.id)).catch(() => {})
      await writeIndex(list)
      return take
    })
  }

  function remove(id) {
    return serial(async () => {
      const list = await readIndex()
      if (!list.some((take) => take.id === id)) throw fail('TAKE_MISSING', '找不到這個版本，可能已被刪除')
      await writeIndex(list.filter((take) => take.id !== id))
      await fs.unlink(file(id)).catch((error) => { if (error.code !== 'ENOENT') console.error('[breeze-tts] 刪除版本音檔失敗:', error.message) })
      return { deleted: id }
    })
  }

  return { list: readIndex, read: readTake, segmentPcm, save, remove }
}

module.exports = { createTakes, compose, RATE }
